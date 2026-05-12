import redis from '../db/redis.js';
import pool from '../db/pool.js';
import { callGemini } from './gemini.js';
import { buildSystemPrompt } from './prompts.js';
import { toolDefinitions, executeTool } from './tools.js';
import { logInfo, logError } from '../middleware/logger.js';

const MAX_ITERATIONS = 5;
const MAX_HISTORY = 40;
const HISTORY_TTL = 86400; // 24 hours

export async function processMessage(chatId, text) {
  // 1. Load user profile
  const profileRes = await pool.query(
    'SELECT phone, kitchen_id, role, display_name, language_code FROM user_profiles WHERE phone = $1',
    [String(chatId)]
  );
  if (profileRes.rows.length === 0) {
    throw new Error(`No profile found for chatId ${chatId}`);
  }
  const profile = profileRes.rows[0];

  // 2. Load kitchen data
  const kitchenRes = await pool.query(
    'SELECT household_size, address, dietary_prefs FROM kitchen_sessions WHERE kitchen_id = $1',
    [profile.kitchen_id]
  );
  if (kitchenRes.rows.length === 0) {
    throw new Error(`No kitchen found for kitchen_id ${profile.kitchen_id}`);
  }
  const kitchen = kitchenRes.rows[0];

  // 3. Build system prompt
  const systemPrompt = buildSystemPrompt(profile, kitchen);

  // 4. Load conversation history from Redis
  const historyKey = `chat:${chatId}`;
  const historyStr = await redis.get(historyKey);
  const history = historyStr ? JSON.parse(historyStr) : [];

  // 5. Push new user message
  history.push({ role: 'user', parts: [{ text }] });

  // 6. Agentic loop
  const context = { chatId, kitchenId: profile.kitchen_id, role: profile.role };

  // Filter tools by role — only the owner gets commerce + override tools
  let activeTools = toolDefinitions;
  if (profile.role === 'cook') {
    activeTools = toolDefinitions.filter(t =>
      !['search_instamart', 'add_to_cart', 'view_cart', 'place_order', 'get_order_history', 'save_recipe_override'].includes(t.name)
    );
  } else if (profile.role === 'contributor') {
    activeTools = toolDefinitions.filter(t =>
      !['search_instamart', 'add_to_cart', 'view_cart', 'place_order', 'save_recipe_override'].includes(t.name)
    );
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const geminiStart = Date.now();
    const result = await callGemini(systemPrompt, history, activeTools);

    if (result.type === 'text') {
      // Model gave a final text response
      logInfo(context, 'gemini_text_response', { iteration: i + 1, duration: Date.now() - geminiStart });
      history.push({ role: 'model', parts: [{ text: result.text }] });
      await saveHistory(historyKey, history);
      return result.text;
    }

    if (result.type === 'function_call') {
      // Model wants to call a tool
      logInfo(context, 'gemini_tool_call', {
        iteration: i + 1,
        toolName: result.name,
        args: result.args,
        duration: Date.now() - geminiStart,
      });

      // Push model's turn (contains the functionCall part)
      history.push({ role: 'model', parts: result.rawParts });

      // Execute the tool
      const toolStart = Date.now();
      const toolResult = await executeTool(result.name, result.args, context);
      logInfo(context, 'tool_executed', { toolName: result.name, duration: Date.now() - toolStart });

      // Push function response as a user turn (Gemini API format)
      history.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: result.name,
            response: toolResult,
          },
        }],
      });
      // Continue the loop — Gemini will see the tool result next iteration
    }
  }

  // Loop exhausted
  logInfo(context, 'agentic_loop_exhausted', { maxIterations: MAX_ITERATIONS });
  await saveHistory(historyKey, history);
  return 'Processing mein thoda time lag raha hai. Phir se try karo.';
}

async function saveHistory(key, history) {
  // Cap at last MAX_HISTORY entries, but drop any leading turn that would
  // leave a functionResponse without its preceding functionCall (Gemini 400s on that).
  let trimmed = history.slice(-MAX_HISTORY);
  while (trimmed.length > 0) {
    const first = trimmed[0];
    const isOrphanResponse = first.role === 'user' && first.parts?.some(p => p.functionResponse);
    const isLeadingModelTurn = first.role === 'model';
    if (isOrphanResponse || isLeadingModelTurn) {
      trimmed.shift();
    } else {
      break;
    }
  }
  await redis.setex(key, HISTORY_TTL, JSON.stringify(trimmed));
}
