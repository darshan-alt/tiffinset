// tests/otp.test.js — OTP generation and verification tests
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

// Mock transport to avoid real Telegram calls
jest.unstable_mockModule('../src/transport/index.js', () => ({
  sendText: jest.fn().mockResolvedValue({}),
  default: { sendText: jest.fn() },
}));

describe('OTP system', () => {
  let generateOTP, verifyOTP, sendOTP;

  beforeEach(async () => {
    jest.resetModules();
    const mod = await import('../src/kitchen/auth.js');
    generateOTP = mod.generateOTP;
    verifyOTP = mod.verifyOTP;
    sendOTP = mod.sendOTP;
  });

  it('should generate a 6-digit OTP', async () => {
    const chatId = `test_otp_${Date.now()}`;
    const result = await generateOTP(chatId);
    expect(result.code).toBeDefined();
    expect(result.code).toMatch(/^\d{6}$/);
  });

  it('should verify correct OTP', async () => {
    const chatId = `test_verify_${Date.now()}`;
    const { code } = await generateOTP(chatId);
    const result = await verifyOTP(chatId, code);
    expect(result.valid).toBe(true);
  });

  it('should reject wrong OTP and decrement attempts', async () => {
    const chatId = `test_wrong_${Date.now()}`;
    await generateOTP(chatId);
    const result = await verifyOTP(chatId, '000000');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('wrong_code');
    expect(result.attemptsRemaining).toBe(2);
  });

  it('should fail with expired reason if no OTP exists', async () => {
    const chatId = `test_expired_${Date.now()}`;
    const result = await verifyOTP(chatId, '123456');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('should enforce cooldown after 3 wrong attempts', async () => {
    const chatId = `test_cooldown_${Date.now()}`;
    await generateOTP(chatId);
    // 3 wrong attempts
    await verifyOTP(chatId, '000001');
    await verifyOTP(chatId, '000002');
    const thirdWrong = await verifyOTP(chatId, '000003');
    expect(thirdWrong.reason).toBe('max_attempts');

    // Now try again — should get cooldown
    await generateOTP(chatId); // tries to generate but cooldown blocks
    const afterCooldown = await verifyOTP(chatId, '000004');
    expect(afterCooldown.reason).toBe('cooldown');
  });
});
