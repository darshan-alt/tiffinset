// src/transport/telegram.js — Telegram Bot API transport implementation
import fetch from 'node-fetch';
import FormData from 'form-data';
import { config } from '../config.js';

function baseUrl() {
  return `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;
}

/**
 * Verify Telegram webhook secret token header.
 * Returns true if valid, false otherwise.
 */
export function verifyWebhook(req) {
  const token = req.headers['x-telegram-bot-api-secret-token'];
  return token === config.WEBHOOK_VERIFY_TOKEN;
}

/**
 * Parse incoming Telegram update into a normalized message object.
 * Returns: { type, chatId, text?, audio?, data?, callbackQueryId?, messageId? }
 */
export function parseIncoming(body) {
  // Callback query (button tap)
  if (body.callback_query) {
    const cq = body.callback_query;
    return {
      type: 'callback_query',
      chatId: String(cq.message.chat.id),
      data: cq.data,
      callbackQueryId: cq.id,
      messageId: String(cq.id),
    };
  }

  const message = body.message || body.edited_message;
  if (!message) return { type: 'unknown', chatId: null };

  const chatId = String(message.chat.id);
  const messageId = String(message.message_id);

  if (message.voice || message.audio) {
    const audio = message.voice || message.audio;
    return { type: 'voice', chatId, audio: audio.file_id, messageId };
  }

  if (message.text) {
    return { type: 'text', chatId, text: message.text, messageId };
  }

  return { type: 'unknown', chatId, messageId };
}

/**
 * Download audio file from Telegram. Returns Buffer.
 */
export async function downloadAudio(fileId) {
  return _downloadFile(fileId);
}

/**
 * Download image file from Telegram. Returns Buffer.
 */
export async function downloadImage(fileId) {
  return _downloadFile(fileId);
}

/**
 * Get Telegram file path for a given fileId.
 */
export async function fetchTelegramFile(fileId) {
  const res = await fetch(`${baseUrl()}/getFile?file_id=${fileId}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`getFile failed: ${data.description}`);
  return data.result;
}

async function _downloadFile(fileId) {
  const file = await fetchTelegramFile(fileId);
  const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`File download failed: ${res.status}`);
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Send a plain text message. Never throws — logs errors internally.
 * NOTE: no parse_mode (Markdown causes 400 on Gemini output).
 */
export async function sendText(chatId, text) {
  try {
    const res = await fetch(`${baseUrl()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4096) }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`[Telegram] sendText failed for ${chatId}:`, data.description);
    }
    return data;
  } catch (err) {
    console.error(`[Telegram] sendText error for ${chatId}:`, err.message);
  }
}

/**
 * Send a list as inline keyboard buttons (one per row).
 */
export async function sendList(chatId, header, items) {
  try {
    const keyboard = items.map((item) => [
      { text: typeof item === 'string' ? item : item.text, callback_data: typeof item === 'string' ? item : (item.data || item.text) },
    ]);
    const res = await fetch(`${baseUrl()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: header,
        reply_markup: { inline_keyboard: keyboard },
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`[Telegram] sendList failed for ${chatId}:`, data.description);
    }
    return data;
  } catch (err) {
    console.error(`[Telegram] sendList error for ${chatId}:`, err.message);
  }
}

/**
 * Send a message with inline keyboard buttons.
 * buttons: [{ text, data }]
 */
export async function sendButtons(chatId, text, buttons) {
  try {
    // Split into rows of 2
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) {
      rows.push(
        buttons.slice(i, i + 2).map((b) => ({ text: b.text, callback_data: b.data || b.text }))
      );
    }
    const res = await fetch(`${baseUrl()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 4096),
        reply_markup: { inline_keyboard: rows },
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`[Telegram] sendButtons failed for ${chatId}:`, data.description);
    }
    return data;
  } catch (err) {
    console.error(`[Telegram] sendButtons error for ${chatId}:`, err.message);
  }
}

/**
 * Answer a callback query (dismiss loading spinner on button tap).
 */
export async function answerCallbackQuery(callbackQueryId, text = '') {
  try {
    await fetch(`${baseUrl()}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (err) {
    console.error('[Telegram] answerCallbackQuery error:', err.message);
  }
}
