// src/kitchen/routing.js — Cross-role event routing
import { query } from '../db/pool.js';
import { sendText } from '../transport/index.js';
import { logInfo, logError } from '../middleware/logger.js';

/**
 * Get all kitchen members, optionally filtered by role.
 * Returns array of user_profile rows.
 */
export async function getKitchenMembers(kitchenId, role = null) {
  const params = [kitchenId];
  let sql = 'SELECT phone, role, display_name, language_code FROM user_profiles WHERE kitchen_id = $1';
  if (role) {
    sql += ' AND role = $2';
    params.push(role);
  }
  const result = await query(sql, params);
  return result.rows;
}

/**
 * Route a kitchen event to appropriate members and log it.
 * type: menu_set | shortage_report | dish_suggested | order_confirmed | leftover_check | reorder_nudge
 */
export async function routeEvent({ type, kitchenId, sourcePhone, sourceRole, payload }) {
  try {
    let targets = [];
    let messages = [];

    switch (type) {
      case 'menu_set': {
        const cooks = await getKitchenMembers(kitchenId, 'cook');
        const contributors = await getKitchenMembers(kitchenId, 'contributor');
        const dishes = payload.dishes || [];
        const dishList = dishes.join(', ');

        for (const cook of cooks) {
          const msg = `Aaj ka menu: ${dishList}\n\nRecipes aur videos ke liye mujhse poocho!`;
          await sendText(cook.phone, msg);
          targets.push(cook.phone);
        }

        for (const c of contributors) {
          const msg = `Aaj ka menu set ho gaya: ${dishList}`;
          await sendText(c.phone, msg);
          targets.push(c.phone);
        }
        messages = [dishList];
        break;
      }

      case 'shortage_report': {
        const owners = await getKitchenMembers(kitchenId, 'owner');
        const item = payload.item || 'unknown item';
        const brands = payload.brands || [];

        let msg = `Cook ne shortage report ki: ${item}\n\n`;
        if (brands.length > 0) {
          msg += 'Available brands:\n';
          brands.forEach((b) => { msg += `- ${b.name} ${b.quantity}: ₹${b.price}\n`; });
        }
        msg += '\nKya aap order karna chahte ho?';

        for (const owner of owners) {
          await sendText(owner.phone, msg);
          targets.push(owner.phone);
        }
        break;
      }

      case 'dish_suggested': {
        const owners = await getKitchenMembers(kitchenId, 'owner');
        const dish = payload.dish || 'unknown dish';
        const suggesterName = payload.suggesterName || 'family member';

        const msg = `${suggesterName} ne suggest kiya: "${dish}"\n\nKya aap is dish ko aaj ke menu mein add karna chahte ho?`;
        for (const owner of owners) {
          await sendText(owner.phone, msg);
          targets.push(owner.phone);
        }
        break;
      }

      case 'order_confirmed': {
        const cooks = await getKitchenMembers(kitchenId, 'cook');
        const items = payload.items || [];
        const eta = payload.eta || '15-20 minutes';

        const itemList = items.map((i) => `- ${i.product_name} x${i.quantity}`).join('\n');
        const msg = `Order place ho gaya!\n\nItems:\n${itemList}\n\nDelivery ETA: ${eta}\nPayment: Cash on Delivery`;

        for (const cook of cooks) {
          await sendText(cook.phone, msg);
          targets.push(cook.phone);
        }
        break;
      }

      default:
        logInfo('routing', 'unknown_event_type', { type, kitchenId });
    }

    await logEvent(kitchenId, type, sourcePhone, sourceRole, targets, payload);
  } catch (err) {
    logError('routing', 'routeEvent_error', err, { type, kitchenId });
  }
}

/**
 * Insert a row into event_log.
 */
export async function logEvent(kitchenId, eventType, sourcePhone, sourceRole, targetPhones, payload) {
  try {
    await query(
      `INSERT INTO event_log (kitchen_id, event_type, source_phone, source_role, target_phones, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [kitchenId, eventType, sourcePhone, sourceRole, JSON.stringify(targetPhones), JSON.stringify(payload)]
    );
  } catch (err) {
    logError('routing', 'logEvent_error', err);
  }
}
