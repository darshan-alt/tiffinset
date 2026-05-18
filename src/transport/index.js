// src/transport/index.js — Re-export active transport
import { config } from '../config.js';
import * as telegram from './telegram.js';

function getTransport() {
  const transport = config.ACTIVE_TRANSPORT || 'telegram';
  switch (transport) {
    case 'telegram':
      return telegram;
    default:
      console.warn(`[Transport] Unknown transport "${transport}", defaulting to telegram`);
      return telegram;
  }
}

// Lazy proxy — re-evaluates after config is loaded
const handler = {
  get(_target, prop) {
    return getTransport()[prop];
  },
};

export default new Proxy({}, handler);

// Also export named for direct use
export const {
  verifyWebhook,
  parseIncoming,
  downloadAudio,
  downloadImage,
  sendText,
  sendList,
  sendButtons,
  answerCallbackQuery,
  fetchTelegramFile,
} = telegram;
