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
  }

  // Check database if no Redis session exists
  const userRes = await pool.query(
    'SELECT kitchen_id, role FROM user_profiles WHERE phone = $1',
    [String(chatId)]
  );

  if (userRes.rows.length > 0) {
    const user = userRes.rows[0];
    await createSession(chatId, user.kitchen_id, user.role);
    return { status: 'authenticated', kitchenId: user.kitchen_id, role: user.role };
  }

  return { status: 'unknown' };
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
