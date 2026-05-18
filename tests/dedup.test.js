// tests/dedup.test.js — Deduplication middleware tests
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Mock ioredis with ioredis-mock (must be sync in jest factory)
jest.unstable_mockModule('ioredis', () => {
  const RedisMock = require('ioredis-mock');
  return { default: RedisMock };
});

jest.unstable_mockModule('../src/config.js', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  initConfig: jest.fn(),
}));

describe('Deduplication middleware', () => {
  let checkDedup;

  beforeEach(async () => {
    jest.resetModules();
    const mod = await import('../src/middleware/dedup.js');
    checkDedup = mod.checkDedup;
  });

  it('should allow a new message through', async () => {
    const result = await checkDedup('msg_unique_123');
    expect(result).toBe(true);
  });

  it('should block a duplicate message', async () => {
    const msgId = 'msg_duplicate_456';
    const first = await checkDedup(msgId);
    const second = await checkDedup(msgId);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('should allow through when messageId is null (fail open)', async () => {
    const result = await checkDedup(null);
    expect(result).toBe(true);
  });

  it('should handle different message IDs independently', async () => {
    const r1 = await checkDedup('msg_a');
    const r2 = await checkDedup('msg_b');
    expect(r1).toBe(true);
    expect(r2).toBe(true);
  });
});
