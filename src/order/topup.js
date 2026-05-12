import pool from '../db/pool.js';

export async function suggestTopUp(kitchenId, currentCartTotal, freeDeliveryMin = 199) {
  if (currentCartTotal >= freeDeliveryMin) return null;
  const gap = freeDeliveryMin - currentCartTotal;

  const res = await pool.query(`
    WITH item_orders AS (
      SELECT kitchen_id, i->>'product_name' AS item_name, o.created_at, (i->>'price')::numeric AS price
      FROM order_history o, jsonb_array_elements(o.items::jsonb) AS i
      WHERE kitchen_id = $1
    ),
    order_intervals AS (
      SELECT item_name, price, created_at,
             LAG(created_at) OVER(PARTITION BY item_name ORDER BY created_at) AS prev_order
      FROM item_orders
    ),
    cycle_stats AS (
      SELECT item_name,
             AVG(price) AS avg_price,
             MAX(created_at) AS last_ordered,
             COUNT(*) AS count_orders,
             AVG(EXTRACT(EPOCH FROM (created_at - prev_order))/86400) AS avg_cycle
      FROM order_intervals
      WHERE prev_order IS NOT NULL
      GROUP BY item_name
    )
    SELECT item_name, avg_price, last_ordered, count_orders, avg_cycle,
           EXTRACT(EPOCH FROM (NOW() - last_ordered))/86400 AS days_since_last
    FROM cycle_stats
    WHERE count_orders >= 2
  `, [kitchenId]);

  let suggestions = [];
  for (const row of res.rows) {
    if (!row.avg_cycle || row.avg_cycle <= 0) continue;
    const score = row.days_since_last / row.avg_cycle;
    if (score > 0.8 && row.avg_price <= gap + 50) {
      suggestions.push({
        name: row.item_name,
        brand: 'Assumed',
        avgPrice: row.avg_price,
        daysSince: Math.floor(row.days_since_last),
        score: score
      });
    }
  }

  suggestions.sort((a, b) => b.score - a.score);

  let totalAddition = 0;
  let finalSuggestions = [];
  for (const s of suggestions) {
    if (totalAddition < gap) {
      finalSuggestions.push(s);
      totalAddition += s.avgPrice;
    }
  }

  if (finalSuggestions.length === 0) return null;

  return { gap, suggestions: finalSuggestions, totalAddition };
}
