import crypto from 'crypto';
import redis from '../db/redis.js';

export async function generateOTP(chatId) {
  const cooldownKey = `cooldown:${chatId}`;
  const cooldownTTL = await redis.ttl(cooldownKey);
  
  if (cooldownTTL > 0) {
    return { error: 'cooldown', minutesLeft: Math.ceil(cooldownTTL / 60) };
  }

  const code = crypto.randomInt(100000, 999999).toString();
  const otpKey = `otp:${chatId}`;
  
  await redis.setex(otpKey, 300, JSON.stringify({ code, attempts: 0, created: Date.now() }));
  return { code };
}

export async function verifyOTP(chatId, userInput) {
  const otpKey = `otp:${chatId}`;
  const otpDataStr = await redis.get(otpKey);
  
  if (!otpDataStr) {
    return { valid: false, reason: 'expired' };
  }

  const otpData = JSON.parse(otpDataStr);
  
  if (otpData.attempts >= 3) {
    await redis.del(otpKey);
    await redis.setex(`cooldown:${chatId}`, 900, 'true'); // 15 min cooldown
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

export async function createSession(chatId, kitchenId, role) {
  const sessionKey = `session:${chatId}`;
  await redis.setex(sessionKey, 2592000, JSON.stringify({ kitchenId, role, lastActive: Date.now() })); // 30 days
}

export async function checkSession(chatId) {
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

export async function refreshSession(chatId) {
  const sessionKey = `session:${chatId}`;
  const sessionStr = await redis.get(sessionKey);
  
  if (sessionStr) {
    const session = JSON.parse(sessionStr);
    session.lastActive = Date.now();
    await redis.setex(sessionKey, 2592000, JSON.stringify(session));
  }
}

export async function destroySession(chatId) {
  await redis.del(`session:${chatId}`);
}
