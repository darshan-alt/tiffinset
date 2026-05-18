// src/kitchen/scheduler.js — Cron jobs for leftover check-in and reorder nudge
import cron from 'node-cron';
import { query } from '../db/pool.js';
import { sendText } from '../transport/index.js';
import { logInfo, logError } from '../middleware/logger.js';

/**
 * Only run scheduler on PM2 instance 0 to prevent duplicate cron jobs
 * in cluster mode.
 */
export function setupScheduler() {
  const instanceId = process.env.NODE_APP_INSTANCE;
  if (instanceId !== undefined && instanceId !== '0') {
    logInfo('scheduler', 'skipped', { instanceId });
    return;
  }

  logInfo('scheduler', 'starting');

  // 8:00 AM IST — leftover check-in for cooks
  cron.schedule('0 8 * * *', leftoverCheckIn, { timezone: 'Asia/Kolkata' });

  // 9:00 AM IST — reorder nudge for owners
  cron.schedule('0 9 * * *', reorderNudge, { timezone: 'Asia/Kolkata' });

  logInfo('scheduler', 'crons_registered');
}

/**
 * 8 AM — Check perishable items ordered recently and nudge cooks.
 */
async function leftoverCheckIn() {
  logInfo('scheduler', 'leftover_check_start');
  try {
    // JOIN order_history items with shelf_life_rules using ILIKE on item name
    const result = await query(`
      SELECT
        oh.kitchen_id,
        oh.created_at AS ordered_at,
        item_elem->>'product_name' AS item_name,
        slr.check_after,
        slr.shelf_days,
        up.phone,
        up.language_code
      FROM order_history oh
      CROSS JOIN LATERAL jsonb_array_elements(oh.items) AS item_elem
      JOIN shelf_life_rules slr
        ON (item_elem->>'product_name') ILIKE slr.item_pattern
      JOIN user_profiles up
        ON up.kitchen_id = oh.kitchen_id AND up.role = 'cook'
      WHERE oh.created_at >= NOW() - INTERVAL '14 days'
        AND EXTRACT(EPOCH FROM (NOW() - oh.created_at)) / 86400 >= slr.check_after
        AND oh.status = 'placed'
    `);

    // Group by cook phone
    const byPhone = {};
    for (const row of result.rows) {
      if (!byPhone[row.phone]) byPhone[row.phone] = [];
      const daysAgo = Math.floor((Date.now() - new Date(row.ordered_at).getTime()) / 86400000);
      byPhone[row.phone].push({ item: row.item_name, daysAgo, shelfDays: row.shelf_days });
    }

    for (const [phone, items] of Object.entries(byPhone)) {
      const lines = items.map((i) => `- ${i.item} (ordered ${i.daysAgo} days ago, shelf life: ${i.shelfDays} days)`).join('\n');
      const msg = `Good morning! Yeh perishable items check karo:\n${lines}\n\nKya sab theek hai?`;
      await sendText(phone, msg);
    }

    logInfo('scheduler', 'leftover_check_done', { cooksNotified: Object.keys(byPhone).length });
  } catch (err) {
    logError('scheduler', 'leftover_check_error', err);
  }
}

/**
 * 9 AM — Reorder nudge for owners based on avg order cycle.
 */
async function reorderNudge() {
  logInfo('scheduler', 'reorder_nudge_start');
  try {
    const result = await query(`
      WITH item_orders AS (
        SELECT
          oh.kitchen_id,
          item_elem->>'product_name' AS item_name,
          AVG((item_elem->>'price')::numeric) AS avg_price,
          COUNT(*) AS order_count,
          MAX(oh.created_at) AS last_ordered,
          AVG(
            EXTRACT(EPOCH FROM (oh.created_at - LAG(oh.created_at) OVER (
              PARTITION BY oh.kitchen_id, item_elem->>'product_name'
              ORDER BY oh.created_at
            ))) / 86400
          ) AS avg_cycle_days
        FROM order_history oh
        CROSS JOIN LATERAL jsonb_array_elements(oh.items) AS item_elem
        WHERE oh.created_at >= NOW() - INTERVAL '90 days'
        GROUP BY oh.kitchen_id, item_elem->>'product_name'
        HAVING COUNT(*) >= 2
      )
      SELECT
        io.*,
        EXTRACT(EPOCH FROM (NOW() - io.last_ordered)) / 86400 AS days_since_last,
        up.phone,
        up.language_code
      FROM item_orders io
      JOIN user_profiles up
        ON up.kitchen_id = io.kitchen_id AND up.role = 'owner'
      WHERE io.avg_cycle_days IS NOT NULL
        AND EXTRACT(EPOCH FROM (NOW() - io.last_ordered)) / 86400 > 0.8 * io.avg_cycle_days
    `);

    const byPhone = {};
    for (const row of result.rows) {
      if (!byPhone[row.phone]) byPhone[row.phone] = [];
      byPhone[row.phone].push({
        item: row.item_name,
        daysSince: Math.floor(row.days_since_last),
        avgCycle: Math.floor(row.avg_cycle_days),
      });
    }

    for (const [phone, items] of Object.entries(byPhone)) {
      const lines = items.map((i) => `- ${i.item} (${i.daysSince} days ago, usually every ${i.avgCycle} days)`).join('\n');
      const msg = `Good morning! In items ko reorder karne ka time aa gaya:\n${lines}\n\nOrder karne ke liye mujhse kaho!`;
      await sendText(phone, msg);
    }

    logInfo('scheduler', 'reorder_nudge_done', { ownersNotified: Object.keys(byPhone).length });
  } catch (err) {
    logError('scheduler', 'reorder_nudge_error', err);
  }
}
