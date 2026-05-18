// src/middleware/logger.js — Structured JSON logging + Redis-backed metrics
import { getRedis } from '../db/redis.js';

const METRIC_PREFIX = 'tiffinset:metric:';

export function logInfo(context, event, data = {}) {
  console.log(JSON.stringify({
    level: 'info',
    ts: new Date().toISOString(),
    context,
    event,
    ...data,
  }));
}

export function logError(context, event, error, data = {}) {
  console.error(JSON.stringify({
    level: 'error',
    ts: new Date().toISOString(),
    context,
    event,
    error: error?.message || String(error),
    stack: error?.stack,
    ...data,
  }));
  // fire-and-forget metric increment
  incrementMetric('errors').catch(() => {});
}

export function incrementMetric(name, n = 1) {
  try {
    const redis = getRedis();
    return redis.incrby(`${METRIC_PREFIX}${name}`, n);
  } catch {
    return Promise.resolve();
  }
}

export async function getMetrics() {
  const redis = getRedis();
  const names = [
    'messagesReceived',
    'messagesSent',
    'whisperCalls',
    'geminiCalls',
    'errors',
    'ordersPlaced',
  ];
  const values = await Promise.all(names.map((n) => redis.get(`${METRIC_PREFIX}${n}`)));
  const result = {};
  names.forEach((n, i) => {
    result[n] = parseInt(values[i] || '0', 10);
  });
  return result;
}
