// src/index.js — Express server, Telegram webhook handler
import express from 'express';
import { initConfig, config } from './config.js';
import { initDb, checkDb } from './db/pool.js';
import { checkRedis } from './db/redis.js';
import { verifyWebhook, parseIncoming, sendText, answerCallbackQuery, downloadAudio } from './transport/index.js';
import { checkRateLimit } from './middleware/rateLimit.js';
import { checkDedup } from './middleware/dedup.js';
import { authenticateUser } from './middleware/auth.js';
import { handleOnboarding, handleDeepLinkInvite } from './kitchen/onboarding.js';
import { processMessage } from './ai/processor.js';
import { transcribeAudio } from './ai/whisper.js';
import { refreshSession } from './kitchen/auth.js';
import { setupScheduler } from './kitchen/scheduler.js';
import { logInfo, logError, getMetrics } from './middleware/logger.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  try {
    await checkDb();
    await checkRedis();
    res.json({ status: 'ok', ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// ─── Metrics ──────────────────────────────────────────────────────────────────

app.get('/metrics', async (req, res) => {
  // Optional bearer auth
  if (config.METRICS_TOKEN) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${config.METRICS_TOKEN}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  try {
    const metrics = await getMetrics();
    res.json({ metrics, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Telegram webhook ─────────────────────────────────────────────────────────

app.post('/webhook/telegram', async (req, res) => {
  // 1. Verify webhook secret BEFORE any Redis budget is consumed
  if (!verifyWebhook(req)) {
    logInfo('webhook', 'rejected_bad_token');
    return res.status(403).send('Forbidden');
  }

  // 2. Parse incoming
  const parsed = parseIncoming(req.body);
  const { chatId, messageId } = parsed;

  if (!chatId) {
    return res.status(200).send('OK');
  }

  // 3. Rate limit
  const allowed = await checkRateLimit(chatId);
  if (!allowed) {
    res.status(200).send('OK'); // Telegram still needs 200
    await sendText(chatId, 'Thoda slow karo! 1 minute mein bohot messages aa gaye.');
    return;
  }

  // 4. Dedup
  if (messageId) {
    const isNew = await checkDedup(messageId);
    if (!isNew) {
      logInfo('webhook', 'duplicate_skipped', { messageId });
      return res.status(200).send('Duplicate');
    }
  }

  // 5. Return 200 immediately — Telegram requires fast ACK
  res.status(200).send('OK');

  // 6. Async processing (fire-and-forget)
  processWebhookAsync(parsed).catch((err) => {
    logError('webhook', 'async_error', err, { chatId });
  });
});

async function processWebhookAsync(parsed) {
  const { type, chatId, text: rawText, audio, data, callbackQueryId } = parsed;

  let textInput = null;

  // Handle callback query (button tap)
  if (type === 'callback_query') {
    await answerCallbackQuery(callbackQueryId);
    textInput = data;
  }
  // Handle voice/audio
  else if (type === 'voice' && audio) {
    try {
      const audioBuffer = await downloadAudio(audio);
      const transcribed = await transcribeAudio(audioBuffer);
      if (!transcribed) {
        await sendText(chatId, 'Voice note samajh nahi aaya. Please text mein likhkar bhejo.');
        return;
      }
      logInfo('webhook', 'voice_transcribed', { chatId, chars: transcribed.length });
      textInput = transcribed;
    } catch (err) {
      logError('webhook', 'voice_error', err, { chatId });
      await sendText(chatId, 'Voice note process nahi hua. Please text mein likhkar bhejo.');
      return;
    }
  }
  // Handle text
  else if (type === 'text') {
    textInput = rawText;
  }

  if (!textInput) return;

  // Handle deep-link invite: /start invite_{kitchenId}_{role}
  if (textInput.startsWith('/start invite_')) {
    const parts = textInput.replace('/start invite_', '').split('_');
    if (parts.length === 2) {
      const [kitchenId, role] = parts;
      await handleDeepLinkInvite(chatId, `kitchen_${kitchenId}`, role);
      return;
    }
  }

  // Handle /start for new users
  if (textInput === '/start') {
    const auth = await authenticateUser(chatId);
    if (auth.status !== 'authenticated') {
      await handleOnboarding(chatId, textInput);
      return;
    }
  }

  // Authenticate user
  const auth = await authenticateUser(chatId);

  if (auth.status === 'onboarding' || auth.status === 'unknown') {
    await handleOnboarding(chatId, textInput);
    return;
  }

  if (auth.status === 'authenticated') {
    // Handle /invite command (owner only)
    if (textInput.startsWith('/invite ') && auth.role === 'owner') {
      const role = textInput.replace('/invite ', '').trim().toLowerCase();
      if (!['cook', 'contributor'].includes(role)) {
        await sendText(chatId, 'Usage: /invite cook  or  /invite contributor');
        return;
      }
      const kitchenId = auth.kitchenId;
      const inviteUrl = `https://t.me/TiffinSetBot?start=invite_${kitchenId.replace('kitchen_', '')}_${role}`;
      await sendText(chatId, `${role} invite link:\n${inviteUrl}\n\nIs link ko ${role} ko bhejo. Link click karte hi unka registration ho jayega.`);
      return;
    }

    // Handle /help command
    if (textInput === '/help') {
      const helpText = auth.role === 'owner'
        ? 'TiffinSet commands:\n/invite cook — Cook ko invite karo\n/invite contributor — Family member ko add karo\n/help — Yeh message\n\nBas naturally baat karo! "Aaj paneer tikka banana hai" ya "order karo atta 5kg"'
        : 'TiffinSet mein aapka swagat! Baat karo, main help karunga.';
      await sendText(chatId, helpText);
      return;
    }

    // Main AI processing
    try {
      const response = await processMessage(chatId, textInput);
      if (response) {
        await sendText(chatId, response);
      }
      await refreshSession(chatId);
    } catch (err) {
      logError('webhook', 'process_error', err, { chatId });
      await sendText(chatId, 'Kuch error hua. Thodi der mein try karo.');
    }
  }
}

// ─── Server startup ───────────────────────────────────────────────────────────

async function start() {
  try {
    await initConfig();
    logInfo('server', 'config_loaded');

    await initDb();
    logInfo('server', 'db_initialized');

    setupScheduler();

    const port = config.PORT || 3000;
    app.listen(port, () => {
      logInfo('server', 'listening', { port, env: config.NODE_ENV });
      console.log(`TiffinSet running on port ${port}`);
    });
  } catch (err) {
    logError('server', 'startup_failed', err);
    process.exit(1);
  }
}

start();

export { app };
