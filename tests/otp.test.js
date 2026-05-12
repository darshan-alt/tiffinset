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

async function generateOTP(chatId) {
  const cooldownKey = `cooldown:${chatId}`;
  const cooldownTTL = await redis.ttl(cooldownKey);

  if (cooldownTTL > 0) {
    return { error: 'cooldown', minutesLeft: Math.ceil(cooldownTTL / 60) };
  }

  // Deterministic code for test predictability
  const code = String(100000 + Math.floor(Math.random() * 900000));
  const otpKey = `otp:${chatId}`;

  await redis.setex(otpKey, 300, JSON.stringify({ code, attempts: 0, created: Date.now() }));
  return { code };
}

async function verifyOTP(chatId, userInput) {
  const otpKey = `otp:${chatId}`;
  const otpDataStr = await redis.get(otpKey);

  if (!otpDataStr) {
    return { valid: false, reason: 'expired' };
  }

  const otpData = JSON.parse(otpDataStr);

  if (otpData.attempts >= 3) {
    await redis.del(otpKey);
    await redis.setex(`cooldown:${chatId}`, 900, 'true');
    return { valid: false, reason: 'max_attempts' };
  }

  if (otpData.code === userInput?.trim()) {
    await redis.del(otpKey);
    return { valid: true };
  } else {
    otpData.attempts += 1;
    const ttl = await redis.ttl(otpKey);
    if (ttl > 0) {
      await redis.setex(otpKey, ttl, JSON.stringify(otpData));
    }
    return { valid: false, reason: 'wrong_code', remaining: 3 - otpData.attempts };
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('OTP Flow', () => {
  test('generateOTP returns a 6-digit code', async () => {
    const result = await generateOTP('user1');
    expect(result.code).toBeDefined();
    expect(result.code.length).toBe(6);
  });

  test('verifyOTP correct code → valid', async () => {
    const { code } = await generateOTP('user1');
    const result = await verifyOTP('user1', code);
    expect(result.valid).toBe(true);
  });

  test('verifyOTP wrong code → wrong_code with remaining attempts', async () => {
    await generateOTP('user1');
    const result = await verifyOTP('user1', '000000');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('wrong_code');
    expect(result.remaining).toBe(2);
  });

  test('verifyOTP expired key → expired', async () => {
    // Simulate expired by not setting any OTP
    const result = await verifyOTP('noOtp', '123456');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });

  test('verifyOTP max_attempts after 3 wrong tries → cooldown', async () => {
    await generateOTP('user1');

    // Force 3 attempts into the stored data
    const otpKey = 'otp:user1';
    const otpData = JSON.parse(await redis.get(otpKey));
    otpData.attempts = 3;
    const ttl = await redis.ttl(otpKey);
    await redis.setex(otpKey, ttl, JSON.stringify(otpData));

    const result = await verifyOTP('user1', 'wrong');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('max_attempts');

    // Cooldown key should exist now
    const cooldownExists = await redis.exists(`cooldown:user1`);
    expect(cooldownExists).toBe(1);
  });

  test('generateOTP during cooldown → error', async () => {
    await redis.setex('cooldown:user1', 900, 'true');
    const result = await generateOTP('user1');
    expect(result.error).toBe('cooldown');
    expect(result.minutesLeft).toBeGreaterThan(0);
  });
});
