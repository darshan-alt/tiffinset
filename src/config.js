// src/config.js — Secret Manager loader with .env fallback
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually in dev (no dotenv dependency)
function loadDotEnv() {
  const envPath = resolve(__dirname, '../.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

export const config = {};

export async function initConfig() {
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    loadDotEnv();
    config.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
    config.GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
    config.WHISPER_API_KEY = process.env.WHISPER_API_KEY || '';
    config.YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
    config.WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'tiffinset-verify-2026';
    config.DATABASE_URL = process.env.DATABASE_URL || 'postgres://tiffinset_admin:password@localhost:5432/tiffinset';
  } else {
    // Production: load from GCP Secret Manager
    const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
    const client = new SecretManagerServiceClient();

    const getSecret = async (name) => {
      const projectId = await client.getProjectId();
      const [version] = await client.accessSecretVersion({
        name: `projects/${projectId}/secrets/${name}/versions/latest`,
      });
      return version.payload.data.toString('utf8').trim();
    };

    const [
      telegramToken,
      geminiKey,
      whisperKey,
      youtubeKey,
      webhookToken,
      dbUrl,
    ] = await Promise.all([
      getSecret('TELEGRAM_BOT_TOKEN'),
      getSecret('GEMINI_API_KEY'),
      getSecret('WHISPER_API_KEY'),
      getSecret('YOUTUBE_API_KEY'),
      getSecret('WEBHOOK_VERIFY_TOKEN'),
      getSecret('DATABASE_URL'),
    ]);

    config.TELEGRAM_BOT_TOKEN = telegramToken;
    config.GEMINI_API_KEY = geminiKey;
    config.WHISPER_API_KEY = whisperKey;
    config.YOUTUBE_API_KEY = youtubeKey;
    config.WEBHOOK_VERIFY_TOKEN = webhookToken;
    config.DATABASE_URL = dbUrl;
  }

  config.ACTIVE_TRANSPORT = process.env.ACTIVE_TRANSPORT || 'telegram';
  config.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
  config.PORT = parseInt(process.env.PORT || '3000', 10);
  config.NODE_ENV = process.env.NODE_ENV || 'development';
  config.METRICS_TOKEN = process.env.METRICS_TOKEN || '';

  return config;
}
