// src/db/redis.js — ioredis client singleton
import Redis from 'ioredis';
import { config } from '../config.js';

let _redis = null;

export function getRedis() {
  if (!_redis) {
    _redis = new Redis(config.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    _redis.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });

    _redis.on('connect', () => {
      process.stdout.write('[Redis] Connected\n');
    });
  }
  return _redis;
}

export async function checkRedis() {
  const redis = getRedis();
  await redis.ping();
}

export default { getRedis, checkRedis };
