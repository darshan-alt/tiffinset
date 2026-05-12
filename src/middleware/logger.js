// ── Structured JSON Logger + Redis-Backed Metrics ──────────────────
import redis from '../db/redis.js';

const startTime = Date.now();
const METRIC_PREFIX = 'tiffinset:metric:';

const METRIC_NAMES = [
  'messagesReceived',
  'messagesSent',
  'whisperCalls',
  'geminiCalls',
  'errors',
  'ordersPlaced',
];

/**
 * Log a structured info event.
 */
export function logInfo(context, event, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: 'info',
    kitchen_id: context?.kitchenId || context?.kitchen_id || null,
    chatId: context?.chatId || null,
    role: context?.role || null,
    event,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

/**
 * Log a structured error event.
 */
export function logError(context, event, error) {
  incrementMetric('errors');
  const entry = {
    timestamp: new Date().toISOString(),
    level: 'error',
    kitchen_id: context?.kitchenId || context?.kitchen_id || null,
    chatId: context?.chatId || null,
    role: context?.role || null,
    event,
    error: error?.message || String(error),
    stack: error?.stack || null,
  };
  console.error(JSON.stringify(entry));
}

/**
 * Increment a named counter in Redis (shared across PM2 workers).
 * Fire-and-forget — never blocks the caller, never throws.
 */
export function incrementMetric(name, n = 1) {
  if (!METRIC_NAMES.includes(name)) return;
  redis.incrby(`${METRIC_PREFIX}${name}`, n).catch(() => {});
}

/**
 * Return aggregated counters + uptime.
 */
export async function getMetrics() {
  const result = { uptimeSeconds: Math.floor((Date.now() - startTime) / 1000) };
  try {
    const values = await Promise.all(
      METRIC_NAMES.map((name) => redis.get(`${METRIC_PREFIX}${name}`))
    );
    METRIC_NAMES.forEach((name, i) => {
      result[name] = Number(values[i]) || 0;
    });
  } catch (err) {
    for (const name of METRIC_NAMES) result[name] = 0;
    result.metricsError = err.message;
  }
  return result;
}
