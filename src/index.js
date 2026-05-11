import express from 'express';
import config, { initConfig } from './config.js';
import pool from './db/pool.js';
import redis from './db/redis.js';
import { verifyWebhook, parseIncoming, answerCallbackQuery } from './transport/index.js';
import rateLimit from './middleware/rateLimit.js';
import dedup from './middleware/dedup.js';

const app = express();
app.use(express.json());

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.status(200).json({ status: 'ok', db: 'up', redis: 'up' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
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
      console.log('Parsed Telegram Update:', JSON.stringify(parsed, null, 2));
      
      if (parsed.type === 'callback_query') {
        await answerCallbackQuery(parsed.callbackQueryId);
      }
      // TODO: Pass to agent logic
    }
  } catch (error) {
    console.error('Error processing webhook:', error);
  }
});

const PORT = process.env.PORT || 3000;

async function start() {
  await initConfig();
  app.listen(PORT, () => {
    console.log(`TiffinSet server running on port ${PORT}`);
  });
}

start().catch(console.error);
