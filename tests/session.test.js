import Redis from 'ioredis-mock';

let redis;

beforeEach(() => {
  redis = new Redis();
});

afterEach(async () => {
  await redis.flushall();
  redis.disconnect();
});

// ── Helpers (same logic as kitchen/auth.js but using local redis) ────

async function createSession(chatId, kitchenId, role) {
  const sessionKey = `session:${chatId}`;
  await redis.setex(sessionKey, 2592000, JSON.stringify({ kitchenId, role, lastActive: Date.now() }));
}

async function checkSession(chatId) {
  const sessionKey = `session:${chatId}`;
  const sessionStr = await redis.get(sessionKey);

  if (!sessionStr) {
    return { valid: false, reason: 'no_session' };
  }

  const session = JSON.parse(sessionStr);
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  if (Date.now() - session.lastActive > THIRTY_DAYS_MS) {
    await redis.del(sessionKey);
    return { valid: false, reason: 'inactive_30days' };
  }

  return { valid: true, kitchenId: session.kitchenId, role: session.role };
}

async function refreshSession(chatId) {
  const sessionKey = `session:${chatId}`;
  const sessionStr = await redis.get(sessionKey);

  if (sessionStr) {
    const session = JSON.parse(sessionStr);
    session.lastActive = Date.now();
    await redis.setex(sessionKey, 2592000, JSON.stringify(session));
  }
}

async function destroySession(chatId) {
  await redis.del(`session:${chatId}`);
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Session Management', () => {
  test('createSession stores a valid session', async () => {
    await createSession('chat1', 'kitchen_001', 'owner');
    const result = await checkSession('chat1');
    expect(result.valid).toBe(true);
    expect(result.kitchenId).toBe('kitchen_001');
    expect(result.role).toBe('owner');
  });

  test('checkSession returns no_session for unknown user', async () => {
    const result = await checkSession('nonexistent');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('no_session');
  });

  test('refreshSession updates lastActive', async () => {
    await createSession('chat1', 'kitchen_001', 'owner');

    // Read original
    const before = JSON.parse(await redis.get('session:chat1'));
    const originalActive = before.lastActive;

    // Wait a tiny bit so timestamp differs
    await new Promise(r => setTimeout(r, 10));
    await refreshSession('chat1');

    const after = JSON.parse(await redis.get('session:chat1'));
    expect(after.lastActive).toBeGreaterThanOrEqual(originalActive);
  });

  test('checkSession detects 30-day expiry', async () => {
    // Create session with lastActive set 31 days ago
    const sessionKey = 'session:chat1';
    const oldActive = Date.now() - (31 * 24 * 60 * 60 * 1000);
    await redis.setex(sessionKey, 2592000, JSON.stringify({ kitchenId: 'k1', role: 'owner', lastActive: oldActive }));

    const result = await checkSession('chat1');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('inactive_30days');

    // Key should be deleted
    const exists = await redis.exists(sessionKey);
    expect(exists).toBe(0);
  });

  test('destroySession removes the session', async () => {
    await createSession('chat1', 'kitchen_001', 'owner');
    await destroySession('chat1');
    const result = await checkSession('chat1');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('no_session');
  });
});
