import redis from '../db/redis.js';
import pool from '../db/pool.js';
import { checkSession, createSession } from '../kitchen/auth.js';

export async function authenticateUser(chatId) {
  const onboardingExists = await redis.exists(`onboarding:${chatId}`);
  if (onboardingExists) {
    return { status: 'onboarding' };
  }

  const session = await checkSession(chatId);
  if (session.valid) {
    return { status: 'authenticated', kitchenId: session.kitchenId, role: session.role };
  }

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
