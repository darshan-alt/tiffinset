import cron from 'node-cron';
import pool from '../db/pool.js';
import { getKitchenMembers } from './routing.js';
import { sendText } from '../transport/index.js';
import { logError } from '../middleware/logger.js';

export function setupScheduler() {
  // 1. Leftover check-in
  cron.schedule('0 8 * * *', async () => {
    try {
      const query = `
        SELECT o.kitchen_id, i->>'product_name' AS item_name,
               EXTRACT(DAY FROM NOW() - o.created_at) AS days
        FROM order_history o, jsonb_array_elements(o.items::jsonb) AS i
        JOIN shelf_life_rules s ON (i->>'product_name') ILIKE '%' || s.item_pattern || '%'
        WHERE EXTRACT(DAY FROM NOW() - o.created_at) >= s.check_after
      `;
      const result = await pool.query(query);
      for (const row of result.rows) {
        const cooks = await getKitchenMembers(row.kitchen_id, 'cook');
        for (const cook of cooks) {
          await sendText(cook.phone, `${cook.display_name} ji, ${Math.floor(row.days)} din pehle ${row.item_name} order kiya tha. Abhi bacha hai ya khatam ho gaya?`);
        }
      }
    } catch (error) {
      logError({}, 'leftover_checkin_cron_error', error);
    }
  }, { timezone: 'Asia/Kolkata' });

  // 2. Reorder nudge
  cron.schedule('0 9 * * *', async () => {
    try {
      const query = `
        WITH item_orders AS (
          SELECT o.kitchen_id, i->>'product_name' AS item_name, o.created_at
          FROM order_history o, jsonb_array_elements(o.items::jsonb) AS i
        ),
        order_intervals AS (
          SELECT kitchen_id, item_name, created_at,
                 LAG(created_at) OVER(PARTITION BY kitchen_id, item_name ORDER BY created_at) AS prev_order
          FROM item_orders
        ),
        cycle_stats AS (
          SELECT kitchen_id, item_name,
                 AVG(EXTRACT(EPOCH FROM (created_at - prev_order))/86400) AS avg_cycle,
                 MAX(created_at) AS last_order
          FROM order_intervals
          WHERE prev_order IS NOT NULL
          GROUP BY kitchen_id, item_name
        )
        SELECT kitchen_id, item_name, avg_cycle,
               EXTRACT(EPOCH FROM (NOW() - last_order))/86400 AS days_since_last
        FROM cycle_stats
        WHERE EXTRACT(EPOCH FROM (NOW() - last_order))/86400 > 0.8 * avg_cycle
      `;
      const result = await pool.query(query);
      for (const row of result.rows) {
        const owners = await getKitchenMembers(row.kitchen_id, 'owner');
        for (const owner of owners) {
          await sendText(owner.phone, `${row.item_name} khatam hone wala hai (last order ${Math.floor(row.days_since_last)} din pehle). Order kar doon?`);
        }
      }
    } catch (error) {
      logError({}, 'reorder_nudge_cron_error', error);
    }
  }, { timezone: 'Asia/Kolkata' });
}
