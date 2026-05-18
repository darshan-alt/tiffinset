// src/middleware/dedup.js — Message deduplication via Redis SET NX
import { getRedis } from '../db/redis.js';

const DEDUP_TTL = 300; // 5 minutes

/**
 * Check and mark a message ID as seen.
 * Returns true if this is a NEW (non-duplicate) message.
 * Returns false if duplicate — caller should skip processing.
 * Fails open on Redis error.
 */
export async function checkDedup(messageId) {
  if (!messageId) return true; // no ID = can't dedup, allow through

  try {
    const redis = getRedis();
    const key = `tiffinset:msg:${messageId}`;
    // SET NX returns 1 if set (new), null if key existed (duplicate)
    const result = await redis.set(key, '1', 'EX', DEDUP_TTL, 'NX');
    return result !== null; // true = new message
  } catch (err) {
    // Fail open — prefer processing over blocking
    console.error('[Dedup] Redis error, failing open:', err.message);
    return true;
  }
}
