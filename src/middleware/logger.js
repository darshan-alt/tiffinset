// ── Structured JSON Logger + In-Memory Metrics ─────────────────────

const startTime = Date.now();

// In-memory counters
const counters = {
  messagesReceived: 0,
  messagesSent: 0,
  whisperCalls: 0,
  geminiCalls: 0,
  errors: 0,
  ordersPlaced: 0,
};

/**
 * Log a structured info event.
 * @param {{ chatId?: string, kitchenId?: string, role?: string }} context
 * @param {string} event  – event name, e.g. 'webhook_received'
 * @param {object} data   – arbitrary payload fields
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
 * @param {{ chatId?: string, kitchenId?: string, role?: string }} context
 * @param {string} event  – event name, e.g. 'webhook_error'
 * @param {Error} error
 */
export function logError(context, event, error) {
  counters.errors++;
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
 * Increment a named counter.
 * @param {'messagesReceived'|'messagesSent'|'whisperCalls'|'geminiCalls'|'errors'|'ordersPlaced'} name
 * @param {number} n – amount to add (default 1)
 */
export function incrementMetric(name, n = 1) {
  if (name in counters) {
    counters[name] += n;
  }
}

/**
 * Return current counters + uptime.
 */
export function getMetrics() {
  return {
    ...counters,
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
  };
}
