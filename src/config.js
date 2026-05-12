import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const client = new SecretManagerServiceClient();

async function getSecret(name) {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'tiffinset';
  const [version] = await client.accessSecretVersion({
    name: `projects/${projectId}/secrets/${name}/versions/latest`,
  });
  return version.payload.data.toString();
}

const config = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  WHISPER_API_KEY: process.env.WHISPER_API_KEY,
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY,
  WEBHOOK_VERIFY_TOKEN: process.env.WEBHOOK_VERIFY_TOKEN,
  DATABASE_URL: process.env.DATABASE_URL,
  ACTIVE_TRANSPORT: process.env.ACTIVE_TRANSPORT || 'telegram',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
};

const secretNames = [
  'TELEGRAM_BOT_TOKEN',
  'GEMINI_API_KEY',
  'WHISPER_API_KEY',
  'YOUTUBE_API_KEY',
  'WEBHOOK_VERIFY_TOKEN',
  'DATABASE_URL',
];

export async function initConfig() {
  if (process.env.NODE_ENV === 'production') {
    for (const name of secretNames) {
      try {
        config[name] = await getSecret(name);
      } catch (error) {
        console.error(`Error loading secret ${name}:`, error);
        throw new Error(`Failed to load critical secret: ${name}`);
      }
    }
  }
  return config;
}

export default config;
