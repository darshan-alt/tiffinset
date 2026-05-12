import pool from '../db/pool.js';
import { sendText } from '../transport/index.js';
import { logError } from '../middleware/logger.js';

export async function getKitchenMembers(kitchenId, role = null) {
  let query = 'SELECT phone, role, display_name, language FROM user_profiles WHERE kitchen_id = $1';
  let params = [kitchenId];
  if (role) {
    query += ' AND role = $2';
    params.push(role);
  }
  const res = await pool.query(query, params);
  return res.rows;
}

export async function logEvent(kitchenId, eventType, sourcePhone, targetPhones, payload) {
  try {
    const sourceRes = await pool.query('SELECT role FROM user_profiles WHERE phone = $1', [sourcePhone]);
    const sourceRole = sourceRes.rows[0]?.role || 'unknown';
    
    await pool.query(
      'INSERT INTO event_log (kitchen_id, event_type, source_phone, source_role, target_phones, payload) VALUES ($1, $2, $3, $4, $5, $6)',
      [kitchenId, eventType, sourcePhone, sourceRole, JSON.stringify(targetPhones), JSON.stringify(payload)]
    );
  } catch (error) {
    logError({ kitchen_id: kitchenId }, 'event_log_error', error);
  }
}

export async function routeEvent(event) {
  const { type, kitchenId, sourcePhone, payload } = event;
  
  switch (type) {
    case 'menu_set': {
      const cooks = await getKitchenMembers(kitchenId, 'cook');
      const contributors = await getKitchenMembers(kitchenId, 'contributor');
      const targetPhones = [];
      
      for (const cook of cooks) {
        await sendText(cook.phone, `Aaj ki recipe: ${payload.recipe}\nVideo: ${payload.videoUrl}`);
        targetPhones.push(cook.phone);
      }
      for (const cont of contributors) {
        await sendText(cont.phone, `Menu summary: ${payload.summary}`);
        targetPhones.push(cont.phone);
      }
      await logEvent(kitchenId, type, sourcePhone, targetPhones, payload);
      break;
    }
    case 'shortage_report': {
      const owners = await getKitchenMembers(kitchenId, 'owner');
      const targetPhones = [];
      for (const owner of owners) {
        await sendText(owner.phone, `Shortage reported: ${payload.itemDetails}\nOptions: ${payload.brandOptions}`);
        targetPhones.push(owner.phone);
      }
      await logEvent(kitchenId, type, sourcePhone, targetPhones, payload);
      break;
    }
    case 'dish_suggested': {
      const owners = await getKitchenMembers(kitchenId, 'owner');
      const targetPhones = [];
      for (const owner of owners) {
        await sendText(owner.phone, `${payload.contributorName} suggested a dish: ${payload.suggestion}. Approve?`);
        targetPhones.push(owner.phone);
      }
      await logEvent(kitchenId, type, sourcePhone, targetPhones, payload);
      break;
    }
    case 'order_confirmed': {
      const cooks = await getKitchenMembers(kitchenId, 'cook');
      const targetPhones = [];
      for (const cook of cooks) {
        await sendText(cook.phone, `Order confirmed! Items: ${payload.itemList}\nETA: ${payload.eta}`);
        targetPhones.push(cook.phone);
      }
      await logEvent(kitchenId, type, sourcePhone, targetPhones, payload);
      break;
    }
    case 'leftover_response': {
      const owners = await getKitchenMembers(kitchenId, 'owner');
      const targetPhones = [];
      for (const owner of owners) {
        await sendText(owner.phone, `Cook says ${payload.item} bacha hai, aaj ${payload.suggestion} bana lo?`);
        targetPhones.push(owner.phone);
      }
      await logEvent(kitchenId, type, sourcePhone, targetPhones, payload);
      break;
    }
  }
}
