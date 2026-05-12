import redis from '../db/redis.js';
import pool from '../db/pool.js';
import config from '../config.js';

const REDIS_TTL = 172800; // 48 hours in seconds

/**
 * Search for a recipe video on YouTube with 3-tier caching:
 *   1. Redis cache  →  2. PostgreSQL cache  →  3. YouTube Data API v3
 *
 * @param {string} dishName  – dish to search for
 * @param {string} language  – 'hi' | 'en'
 * @returns {object|null}    – { videoId, url, title, channel, thumbnail } or null on failure
 */
export async function searchVideo(dishName, language = 'hi') {
  const redisKey = `video:${dishName}:${language}`;

  // ── 1. Redis cache ────────────────────────────────────────────────
  try {
    const cached = await redis.get(redisKey);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (err) {
    console.warn('[youtube] Redis GET error, continuing:', err.message);
  }

  // ── 2. PostgreSQL cache ───────────────────────────────────────────
  try {
    const dbRes = await pool.query(
      `SELECT video_id, url, title, channel, thumbnail
       FROM youtube_video_cache
       WHERE dish_name = $1 AND language = $2 AND expires_at > NOW()`,
      [dishName, language]
    );

    if (dbRes.rows.length > 0) {
      const row = dbRes.rows[0];
      const result = {
        videoId: row.video_id,
        url: row.url,
        title: row.title,
        channel: row.channel,
        thumbnail: row.thumbnail,
      };

      // Backfill Redis
      try {
        await redis.setex(redisKey, REDIS_TTL, JSON.stringify(result));
      } catch (err) {
        console.warn('[youtube] Redis SETEX error (backfill):', err.message);
      }

      return result;
    }
  } catch (err) {
    console.warn('[youtube] PostgreSQL cache lookup error:', err.message);
  }

  // ── 3. YouTube Data API v3 ────────────────────────────────────────
  const langLabel = language === 'hi' ? 'Hindi' : 'English';
  const query = `${dishName} recipe ${langLabel}`;

  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    order: 'relevance',
    maxResults: '3',
    q: query,
    key: config.YOUTUBE_API_KEY,
  });

  let data;
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/search?${params.toString()}`
    );

    if (!res.ok) {
      const body = await res.text();
      // Detect quota exceeded
      if (res.status === 403 && body.includes('quotaExceeded')) {
        console.warn('[youtube] Quota exceeded — returning null');
        return null;
      }
      console.warn(`[youtube] API error ${res.status}: ${body}`);
      return null;
    }

    data = await res.json();
  } catch (err) {
    console.warn('[youtube] Fetch error:', err.message);
    return null;
  }

  if (!data.items || data.items.length === 0) {
    console.warn('[youtube] No results for:', query);
    return null;
  }

  const first = data.items[0];
  const videoId = first.id.videoId;
  const result = {
    videoId,
    url: `https://youtube.com/watch?v=${videoId}`,
    title: first.snippet.title,
    channel: first.snippet.channelTitle,
    thumbnail: first.snippet.thumbnails.high.url,
  };

  // ── Cache in Redis ────────────────────────────────────────────────
  try {
    await redis.setex(redisKey, REDIS_TTL, JSON.stringify(result));
  } catch (err) {
    console.warn('[youtube] Redis SETEX error:', err.message);
  }

  // ── Cache in PostgreSQL ───────────────────────────────────────────
  try {
    await pool.query(
      `INSERT INTO youtube_video_cache (dish_name, language, video_id, url, title, channel, thumbnail, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '48 hours')
       ON CONFLICT (dish_name, language) DO UPDATE SET
         video_id   = EXCLUDED.video_id,
         url        = EXCLUDED.url,
         title      = EXCLUDED.title,
         channel    = EXCLUDED.channel,
         thumbnail  = EXCLUDED.thumbnail,
         expires_at = NOW() + INTERVAL '48 hours'`,
      [dishName, language, result.videoId, result.url, result.title, result.channel, result.thumbnail]
    );
  } catch (err) {
    console.warn('[youtube] PostgreSQL INSERT error:', err.message);
  }

  return result;
}
