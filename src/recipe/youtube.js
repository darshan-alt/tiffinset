// src/recipe/youtube.js — YouTube video search with 3-tier cache (Redis → Postgres → API)
import fetch from 'node-fetch';
import { getRedis } from '../db/redis.js';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { logInfo, logError } from '../middleware/logger.js';

const VIDEO_TTL_SECONDS = 48 * 60 * 60; // 48 hours
const VIDEO_TTL_MS = VIDEO_TTL_SECONDS * 1000;

/**
 * Search for a YouTube cooking video.
 * 3-tier cache: Redis → Postgres → YouTube API
 * Returns video object or null on quota exceeded / not found.
 */
export async function searchVideo(dishName, language = 'hi') {
  const normalizedDish = dishName.toLowerCase().trim();
  const lang = language === 'hi' ? 'hi' : 'en';
  const redisKey = `video:${normalizedDish}:${lang}`;

  // Tier 1: Redis
  try {
    const redis = getRedis();
    const cached = await redis.get(redisKey);
    if (cached) {
      logInfo('youtube', 'cache_hit_redis', { dish: normalizedDish, lang });
      return JSON.parse(cached);
    }
  } catch (err) {
    logError('youtube', 'redis_read_error', err);
  }

  // Tier 2: Postgres
  try {
    const pgResult = await query(
      `SELECT video_id, url, title, channel, thumbnail
       FROM youtube_video_cache
       WHERE dish_name = $1 AND language = $2 AND expires_at > NOW()`,
      [normalizedDish, lang]
    );
    if (pgResult.rows.length > 0) {
      const video = pgResult.rows[0];
      logInfo('youtube', 'cache_hit_postgres', { dish: normalizedDish, lang });
      // Backfill Redis
      _cacheInRedis(redisKey, video).catch(() => {});
      return video;
    }
  } catch (err) {
    logError('youtube', 'postgres_read_error', err);
  }

  // Tier 3: YouTube Data API v3
  return _fetchFromYouTube(normalizedDish, lang, redisKey);
}

async function _fetchFromYouTube(dishName, lang, redisKey) {
  if (!config.YOUTUBE_API_KEY) {
    logInfo('youtube', 'no_api_key');
    return null;
  }

  const langWord = lang === 'hi' ? 'Hindi' : 'English';
  const q = encodeURIComponent(`${dishName} recipe ${langWord}`);
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${q}&maxResults=3&type=video&key=${config.YOUTUBE_API_KEY}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      if (data.error.code === 403 || data.error.errors?.some((e) => e.reason === 'quotaExceeded')) {
        logInfo('youtube', 'quota_exceeded');
        return null;
      }
      throw new Error(`YouTube API error: ${data.error.message}`);
    }

    if (!data.items || data.items.length === 0) {
      return null;
    }

    const item = data.items[0];
    const video = {
      video_id: item.id.videoId,
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.default?.url || '',
    };

    logInfo('youtube', 'fetched_from_api', { dish: dishName, lang, videoId: video.video_id });

    // Cache in both Redis and Postgres
    await Promise.all([
      _cacheInRedis(redisKey, video),
      _cacheInPostgres(dishName, lang, video),
    ]).catch((err) => logError('youtube', 'cache_write_error', err));

    return video;
  } catch (err) {
    logError('youtube', 'api_fetch_error', err);
    return null;
  }
}

async function _cacheInRedis(key, video) {
  const redis = getRedis();
  await redis.set(key, JSON.stringify(video), 'EX', VIDEO_TTL_SECONDS);
}

async function _cacheInPostgres(dishName, lang, video) {
  const expiresAt = new Date(Date.now() + VIDEO_TTL_MS).toISOString();
  await query(
    `INSERT INTO youtube_video_cache (dish_name, language, video_id, url, title, channel, thumbnail, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (dish_name, language) DO UPDATE
       SET video_id=$3, url=$4, title=$5, channel=$6, thumbnail=$7, expires_at=$8`,
    [dishName, lang, video.video_id, video.url, video.title, video.channel, video.thumbnail, expiresAt]
  );
}
