import express from 'express';
import config, { initConfig } from './config.js';
import pool from './db/pool.js';
import redis from './db/redis.js';
import { verifyWebhook, parseIncoming, answerCallbackQuery, downloadAudio, sendText } from './transport/index.js';
import { transcribeAudio } from './ai/whisper.js';
import { processMessage } from './ai/processor.js';
import rateLimit from './middleware/rateLimit.js';
import dedup from './middleware/dedup.js';
import { authenticateUser } from './middleware/auth.js';
import { handleOnboarding, handleDeepLinkInvite } from './kitchen/onboarding.js';
import { refreshSession } from './kitchen/auth.js';
import { setupScheduler } from './kitchen/scheduler.js';
import { logInfo, logError, incrementMetric, getMetrics } from './middleware/logger.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.status(200).json({ status: 'ok', db: 'up', redis: 'up' });
  } catch (error) {
    logError({}, 'health_check_error', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/metrics', async (req, res) => {
  const token = config.METRICS_TOKEN;
  if (token) {
    const provided = req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (provided !== token) {
      return res.status(401).send('Unauthorized');
    }
  }
  res.status(200).json(await getMetrics());
});

app.get('/auth/swiggy/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    logError({}, 'swiggy_auth_error', { error });
    return res.status(400).send(`Auth failed: ${error}`);
  }

  logInfo({}, 'swiggy_auth_callback', { code: code ? 'received' : 'missing', state });

  res.send(`
    <div style="font-family: sans-serif; text-align: center; padding: 50px;">
      <h1 style="color: #fc8019;">TiffinSet + Swiggy</h1>
      <p>Connection successful! You can now close this window and go back to your bot.</p>
    </div>
  `);
});

function webhookAuth(req, res, next) {
  if (!verifyWebhook(req)) {
    logError({}, 'webhook_unauthorized', {
      receivedToken: req.headers['x-telegram-bot-api-secret-token'] ? 'present' : 'missing'
    });
    return res.status(403).send('Unauthorized');
  }
  next();
}

app.post('/webhook/telegram', webhookAuth, rateLimit, dedup, async (req, res) => {
  // Return 200 immediately to Telegram
  res.status(200).send('OK');

  // Process asynchronously
  try {
    const parsed = parseIncoming(req.body);
    if (!parsed) return;

    incrementMetric('messagesReceived');
    const ctx = { chatId: String(parsed.chatId) };
    logInfo(ctx, 'webhook_received', {
      messageType: parsed.type,
      hasText: !!parsed.text,
      hasAudio: !!parsed.audio,
      hasCallback: !!parsed.data,
    });

    let textInput = '';

    if (parsed.type === 'callback_query') {
      await answerCallbackQuery(parsed.callbackQueryId);
      textInput = parsed.data;
    } else if (parsed.type === 'message' && parsed.audio) {
      try {
        const start = Date.now();
        incrementMetric('whisperCalls');
        const audioBuffer = await downloadAudio(parsed.audio.file_id);
        textInput = await transcribeAudio(audioBuffer);
        logInfo(ctx, 'whisper_transcription', { duration: Date.now() - start, textLength: textInput.length });
      } catch (err) {
        logError(ctx, 'voice_processing_error', err);
        await sendText(parsed.chatId, 'Sorry, main aapki voice note nahi samajh paaya. Phir se try karo?');
        incrementMetric('messagesSent');
        return;
      }
    } else if (parsed.type === 'message' && parsed.text) {
      textInput = parsed.text;
    }

    if (!textInput) return;

    if (textInput.startsWith('/start invite_')) {
      const parts = textInput.split('_');
      if (parts.length >= 3) {
        const kitchenId = parts.slice(1, parts.length - 1).join('_');
        const role = parts[parts.length - 1];
        await handleDeepLinkInvite(parsed.chatId, kitchenId, role);
        return;
      }
    }

    const auth = await authenticateUser(parsed.chatId);

    if (auth.status === 'onboarding') {
      await handleOnboarding(parsed.chatId, textInput);
      return;
    }

    if (auth.status === 'unknown') {
      if (textInput === '/start') textInput = 'Hello';
      await handleOnboarding(parsed.chatId, textInput);
      return;
    }

    if (auth.status === 'authenticated') {
      if (textInput.startsWith('/invite ')) {
        const parts = textInput.split(' ');
        if (parts.length === 2) {
          const role = parts[1].toLowerCase();
          if (['cook', 'contributor'].includes(role)) {
            const inviteLink = `https://t.me/TiffinSetBot?start=invite_${auth.kitchenId}_${role}`;
            await sendText(parsed.chatId, `Share this link with your ${role}:\n${inviteLink}\n\nAs soon as they click it, they will be joined to your kitchen!`);
            return;
          }
        }
        await sendText(parsed.chatId, "To invite someone, type: /invite <cook|contributor>");
        return;
      }

      try {
        const response = await processMessage(parsed.chatId, textInput);
        await sendText(parsed.chatId, response);
        incrementMetric('messagesSent');
        await refreshSession(parsed.chatId);
      } catch (err) {
        logError(ctx, 'process_message_error', err);
        await sendText(parsed.chatId, 'Kuch gadbad ho gayi. Thodi der mein try karo.');
        incrementMetric('messagesSent');
      }
    }
  } catch (error) {
    logError({}, 'webhook_processing_error', error);
  }
});

const PORT = process.env.PORT || 3000;

async function start() {
  await initConfig();
  setupScheduler();
  app.listen(PORT, () => {
    logInfo({}, 'server_started', { port: PORT });
  });
}

start().catch((err) => {
  logError({}, 'server_start_error', err);
  process.exit(1);
});
