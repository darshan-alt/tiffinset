import redis from '../db/redis.js';
import { logInfo } from './logger.js';

export default async function dedup(req, res, next) {
  const body = req.body;
  const messageId = body.message?.message_id || body.callback_query?.id;

  if (!messageId) return next();

  const key = `msgid:${messageId}`;
  try {
    // ioredis returns 'OK' on success with NX, or null if key exists
    const result = await redis.set(key, '1', 'EX', 300, 'NX');

    if (result !== 'OK') {
      logInfo({}, 'duplicate_message_dropped', { messageId, redisResult: result });
      return res.status(200).send('Duplicate');
    }
  } catch (err) {
    // If Redis fails, we prefer processing the message over dropping it
    logError({}, 'dedup_redis_error', err);
  }

  next();
}
