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
      await sendText(chatId, "Aapka address kya hai? (Delivery ke liye)");
    } else {
      await sendText(chatId, "What is your address? (For delivery)");
    }
    state.step = 'address';
    await redis.setex(onboardingKey, 3600, JSON.stringify(state));
  }
  else if (state.step === 'address') {
    state.data.address = messageText.trim();
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
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        await client.query(
          `INSERT INTO kitchen_sessions (kitchen_id, owner_phone, household_size, address, dietary_prefs) 
           VALUES ($1, $2, $3, $4, $5) 
           ON CONFLICT (kitchen_id) DO UPDATE SET 
             household_size = EXCLUDED.household_size, 
             address = EXCLUDED.address, 
             dietary_prefs = EXCLUDED.dietary_prefs`,
          [kitchenId, String(chatId), state.data.householdSize, state.data.address || '', JSON.stringify(prefs)]
        );
        
        await client.query(
          `INSERT INTO user_profiles (phone, kitchen_id, role, display_name, is_verified, language_code) 
           VALUES ($1, $2, 'owner', 'Owner', true, $3)
           ON CONFLICT (phone) DO UPDATE SET 
             kitchen_id = EXCLUDED.kitchen_id, 
             language_code = EXCLUDED.language_code`,
          [String(chatId), kitchenId, state.data.language || 'english']
        );
        
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      
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
    } catch (err) {
      logError({ chatId }, 'cook_join_db_error', err);
    }
  }
}

export async function handleDeepLinkInvite(chatId, kitchenId, role) {
  try {
    const existing = await pool.query('SELECT phone FROM user_profiles WHERE phone = $1', [String(chatId)]);
    if (existing.rows.length > 0) {
      await sendText(chatId, "You are already registered on TiffinSet.");
      return;
    }
    
    // We bypass OTP because deep link itself is the invite.
    if (role === 'cook') {
      await sendText(chatId, "Welcome! What is your preferred language? (English/Hindi/Kannada/Tamil/Telugu)");
      const onboardingKey = `onboarding:${chatId}`;
      const state = { step: 'invite_language', data: { kitchenId, role } };
      await redis.setex(onboardingKey, 3600, JSON.stringify(state));
    } else if (role === 'contributor') {
      await pool.query(
        "INSERT INTO user_profiles (phone, kitchen_id, role, display_name, is_verified) VALUES ($1, $2, 'contributor', 'Contributor', true)",
        [String(chatId), kitchenId]
      );
      await createSession(chatId, kitchenId, 'contributor');
      await sendText(chatId, "Welcome to TiffinSet! You are now joined to the kitchen.");
    }
  } catch (err) {
    logError({ chatId }, 'handle_deeplink_invite_error', err);
    await sendText(chatId, "Failed to process invite link. Please try again.");
  }
}
