// src/kitchen/onboarding.js — Multi-step onboarding state machine
import { getRedis } from '../db/redis.js';
import { query } from '../db/pool.js';
import { createSession } from './auth.js';
import { sendText, sendButtons } from '../transport/index.js';
import { logInfo } from '../middleware/logger.js';

const ONBOARDING_TTL = 3600; // 1 hour

/** Normalize language input to ISO 2-letter code */
function normalizeLanguage(input) {
  const s = (input || '').toLowerCase().trim();
  if (s === 'hindi' || s === 'hinglish' || s === 'hi' || s === '1') return 'hi';
  if (s === 'english' || s === 'en' || s === '2') return 'en';
  if (s === 'kannada' || s === 'kn' || s === '3') return 'kn';
  if (s === 'tamil' || s === 'ta' || s === '4') return 'ta';
  if (s === 'telugu' || s === 'te' || s === '5') return 'te';
  return null;
}

function kitchenId(ownerChatId) {
  const s = String(ownerChatId);
  return 'kitchen_' + s.slice(-8);
}

/**
 * Main onboarding handler — called when user status is 'onboarding' or 'unknown'.
 */
export async function handleOnboarding(chatId, text) {
  const redis = getRedis();
  const stateKey = `onboarding:${chatId}`;
  const raw = await redis.get(stateKey);

  // Brand-new user or returning unknown
  if (!raw) {
    return _startOwnerOnboarding(chatId, redis, stateKey);
  }

  const state = JSON.parse(raw);

  // Route by role being onboarded
  if (state.role === 'owner') {
    return _continueOwnerOnboarding(chatId, text, state, redis, stateKey);
  }

  if (state.role === 'cook' || state.role === 'contributor') {
    return _continueInviteOnboarding(chatId, text, state, redis, stateKey);
  }
}

/**
 * Handle deep-link invite: /start invite_{kitchenId}_{role}
 */
export async function handleDeepLinkInvite(chatId, kitchenIdParam, role) {
  const redis = getRedis();

  // Check not already registered
  const existing = await query('SELECT phone FROM user_profiles WHERE phone = $1', [chatId]);
  if (existing.rows.length > 0) {
    await sendText(chatId, 'Aap pehle se TiffinSet mein register hain! Apna kitchen manage karne ke liye message karo.');
    return;
  }

  // Validate kitchen exists
  const kitchenResult = await query('SELECT kitchen_id FROM kitchen_sessions WHERE kitchen_id = $1', [kitchenIdParam]);
  if (kitchenResult.rows.length === 0) {
    await sendText(chatId, 'Yeh invite link valid nahi hai. Owner se naya link maango.');
    return;
  }

  const stateKey = `onboarding:${chatId}`;

  if (role === 'cook') {
    const state = { role: 'cook', step: 'invite_language', kitchenId: kitchenIdParam };
    await redis.set(stateKey, JSON.stringify(state), 'EX', ONBOARDING_TTL);
    await sendButtons(chatId,
      'TiffinSet mein welcome! Aap is kitchen ke cook hain.\n\nApni preferred language choose karo:',
      [
        { text: 'Hindi', data: 'hi' },
        { text: 'English', data: 'en' },
        { text: 'Kannada', data: 'kn' },
        { text: 'Tamil', data: 'ta' },
        { text: 'Telugu', data: 'te' },
      ]
    );
  } else if (role === 'contributor') {
    // Contributor — no language step, register directly
    await _registerInvitee(chatId, kitchenIdParam, 'contributor', 'hi', redis, stateKey);
  } else {
    await sendText(chatId, 'Invalid invite role. Please contact the kitchen owner.');
  }
}

// ─── Owner onboarding ────────────────────────────────────────────────────────

async function _startOwnerOnboarding(chatId, redis, stateKey) {
  const state = { role: 'owner', step: 'language' };
  await redis.set(stateKey, JSON.stringify(state), 'EX', ONBOARDING_TTL);
  await sendButtons(chatId,
    'Namaste! TiffinSet mein aapka swagat hai!\n\nApni ghar ki kitchen manage karo — menu, recipes, grocery orders sab ek jagah.\n\nPehle apni language choose karo:',
    [
      { text: 'Hinglish (Hindi + English)', data: 'hi' },
      { text: 'English only', data: 'en' },
    ]
  );
}

