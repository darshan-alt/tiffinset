import redis from '../db/redis.js';
import pool from '../db/pool.js';
import { generateOTP, verifyOTP, createSession } from './auth.js';
import { sendText } from '../transport/index.js';
import { logError } from '../middleware/logger.js';

export async function handleOnboarding(chatId, messageText) {
  const onboardingKey = `onboarding:${chatId}`;
  const stateStr = await redis.get(onboardingKey);
  
  let state = { step: 'welcome', data: {} };
  if (stateStr) {
    state = JSON.parse(stateStr);
  }

  if (state.step === 'welcome') {
    await sendText(chatId, "Welcome to TiffinSet! 🍱 Let's set up your kitchen.\nFirst, what is your preferred language? (Type English or Hinglish)");
    state.step = 'language';
    await redis.setex(onboardingKey, 3600, JSON.stringify(state));
  }
  else if (state.step === 'language') {
    let lang = messageText.trim().toLowerCase();
    if (lang === 'hinglish' || lang === 'hindi') {
      state.data.language = 'hinglish';
      await sendText(chatId, "Ghar mein kitne log hain? (Enter a number)");
    } else {
      state.data.language = 'english';
      await sendText(chatId, "How many people are in your household? (Enter a number)");
    }
    state.step = 'household_size';
    await redis.setex(onboardingKey, 3600, JSON.stringify(state));
  }
  else if (state.step === 'household_size') {
    let size = parseInt(messageText, 10);
    if (isNaN(size)) size = 4;
    state.data.householdSize = size;
    
    if (state.data.language === 'hinglish') {
      await sendText(chatId, "Koi food restrictions? (e.g., vegetarian, no pork, allergies). Nahi ho toh 'none' type karein.");
    } else {
      await sendText(chatId, "Any food restrictions? (e.g., vegetarian, no pork, allergies). If none, type 'none'.");
    }
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
        'INSERT INTO kitchen_sessions (kitchen_id, owner_phone, household_size, dietary_prefs) VALUES ($1, $2, $3, $4)',
        [kitchenId, String(chatId), state.data.householdSize, JSON.stringify(prefs)]
      );
      
      await pool.query(
        "INSERT INTO user_profiles (phone, kitchen_id, role, display_name, is_verified, language_code) VALUES ($1, $2, 'owner', 'Owner', true, $3)",
        [String(chatId), kitchenId, state.data.language || 'english']
      );
      
      await createSession(chatId, kitchenId, 'owner');
      await redis.del(onboardingKey);
      
      if (state.data.language === 'hinglish') {
        await sendText(chatId, "Setup complete! 🎉 Ab aap menu set kar sakte hain. Voice note mein batao aaj kya banana hai!");
      } else {
        await sendText(chatId, "Setup complete! 🎉 You can now manage your kitchen. Send a voice note or message to tell me what to cook today!");
      }
    } catch (err) {
      logError({ chatId }, 'onboarding_db_error', err);
      await sendText(chatId, "Oops, something went wrong saving your profile. Let's try again.");
    }
  }
  else if (state.step === 'invite_verify') {
    const res = await verifyOTP(chatId, messageText);
    if (res.valid) {
      if (state.data.role === 'cook') {
        await sendText(chatId, "Welcome! What is your preferred language? (English/Hindi/Kannada/Tamil/Telugu)");
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
          await sendText(chatId, "Welcome to TiffinSet! You are now joined to the kitchen.");
          await sendText(state.data.invitedBy, "Your invitee has successfully joined the kitchen.");
        } catch (err) {
           logError({ chatId }, 'invitee_db_error', err);
        }
      }
    } else if (res.reason === 'wrong_code') {
      await sendText(chatId, `Incorrect code. ${res.remaining} tries left.`);
    } else if (res.reason === 'expired') {
      const otpRes = await generateOTP(chatId);
      if (!otpRes.error) {
        await sendText(chatId, `Code expired. We sent a new code: ${otpRes.code}`);
      }
    } else if (res.reason === 'max_attempts') {
      await sendText(chatId, "Too many incorrect attempts. Please try again in 15 minutes.");
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
    const lang = map[input] || 'en';
    
    try {
      await pool.query(
        "INSERT INTO user_profiles (phone, kitchen_id, role, display_name, is_verified, language_code) VALUES ($1, $2, 'cook', 'Cook', true, $3)",
        [String(chatId), state.data.kitchenId, lang]
      );
      await createSession(chatId, state.data.kitchenId, 'cook');
      await redis.del(onboardingKey);
      await sendText(chatId, "Welcome to TiffinSet!");
      await sendText(state.data.invitedBy, "The cook has successfully joined the kitchen.");
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
