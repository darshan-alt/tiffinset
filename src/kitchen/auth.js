// src/kitchen/auth.js — OTP generation, session management
import { getRedis } from '../db/redis.js';
import { sendText } from '../transport/index.js';

const OTP_TTL = 300;          // 5 minutes
const OTP_MAX_ATTEMPTS = 3;
const COOLDOWN_TTL = 900;     // 15 minutes
const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

// ─── OTP ────────────────────────────────────────────────────────────────────

/**
 * Generate a 6-digit OTP and store it in Redis.
 * Returns the OTP code (for sending).
 */
export async function generateOTP(chatId) {
  const redis = getRedis();

  // Check cooldown
  const cooldown = await redis.get(`cooldown:${chatId}`);
  if (cooldown) {
    const ttl = await redis.ttl(`cooldown:${chatId}`);
    return { error: 'cooldown', remainingSeconds: ttl };
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const otpData = { code, attempts: 0, created: Date.now() };
  await redis.set(`otp:${chatId}`, JSON.stringify(otpData), 'EX', OTP_TTL);
  return { code };
}

/**
 * Verify an OTP code for a chatId.
 * Returns: { valid: true } or { valid: false, reason }
 */
export async function verifyOTP(chatId, input) {
  const redis = getRedis();

  // Check cooldown
  const cooldown = await redis.get(`cooldown:${chatId}`);
  if (cooldown) {
    const ttl = await redis.ttl(`cooldown:${chatId}`);
    return { valid: false, reason: 'cooldown', remainingSeconds: ttl };
  }

  const raw = await redis.get(`otp:${chatId}`);
  if (!raw) {
    return { valid: false, reason: 'expired' };
  }

  const otpData = JSON.parse(raw);
  otpData.attempts += 1;

  if (String(input).trim() === String(otpData.code)) {
    await redis.del(`otp:${chatId}`);
    return { valid: true };
  }

  if (otpData.attempts >= OTP_MAX_ATTEMPTS) {
    await redis.del(`otp:${chatId}`);
    await redis.set(`cooldown:${chatId}`, '1', 'EX', COOLDOWN_TTL);
    return { valid: false, reason: 'max_attempts' };
  }

  // Update attempt count
  const remaining = OTP_MAX_ATTEMPTS - otpData.attempts;
  await redis.set(`otp:${chatId}`, JSON.stringify(otpData), 'EX', OTP_TTL);
  return { valid: false, reason: 'wrong_code', attemptsRemaining: remaining };
}

/**
 * Send an OTP to a user via transport.
 */
export async function sendOTP(chatId, code) {
  await sendText(chatId, `Your TiffinSet verification code is: *${code}*\n\nValid for 5 minutes.`);
}

// ─── Sessions ────────────────────────────────────────────────────────────────

/**
 * Create a Redis session for an authenticated user.
 */
export async function createSession(chatId, kitchenId, role) {
  const redis = getRedis();
  const session = {
    kitchenId,
    role,
    lastActive: Date.now(),
  };
  await redis.set(`session:${chatId}`, JSON.stringify(session), 'EX', SESSION_TTL);
}

/**
 * Check if a session is valid.
 * Returns: { valid: true, kitchenId, role } or { valid: false, reason }
 */
export async function checkSession(chatId) {
  const redis = getRedis();
  const raw = await redis.get(`session:${chatId}`);

  if (!raw) return { valid: false, reason: 'not_found' };

  const session = JSON.parse(raw);

  // 30-day inactivity check
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  if (Date.now() - session.lastActive > thirtyDaysMs) {
    await redis.del(`session:${chatId}`);
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, kitchenId: session.kitchenId, role: session.role };
}

/**
 * Refresh session lastActive and reset TTL.
 */
export async function refreshSession(chatId) {
  try {
    const redis = getRedis();
    const raw = await redis.get(`session:${chatId}`);
    if (!raw) return;

    const session = JSON.parse(raw);
    session.lastActive = Date.now();
    await redis.set(`session:${chatId}`, JSON.stringify(session), 'EX', SESSION_TTL);
  } catch (err) {
    console.error('[Auth] refreshSession error:', err.message);
  }
}

/**
 * Destroy a session (logout).
 */
export async function destroySession(chatId) {
  const redis = getRedis();
  await redis.del(`session:${chatId}`);
}
