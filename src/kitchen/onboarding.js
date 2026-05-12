import redis from '../db/redis.js';
import pool from '../db/pool.js';
import { generateOTP, verifyOTP, createSession } from './auth.js';
import { sendText } from '../transport/index.js';
import { logError } from '../middleware/logger.js';

export async function handleOnboarding(chatId, messageText) {
  const onboardingKey = `onboarding:${chatId}`;
  const stateStr = await redis.get(onboardingKey);
  
  let state = { step: 'otp_send', data: {} };
  if (stateStr) {
    state = JSON.parse(stateStr);
  } else {
    state.step = 'otp_send';
  }

  if (state.step === 'otp_send') {
    const otpRes = await generateOTP(chatId);
    if (otpRes.error) {
      await sendText(chatId, `Please wait ${otpRes.minutesLeft} minutes before trying again.`);
      return;
    }
    await sendText(chatId, `TiffinSet mein aapka swagat hai! Pehle verify karte hain. Aapka code: ${otpRes.code}`);
    await redis.setex(onboardingKey, 3600, JSON.stringify({ step: 'otp_verify', data: {} }));
  } 
  else if (state.step === 'otp_verify') {
    const res = await verifyOTP(chatId, messageText);
    if (res.valid) {
      await sendText(chatId, "Verified! Ghar mein kitne log hain? (number bhejo)");
      state.step = 'household_size';
      await redis.setex(onboardingKey, 3600, JSON.stringify(state));
    } else if (res.reason === 'wrong_code') {
      await sendText(chatId, `Galat code. ${res.remaining} tries baaki.`);
    } else if (res.reason === 'expired') {
      const otpRes = await generateOTP(chatId);
      if (otpRes.error) {
        await sendText(chatId, `Please wait ${otpRes.minutesLeft} minutes before trying again.`);
        return;
      }
      await sendText(chatId, `Code expired. Naya code bheja hai: ${otpRes.code}`);
    } else if (res.reason === 'max_attempts') {
      await sendText(chatId, "Bahut zyada galat attempts. 15 min baad try karo.");
      await redis.del(onboardingKey);
    }
  }
  else if (state.step === 'household_size') {
    let size = parseInt(messageText, 10);
    if (isNaN(size)) size = 4;
    state.data.householdSize = size;
    await sendText(chatId, "Delivery address kya hai?");
    state.step = 'address';
    await redis.setex(onboardingKey, 3600, JSON.stringify(state));
  }
  else if (state.step === 'address') {
    state.data.address = messageText;
    await sendText(chatId, "Koi food restrictions? (e.g., vegetarian, no pork, no beef). Nahi ho toh 'nahi' bolo.");
    state.step = 'dietary';
    await redis.setex(onboardingKey, 3600, JSON.stringify(state));
  }
  else if (state.step === 'dietary') {
    let prefsText = messageText.trim().toLowerCase();
    let prefs = [];
    if (!['nahi', 'no', 'none'].includes(prefsText)) {
      prefs = messageText.split(',').map(s => s.trim()).filter(s => s);
    }
    
    const kitchenId = 'kitchen_' + String(chatId).slice(-8);
    
    try {
      await pool.query(
        'INSERT INTO kitchen_sessions (kitchen_id, owner_phone, address, household_size, dietary_prefs) VALUES ($1, $2, $3, $4, $5)',
        [kitchenId, String(chatId), state.data.address, state.data.householdSize, JSON.stringify(prefs)]
      );
      
      await pool.query(
        "INSERT INTO user_profiles (phone, kitchen_id, role, display_name, is_verified) VALUES ($1, $2, 'owner', 'Owner', true)",
        [String(chatId), kitchenId]
      );
      
      await createSession(chatId, kitchenId, 'owner');
      await redis.del(onboardingKey);
      await sendText(chatId, "Setup complete! Ab aap menu set kar sakte hain. Voice note mein batao aaj kya banana hai!");
    } catch (err) {
      logError({ chatId }, 'onboarding_db_error', err);
      await sendText(chatId, "Kuch galat ho gaya, phir se try karein.");
    }
  }
  else if (state.step === 'invite_verify') {
    const res = await verifyOTP(chatId, messageText);
    if (res.valid) {
      if (state.data.role === 'cook') {
        await sendText(chatId, "Aapki preferred language? (Hindi/English/Kannada/Tamil/Telugu)");
        state.step = 'invite_language';
        await redis.setex(onboardingKey, 3600, JSON.stringify(state));
      } else if (state.data.role === 'contributor') {
        try {
          await pool.query(
            "INSERT INTO user_profiles (phone, kitchen_id, role, display_name, is_verified) VALUES ($1, $2, 'contributor', 'Contributor', true)",
            [String(chatId), state.data.kitchenId]
          );
          await createSession(chatId, state.data.kitchenId, 'contributor');
          await redis.del(onboardingKey);
          await sendText(chatId, "TiffinSet mein aapka swagat hai!");
          await sendText(state.data.invitedBy, "Invitee ne join kar liya hai.");
        } catch (err) {
           logError({ chatId }, 'invitee_db_error', err);
        }
      }
    } else if (res.reason === 'wrong_code') {
      await sendText(chatId, `Galat code. ${res.remaining} tries baaki.`);
    } else if (res.reason === 'expired') {
      const otpRes = await generateOTP(chatId);
      if (!otpRes.error) {
        await sendText(chatId, `Code expired. Naya code: ${otpRes.code}`);
      }
    } else if (res.reason === 'max_attempts') {
      await sendText(chatId, "15 min baad try karo.");
      await redis.del(onboardingKey);
    }
  }
  else if (state.step === 'invite_language') {
    const input = messageText.trim().toLowerCase();
    const map = {
      'hindi': 'hi',
      'english': 'en',
      'kannada': 'kn',
      'tamil': 'ta',
      'telugu': 'te'
    };
    const lang = map[input] || 'hi';
    
    try {
      await pool.query(
        "INSERT INTO user_profiles (phone, kitchen_id, role, display_name, is_verified, language_code) VALUES ($1, $2, 'cook', 'Cook', true, $3)",
        [String(chatId), state.data.kitchenId, lang]
      );
      await createSession(chatId, state.data.kitchenId, 'cook');
      await redis.del(onboardingKey);
      await sendText(chatId, "TiffinSet mein aapka swagat hai!");
      await sendText(state.data.invitedBy, "Cook ne join kar liya hai.");
    } catch (err) {
      logError({ chatId }, 'cook_join_db_error', err);
    }
  }
}

