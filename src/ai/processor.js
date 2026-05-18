// src/ai/processor.js — Main agentic loop: processMessage
import { callGemini } from './gemini.js';
import { buildSystemPrompt } from './prompts.js';
import { getToolsForRole, executeTool } from './tools.js';
import { getRedis } from '../db/redis.js';
import { query } from '../db/pool.js';
import { logInfo, logError, incrementMetric } from '../middleware/logger.js';

const HISTORY_TTL = 24 * 60 * 60; // 24 hours
const MAX_HISTORY = 40;
const MAX_ITERATIONS = 5;

/**
 * Load conversation history from Redis.
 */
async function loadHistory(chatId) {
  try {
    const redis = getRedis();
    const raw = await redis.get(`chat:${chatId}`);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Save conversation history to Redis.
 * Caps at MAX_HISTORY entries.
 * Drops leading orphan functionResponse or model turns (Gemini 400s on malformed history).
 */
async function saveHistory(chatId, history) {
  try {
    const redis = getRedis();

    // Cap to last MAX_HISTORY entries
    let capped = history.slice(-MAX_HISTORY);

    // Drop leading entries that aren't user turns (Gemini requires history to start with user turn)
    while (capped.length > 0 && capped[0].role !== 'user') {
      capped = capped.slice(1);
    }

    // Also drop leading user turns that contain only functionResponse (not text)
    while (capped.length > 0 && capped[0].role === 'user') {
      const hasFnResponse = capped[0].parts?.some((p) => p.functionResponse);
      const hasText = capped[0].parts?.some((p) => p.text);
      if (hasFnResponse && !hasText) {
        capped = capped.slice(1);
      } else {
        break;
      }
    }

    await redis.set(`chat:${chatId}`, JSON.stringify(capped), 'EX', HISTORY_TTL);
  } catch (err) {
    logError('processor', 'saveHistory_error', err);
  }
}

/**
 * Main message processing function.
 * Runs the Gemini agentic loop with tool calling.
 */
export async function processMessage(chatId, text) {
  incrementMetric('messagesReceived').catch(() => {});

  let profile, kitchen;

  try {
    // Load user profile
    const profileResult = await query(
      'SELECT phone, kitchen_id, role, display_name, language_code FROM user_profiles WHERE phone = $1',
      [chatId]
    );
    if (profileResult.rows.length === 0) {
      return 'User profile not found. Please restart onboarding with /start';
    }
    profile = profileResult.rows[0];

    // Load kitchen
    const kitchenResult = await query(
      'SELECT kitchen_id, household_size, address, dietary_prefs FROM kitchen_sessions WHERE kitchen_id = $1',
      [profile.kitchen_id]
    );
    kitchen = kitchenResult.rows[0] || null;
  } catch (err) {
    logError('processor', 'db_load_error', err, { chatId });
    return 'Kuch technical problem hai. Thodi der mein try karo.';
  }

  const systemPrompt = buildSystemPrompt(profile, kitchen);
  const tools = getToolsForRole(profile.role);
  const context = { chatId, kitchenId: profile.kitchen_id, role: profile.role };

  const history = await loadHistory(chatId);
  history.push({ role: 'user', parts: [{ text }] });

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    let result;
    try {
      result = await callGemini(systemPrompt, history, tools);
    } catch (err) {
      logError('processor', 'gemini_error', err, { chatId, iteration: iterations });
      await saveHistory(chatId, history);
      return 'AI se baat karne mein dikkat aa rahi hai. Thodi der mein try karo.';
    }

    if (result.type === 'text') {
      history.push({ role: 'model', parts: [{ text: result.text }] });
      await saveHistory(chatId, history);
      incrementMetric('messagesSent').catch(() => {});
      logInfo('processor', 'text_response', { chatId, role: profile.role, iteration: iterations });
      return result.text;
    }

    // Function call
    if (result.type === 'function_call') {
      // Push model turn with stripped thinking parts (rawParts already stripped in gemini.js)
      history.push({ role: 'model', parts: result.rawParts });

      logInfo('processor', 'tool_call', { chatId, tool: result.name, args: result.args });

      const toolResult = await executeTool(result.name, result.args, context);

      history.push({
        role: 'user',
        parts: [{ functionResponse: { name: result.name, response: toolResult } }],
      });

      iterations++;
      continue;
    }

    break;
  }

  // Loop exhausted
  await saveHistory(chatId, history);
  logInfo('processor', 'loop_exhausted', { chatId, iterations });
  return 'Processing mein thoda time lag raha hai. Thodi der mein try karo.';
}