async function _continueOwnerOnboarding(chatId, text, state, redis, stateKey) {
  switch (state.step) {
    case 'language': {
      const lang = normalizeLanguage(text);
      if (!lang) {
        await sendButtons(chatId, 'Please choose your preferred language:', [
          { text: 'Hinglish (Hindi + English)', data: 'hi' },
          { text: 'English only', data: 'en' },
        ]);
        return;
      }
      state.language = lang;
      state.step = 'household_size';
      await redis.set(stateKey, JSON.stringify(state), 'EX', ONBOARDING_TTL);
      await sendText(chatId, 'Aapke ghar mein kitne log hain? (sirf number type karo, jaise: 4)');
      break;
    }

    case 'household_size': {
      const size = parseInt(text, 10);
      if (isNaN(size) || size < 1 || size > 50) {
        await sendText(chatId, 'Please enter a valid number (1-50). Kitne log hain ghar mein?');
        return;
      }
      state.householdSize = size;
      state.step = 'address';
      await redis.set(stateKey, JSON.stringify(state), 'EX', ONBOARDING_TTL);
      await sendText(chatId, 'Aapka delivery address kya hai? (Swiggy Instamart delivery ke liye)');
      break;
    }

    case 'address': {
      if (!text || text.trim().length < 5) {
        await sendText(chatId, 'Please enter your full delivery address.');
        return;
      }
      state.address = text.trim();
      state.step = 'dietary';
      await redis.set(stateKey, JSON.stringify(state), 'EX', ONBOARDING_TTL);
      await sendText(chatId, 'Aapke ghar mein koi dietary restrictions hain? (jaise: vegetarian, no pork, no beef, halal)\n\nAgr koi nahi hai toh "none" type karo.');
      break;
    }

    case 'dietary': {
      let dietary = [];
      if (text.trim().toLowerCase() !== 'none') {
        dietary = text.split(/[,،]/g).map((s) => s.trim()).filter(Boolean);
      }

      const kid = kitchenId(chatId);

      try {
        // Insert kitchen + owner profile
        await query(
          `INSERT INTO kitchen_sessions (kitchen_id, owner_phone, household_size, address, dietary_prefs)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (kitchen_id) DO NOTHING`,
          [kid, chatId, state.householdSize, state.address, JSON.stringify(dietary)]
        );

        await query(
          `INSERT INTO user_profiles (phone, kitchen_id, role, language_code, is_verified)
           VALUES ($1, $2, 'owner', $3, true)
           ON CONFLICT (phone) DO UPDATE SET kitchen_id=$2, role='owner', language_code=$3, is_verified=true`,
          [chatId, kid, state.language || 'hi']
        );

        // Create session + clear onboarding state
        await createSession(chatId, kid, 'owner');
        await redis.del(stateKey);

        logInfo('onboarding', 'owner_registered', { chatId, kitchenId: kid });

        await sendText(chatId,
          `Kitchen setup ho gaya! Your Kitchen ID: ${kid}\n\n` +
          `Ab aap:\n` +
          `- Recipe dhundh sakte ho\n` +
          `- Grocery order kar sakte ho\n` +
          `- Cook/contributor ko invite kar sakte ho\n\n` +
          `Cook invite karne ke liye: /invite cook\n` +
          `Contributor invite: /invite contributor\n\n` +
          `Kuch poocho! Aaj kya banana hai?`
        );
      } catch (err) {
        console.error('[Onboarding] Registration error:', err.message);
        await sendText(chatId, 'Kuch error hua. Please try again in a moment.');
      }
      break;
    }

    default:
      await redis.del(stateKey);
      await _startOwnerOnboarding(chatId, redis, stateKey);
  }
}

// ─── Invite onboarding (cook / contributor) ──────────────────────────────────

async function _continueInviteOnboarding(chatId, text, state, redis, stateKey) {
  if (state.step === 'invite_language') {
    const lang = normalizeLanguage(text);
    if (!lang) {
      await sendButtons(chatId, 'Please choose your language:', [
        { text: 'Hindi', data: 'hi' },
        { text: 'English', data: 'en' },
        { text: 'Kannada', data: 'kn' },
        { text: 'Tamil', data: 'ta' },
        { text: 'Telugu', data: 'te' },
      ]);
      return;
    }
    await _registerInvitee(chatId, state.kitchenId, state.role, lang, redis, stateKey);
  }
}

async function _registerInvitee(chatId, kid, role, lang, redis, stateKey) {
  try {
    await query(
      `INSERT INTO user_profiles (phone, kitchen_id, role, language_code, is_verified)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (phone) DO UPDATE SET kitchen_id=$2, role=$3, language_code=$4, is_verified=true`,
      [chatId, kid, role, lang]
    );

    await createSession(chatId, kid, role);
    await redis.del(stateKey);

    logInfo('onboarding', 'invitee_registered', { chatId, role, kitchenId: kid });

    const welcomeMsg = role === 'cook'
      ? 'Namaste! Aap is kitchen ke cook hain. Aaj ka menu kya hai woh owner se aayega. Koi bhi cooking sawal poocho!'
      : 'Welcome! Aap is kitchen ke family member hain. Dish suggestions de sakte ho owner ko!';

    await sendText(chatId, welcomeMsg);
  } catch (err) {
    console.error('[Onboarding] Invitee registration error:', err.message);
    await sendText(chatId, 'Registration mein error hua. Please try again.');
  }
}
