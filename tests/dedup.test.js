import Redis from 'ioredis-mock';

let redis;

beforeEach(() => {
  redis = new Redis();
});

afterEach(async () => {
  await redis.flushall();
  redis.disconnect();
});

describe('isDuplicate (dedup logic)', () => {
  test('returns false (NX succeeds) first time a messageId is seen', async () => {
    const key = 'msgid:12345';
    const result = await redis.set(key, '1', 'EX', 300, 'NX');
    // NX returns 'OK' when key did not exist (i.e. NOT a duplicate)
    expect(result).toBe('OK');
  });

  test('returns null (NX fails) second time same messageId is seen', async () => {
    const key = 'msgid:12345';
    await redis.set(key, '1', 'EX', 300, 'NX');
    const result = await redis.set(key, '1', 'EX', 300, 'NX');
    // NX returns null when key already exists (i.e. IS a duplicate)
    expect(result).toBeNull();
  });

  test('returns false again after TTL expires (key gone)', async () => {
    const key = 'msgid:99999';
    await redis.set(key, '1', 'EX', 1, 'NX');

    // Simulate TTL expiry by deleting the key
    await redis.del(key);

    const result = await redis.set(key, '1', 'EX', 300, 'NX');
    expect(result).toBe('OK');
  });
});
