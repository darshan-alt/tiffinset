import fetch from 'node-fetch';
import config from '../config.js';
import { logInfo, logError, incrementMetric } from '../middleware/logger.js';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function callGemini(systemPrompt, contents, tools) {
  const start = Date.now();
  incrementMetric('geminiCalls');

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: contents,
  };

  if (tools && tools.length) {
    body.tools = [{ functionDeclarations: tools }];
  }

  const url = `${GEMINI_URL}?key=${config.GEMINI_API_KEY}`;
  const headers = { 'Content-Type': 'application/json' };

  async function attempt() {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const duration = Date.now() - start;

    if (response.status >= 500) {
      const errorText = await response.text();
      throw { retryable: true, status: response.status, body: errorText, duration };
    }

    if (response.status >= 400) {
      const errorText = await response.text();
      throw new Error(`Gemini API ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    // Log usage metadata
    logInfo({}, 'gemini_call', {
      duration,
      promptTokens: data.usageMetadata?.promptTokenCount || 0,
      candidatesTokens: data.usageMetadata?.candidatesTokenCount || 0,
      totalTokens: data.usageMetadata?.totalTokenCount || 0,
    });

    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) {
      throw new Error('Gemini returned no content parts');
    }

    // Check for function call in any part
    const fcPart = parts.find(p => p.functionCall);
    if (fcPart) {
      return {
        type: 'function_call',
        name: fcPart.functionCall.name,
        args: fcPart.functionCall.args,
        rawParts: parts,
      };
    }

    // Text-only response: join all text parts
    const joinedText = parts
      .filter(p => p.text !== undefined)
      .map(p => p.text)
      .join('');

    return { type: 'text', text: joinedText };
  }

  try {
    return await attempt();
  } catch (err) {
    // Retry once on 5xx or network error
    if (err.retryable || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND' || err.type === 'system') {
      logInfo({}, 'gemini_retry', { reason: err.message || err.body || String(err) });
      await delay(2000);
      return await attempt();
    }
    logError({}, 'gemini_call_error', err);
    throw err;
  }
}
