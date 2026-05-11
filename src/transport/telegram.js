import fetch from 'node-fetch';
import FormData from 'form-data';
import config from '../config.js';

const TELEGRAM_API = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;

export function verifyWebhook(req) {
  const token = req.headers['x-telegram-bot-api-secret-token'];
  return token === config.WEBHOOK_VERIFY_TOKEN;
}

export function parseIncoming(body) {
  if (body.message) {
    return {
      type: 'message',
      chatId: body.message.chat.id,
      messageId: body.message.message_id,
      text: body.message.text,
      audio: body.message.voice || body.message.audio,
      image: body.message.photo ? body.message.photo[body.message.photo.length - 1] : null,
      raw: body.message,
    };
  } else if (body.callback_query) {
    return {
      type: 'callback_query',
      chatId: body.callback_query.message.chat.id,
      messageId: body.callback_query.message.message_id,
      data: body.callback_query.data,
      callbackQueryId: body.callback_query.id,
      raw: body.callback_query,
    };
  }
  return null;
}

export async function downloadAudio(fileId) {
  const response = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const { result } = await response.json();
  const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${result.file_path}`;
  const fileResponse = await fetch(fileUrl);
  return Buffer.from(await fileResponse.arrayBuffer());
}

export async function downloadImage(fileId) {
  const response = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const { result } = await response.json();
  const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${result.file_path}`;
  const fileResponse = await fetch(fileUrl);
  return Buffer.from(await fileResponse.arrayBuffer());
}

export async function sendText(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown',
    }),
  });
}

export async function sendList(chatId, header, items) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: header,
      reply_markup: {
        inline_keyboard: items.map(item => [{ text: item, callback_data: `list_item:${item}` }]),
      },
    }),
  });
}

export async function sendButtons(chatId, text, buttons) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      reply_markup: {
        inline_keyboard: buttons.map(b => [{ text: b.text, callback_data: b.data }]),
      },
    }),
  });
}

export async function answerCallbackQuery(callbackQueryId, text) {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text,
    }),
  });
}

export default {
  verifyWebhook,
  parseIncoming,
  downloadAudio,
  downloadImage,
  sendText,
  sendList,
  sendButtons,
  answerCallbackQuery,
};
