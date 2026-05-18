// src/middleware/rateLimit.js — 20 requests/min per chatId via Redis
import { getRedis } from '../db/redis.js';
import { logInfo } from './logger.js';

const MAX_REQUESTS = 20;
const WINDOW_SECONDS = 60;

/**
 * Check if chatId is within rate limit.
 * Returns true if allowed, false if throttled.
 * Fails open on Redis error.
 */
export async function checkRateLimit(chatId) {
  try {
    const redis = getRedis();
    const key = `ratelimit:${chatId}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, WINDOW_SECONDS);
    }
    if (count > MAX_REQUESTS) {
      logInfo('rateLimit', 'throttled', { chatId, count });
      return false;
    }
    return true;
  } catch (err) {
    // Fail open — prefer processing over blocking
    console.error('[RateLimit] Redis error, failing open:', err.message);
    return true;
  }
}