export async function handleInvitation(ownerChatId, kitchenId, inviteeChatId, role) {
  try {
    const existing = await pool.query('SELECT phone FROM user_profiles WHERE phone = $1', [String(inviteeChatId)]);
    if (existing.rows.length > 0) {
      await sendText(ownerChatId, "Yeh user pehle se TiffinSet par hai.");
      return;
    }
    
    const ownerNameRes = await pool.query('SELECT display_name FROM user_profiles WHERE phone = $1', [String(ownerChatId)]);
    const ownerName = ownerNameRes.rows[0]?.display_name || 'Kitchen Owner';
    
    const otpRes = await generateOTP(inviteeChatId);
    if (otpRes.error) {
      await sendText(ownerChatId, "Kuch der baad try karein.");
      return;
    }
    
    await sendText(inviteeChatId, `${ownerName} ne aapko TiffinSet mein ${role} ke roop mein add kiya hai. Verify code: ${otpRes.code}`);
    await redis.setex(`onboarding:${inviteeChatId}`, 3600, JSON.stringify({
      step: 'invite_verify',
      data: { kitchenId, role, invitedBy: ownerChatId }
    }));
    await sendText(ownerChatId, "Invitation bhej diya. Unhe verify karna hoga.");
  } catch (err) {
    logError({ chatId: ownerChatId }, 'handle_invitation_error', err);
  }
}
