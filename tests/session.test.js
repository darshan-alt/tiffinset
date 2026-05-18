// tests/session.test.js — Session management tests
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

jest.unstable_mockModule('ioredis', () => {
  const RedisMock = require('ioredis-mock');
  return { default: RedisMock };
});

jest.unstable_mockModule('../src/config.js', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  initConfig: jest.fn(),
}));

jest.unstable_mockModule('../src/transport/index.js', () => ({
  sendText: jest.fn().mockResolvedValue({}),
  default: { sendText: jest.fn() },
}));

describe('Session management', () => {
  let createSession, checkSession, refreshSession, destroySession;

  beforeEach(async () => {
    jest.resetModules();
    const mod = await import('../src/kitchen/auth.js');
    createSession = mod.createSession;
    checkSession = mod.checkSession;
    refreshSession = mod.refreshSession;
    destroySession = mod.destroySession;
  });

  it('should create and check a valid session', async () => {
    const chatId = `sess_${Date.now()}`;
    await createSession(chatId, 'kitchen_12345678', 'owner');
    const result = await checkSession(chatId);
    expect(result.valid).toBe(true);
    expect(result.kitchenId).toBe('kitchen_12345678');
    expect(result.role).toBe('owner');
  });

  it('should return not_found for non-existent session', async () => {
    const chatId = `sess_nonexistent_${Date.now()}`;
    const result = await checkSession(chatId);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('should mark session as expired after 30+ days of inactivity', async () => {
    const chatId = `sess_expired_${Date.now()}`;
    // Manually create a session with old lastActive
    const { getRedis } = await import('../src/db/redis.js');
    const redis = getRedis();
    const thirtyOneDaysAgo = Date.now() - (31 * 24 * 60 * 60 * 1000);
    await redis.set(`session:${chatId}`, JSON.stringify({
      kitchenId: 'kitchen_abc',
      role: 'cook',
      lastActive: thirtyOneDaysAgo,
    }), 'EX', 86400 * 31);

    const result = await checkSession(chatId);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('should refresh session and keep it valid', async () => {
    const chatId = `sess_refresh_${Date.now()}`;
    await createSession(chatId, 'kitchen_refresh', 'contributor');
    await refreshSession(chatId);
    const result = await checkSession(chatId);
    expect(result.valid).toBe(true);
  });

  it('should destroy a session', async () => {
    const chatId = `sess_destroy_${Date.now()}`;
    await createSession(chatId, 'kitchen_destroy', 'owner');
    await destroySession(chatId);
    const result = await checkSession(chatId);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('not_found');
  });
});
