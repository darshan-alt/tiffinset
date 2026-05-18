// src/middleware/auth.js — User authentication middleware
import { getRedis } from '../db/redis.js';
import { query } from '../db/pool.js';
import { createSession, checkSession } from '../kitchen/auth.js';

/**
 * Determine the authentication status of a chatId.
 * Returns: { status: 'onboarding'|'authenticated'|'unknown', kitchenId?, role? }
 */
export async function authenticateUser(chatId) {
  const redis = getRedis();

  // 1. Check if in onboarding flow
  const onboardingKey = `onboarding:${chatId}`;
  const onboardingState = await redis.get(onboardingKey);
  if (onboardingState) {
    return { status: 'onboarding' };
  }

  // 2. Check Redis session
  const session = await checkSession(chatId);
  if (session.valid) {
    return { status: 'authenticated', kitchenId: session.kitchenId, role: session.role };
  }

  // 3. Check if expired (30-day inactivity)
  if (session.reason === 'expired') {
    return { status: 'unknown' };
  }

  // 4. Check Postgres — maybe session was cleared but user exists
  try {
    const result = await query(
      'SELECT kitchen_id, role FROM user_profiles WHERE phone = $1 AND is_verified = true',
      [chatId]
    );
    if (result.rows.length > 0) {
      const { kitchen_id, role } = result.rows[0];
      // Restore session
      await createSession(chatId, kitchen_id, role);
      return { status: 'authenticated', kitchenId: kitchen_id, role };
    }
  } catch (err) {
    console.error('[Auth] DB lookup error:', err.message);
  }

  return { status: 'unknown' };
}
