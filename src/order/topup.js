// src/order/topup.js — Smart cart top-up suggestion based on order history
import { query } from '../db/pool.js';
import { logError } from '../middleware/logger.js';

const FREE_DELIVERY_THRESHOLD = 199;
const CYCLE_THRESHOLD = 0.8; // Suggest if >80% through avg reorder cycle

/**
 * Suggest top-up items to bring cart above free delivery threshold.
 * Scores items by how overdue they are in the reorder cycle.
 *
 * Returns: { gap, suggestions[], totalAddition } or null if nothing qualifies.
 */
export async function suggestTopUp(kitchenId, cartTotal, freeDeliveryMin = FREE_DELIVERY_THRESHOLD) {
  const gap = freeDeliveryMin - cartTotal;
  if (gap <= 0) return null; // Already at free delivery

  try {
    // Find items ordered ≥ 2 times, compute avg cycle and avg price
    const result = await query(`
      WITH item_stats AS (
        SELECT
          item_elem->>'product_name' AS item_name,
          AVG((item_elem->>'price')::numeric) AS avg_price,
          COUNT(*) AS order_count,
          MAX(oh.created_at) AS last_ordered,
          AVG(
            EXTRACT(EPOCH FROM (oh.created_at - LAG(oh.created_at) OVER (
              PARTITION BY item_elem->>'product_name'
              ORDER BY oh.created_at
            ))) / 86400
          ) AS avg_cycle_days
        FROM order_history oh
        CROSS JOIN LATERAL jsonb_array_elements(oh.items) AS item_elem
        WHERE oh.kitchen_id = $1
          AND oh.created_at >= NOW() - INTERVAL '90 days'
        GROUP BY item_elem->>'product_name'
        HAVING COUNT(*) >= 2
      )
      SELECT
        item_name,
        avg_price,
        order_count,
        last_ordered,
        avg_cycle_days,
        EXTRACT(EPOCH FROM (NOW() - last_ordered)) / 86400 AS days_since_last,
        (EXTRACT(EPOCH FROM (NOW() - last_ordered)) / 86400) / NULLIF(avg_cycle_days, 0) AS cycle_score
      FROM item_stats
      WHERE avg_cycle_days IS NOT NULL
        AND (EXTRACT(EPOCH FROM (NOW() - last_ordered)) / 86400) / NULLIF(avg_cycle_days, 0) > $2
        AND avg_price <= $3
      ORDER BY cycle_score DESC
    `, [kitchenId, CYCLE_THRESHOLD, gap + 50]);

    if (result.rows.length === 0) return null;

    // Greedily add items until gap is covered
    const suggestions = [];
    let totalAddition = 0;

    for (const row of result.rows) {
      if (totalAddition >= gap) break;
      suggestions.push({
        item_name: row.item_name,
        avg_price: Math.round(row.avg_price),
        cycle_score: Math.round(row.cycle_score * 100) / 100,
        days_since_last: Math.floor(row.days_since_last),
        avg_cycle_days: Math.floor(row.avg_cycle_days),
      });
      totalAddition += Math.round(row.avg_price);
    }

    if (suggestions.length === 0) return null;

    return { gap: Math.round(gap), suggestions, totalAddition: Math.round(totalAddition) };
  } catch (err) {
    logError('topup', 'suggestTopUp_error', err, { kitchenId });
    return null;
  }
}
