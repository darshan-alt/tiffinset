// src/ai/gemini.js — Gemini 2.5 Flash API client with retry and thinking-token stripping
import fetch from 'node-fetch';
import { config } from '../config.js';
import { logInfo, logError, incrementMetric } from '../middleware/logger.js';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const RETRY_DELAY_MS = 2000;

/**
 * Strip {thought: true} parts from Gemini response parts.
 * gemini-2.5-flash returns thinking tokens that must not be sent to users
 * or stored in conversation history.
 */
function stripThinkingParts(parts) {
  if (!Array.isArray(parts)) return parts;
  return parts.filter((p) => !p.thought);
}

/**
 * Call Gemini 2.5 Flash with function calling support.
 * Returns: { type: 'text', text } or { type: 'function_call', name, args, rawParts }
 *
 * Retries once on 5xx or network errors. Throws on 4xx (no retry).
 */
export async function callGemini(systemPrompt, contents, tools) {
  const start = Date.now();

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    tools: tools && tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
  };

  let lastError;
  for (let attempt = 0; attempt <= 1; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }

    try {
      const res = await fetch(`${GEMINI_URL}?key=${config.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status >= 400 && res.status < 500) {
        const errData = await res.json().catch(() => ({}));
        throw Object.assign(new Error(`Gemini 4xx: ${res.status}`), { status: res.status, noRetry: true, data: errData });
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        lastError = new Error(`Gemini ${res.status}: ${errText}`);
        logError('gemini', 'api_error', lastError, { attempt, status: res.status });
        continue; // retry
      }

      const data = await res.json();
      const candidate = data?.candidates?.[0];
      if (!candidate?.content?.parts) {
        throw new Error('Gemini: no content parts in response');
      }

      // Strip thinking tokens before any processing
      const rawParts = stripThinkingParts(candidate.content.parts);

      incrementMetric('geminiCalls').catch(() => {});
      const duration = Date.now() - start;
      logInfo('gemini', 'call_success', {
        duration,
        inputTokens: data.usageMetadata?.promptTokenCount,
        outputTokens: data.usageMetadata?.candidatesTokenCount,
      });

      // Check for function call
      const fnCallPart = rawParts.find((p) => p.functionCall);
      if (fnCallPart) {
        return {
          type: 'function_call',
          name: fnCallPart.functionCall.name,
          args: fnCallPart.functionCall.args || {},
          rawParts,
        };
      }

      // Text response
      const text = rawParts.filter((p) => p.text).map((p) => p.text).join('');
      return { type: 'text', text };

    } catch (err) {
      if (err.noRetry) throw err;
      lastError = err;
      logError('gemini', 'fetch_error', err, { attempt });
    }
  }

  throw lastError || new Error('Gemini: all retries exhausted');
}
