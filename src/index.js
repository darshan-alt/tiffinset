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
import { handleOnboarding } from './kitchen/onboarding.js';
import { refreshSession, verifyOTP, createSession } from './kitchen/auth.js';
import { setupScheduler } from './kitchen/scheduler.js';
import { logInfo, logError, incrementMetric, getMetrics } from './middleware/logger.js';

const app = express();
app.use(express.json());

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

app.get('/metrics', (req, res) => {
  res.status(200).json(getMetrics());
});

app.post('/webhook/telegram', rateLimit, dedup, async (req, res) => {
  if (!verifyWebhook(req)) {
    return res.status(403).send('Unauthorized');
  }

  // Return 200 immediately to Telegram
  res.status(200).send('OK');

  // Process asynchronously
  try {
    const parsed = parseIncoming(req.body);
    if (parsed) {
      incrementMetric('messagesReceived');
      const ctx = { chatId: String(parsed.chatId) };
      logInfo(ctx, 'webhook_received', { messageType: parsed.type });

      let textInput = '';
      let isVoice = false;

      if (parsed.type === 'callback_query') {
        await answerCallbackQuery(parsed.callbackQueryId);
        textInput = parsed.data;
      } else if (parsed.type === 'message' && parsed.audio) {
        try {
          const start = Date.now();
          incrementMetric('whisperCalls');
          const audioBuffer = await downloadAudio(parsed.audio.file_id);
          textInput = await transcribeAudio(audioBuffer);
          isVoice = true;
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

      const auth = await authenticateUser(parsed.chatId);

      if (auth.status === 'onboarding') {
        await handleOnboarding(parsed.chatId, textInput);
        return;
      }

      if (auth.status === 'reauth_pending') {
        const res = await verifyOTP(parsed.chatId, textInput);
        if (res.valid) {
          const userRes = await pool.query('SELECT kitchen_id, role FROM user_profiles WHERE phone = $1', [String(parsed.chatId)]);
          if (userRes.rows.length > 0) {
            await createSession(parsed.chatId, userRes.rows[0].kitchen_id, userRes.rows[0].role);
            await redis.del(`reauth:${parsed.chatId}`);
            await sendText(parsed.chatId, 'Verified! Ab baat karo.');
            incrementMetric('messagesSent');
          } else {
            await redis.del(`reauth:${parsed.chatId}`);
            await handleOnboarding(parsed.chatId, textInput);
          }
        } else if (res.reason === 'wrong_code') {
          await sendText(parsed.chatId, `Galat code. ${res.remaining} tries baaki.`);
          incrementMetric('messagesSent');
        } else if (res.reason === 'expired') {
          await sendText(parsed.chatId, `Code expired.`);
          incrementMetric('messagesSent');
        } else {
          await sendText(parsed.chatId, `Bahut zyada galat attempts. 15 min baad try karo.`);
          incrementMetric('messagesSent');
        }
        return;
      }

      if (auth.status === 'reauth_required') {
        return;
      }

      if (auth.status === 'unknown') {
        await handleOnboarding(parsed.chatId, textInput);
        return;
      }

      if (auth.status === 'authenticated') {
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
