import redis from '../db/redis.js';

export default async function rateLimit(req, res, next) {
  const body = req.body;
  const chatId = body.message?.chat?.id || body.callback_query?.message?.chat?.id;

  if (!chatId) return next();

  const key = `ratelimit:${chatId}`;
  const current = await redis.incr(key);

  if (current === 1) {
    await redis.expire(key, 60);
  }

  if (current > 20) {
    return res.status(429).send('Too Many Requests');
  }

  next();
}
