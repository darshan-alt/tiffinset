import redis from '../db/redis.js';
import { checkSession, generateOTP } from '../kitchen/auth.js';
import { sendText } from '../transport/index.js';

export async function authenticateUser(chatId) {
  const onboardingExists = await redis.exists(`onboarding:${chatId}`);
  if (onboardingExists) {
    return { status: 'onboarding' };
  }

  const reauthExists = await redis.exists(`reauth:${chatId}`);
  if (reauthExists) {
    return { status: 'reauth_pending' };
  }

  const session = await checkSession(chatId);
  if (session.valid) {
    return { status: 'authenticated', kitchenId: session.kitchenId, role: session.role };
  } else if (session.reason === 'inactive_30days') {
    const otpResult = await generateOTP(chatId);
    if (!otpResult.error) {
      await sendText(chatId, `Aap kaafi din se active nahi the. Verify karo: ${otpResult.code}`);
      await redis.setex(`reauth:${chatId}`, 600, 'pending');
    }
    return { status: 'reauth_required' };
  } else {
    return { status: 'unknown' };
  }
}

export async function requireHighValueAuth(chatId, total, threshold = 500) {
  if (total <= threshold) {
    return { status: 'approved' };
  }

  const otpResult = await generateOTP(chatId);
  if (otpResult.error) {
     return { status: 'otp_required', error: otpResult.error, minutesLeft: otpResult.minutesLeft };
  }
  
  await sendText(chatId, `Order Rs ${total} ka hai. Confirm karne ke liye OTP bhejo: ${otpResult.code}`);
  await redis.setex(`pending_order:${chatId}`, 600, JSON.stringify({ total, timestamp: Date.now() }));
  
  return { status: 'otp_required' };
}
