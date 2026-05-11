import config from '../config.js';
import telegram from './telegram.js';

const transports = {
  telegram,
};

const activeTransport = transports[config.ACTIVE_TRANSPORT] || telegram;

export const {
  verifyWebhook,
  parseIncoming,
  downloadAudio,
  downloadImage,
  sendText,
  sendList,
  sendButtons,
  answerCallbackQuery,
} = activeTransport;

export default activeTransport;
