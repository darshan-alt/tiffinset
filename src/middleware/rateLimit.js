import redis from '../db/redis.js';
import { logError } from './logger.js';

export default async function rateLimit(req, res, next) {
  const body = req.body;
  const chatId = body.message?.chat?.id || body.callback_query?.message?.chat?.id;

  if (!chatId) return next();

  try {
    const key = `ratelimit:${chatId}`;
    const current = await redis.incr(key);

    if (current === 1) {
      await redis.expire(key, 60);
    }

    if (current > 20) {
      return res.status(429).send('Too Many Requests');
    }
  } catch (err) {
    // Fail open — prefer processing over blocking when Redis is unavailable.
    logError({ chatId: String(chatId) }, 'ratelimit_redis_error', err);
  }

  next();
}
