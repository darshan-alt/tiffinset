import redis from '../db/redis.js';

export default async function dedup(req, res, next) {
  const body = req.body;
  const messageId = body.message?.message_id || body.callback_query?.id;

  if (!messageId) return next();

  const key = `msgid:${messageId}`;
  const isDuplicate = await redis.set(key, '1', 'EX', 300, 'NX');

  if (!isDuplicate) {
    console.log(`Duplicate message detected: ${messageId}`);
    return res.status(200).send('Duplicate');
  }

  next();
}
