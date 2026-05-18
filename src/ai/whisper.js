// src/ai/whisper.js — OpenAI Whisper speech-to-text
import fetch from 'node-fetch';
import FormData from 'form-data';
import { config } from '../config.js';
import { logInfo, logError, incrementMetric } from '../middleware/logger.js';

/**
 * Transcribe audio buffer using OpenAI Whisper API.
 * Auto-detects language (Hindi, Hinglish, Tamil, English, etc.)
 * Returns: transcribed text string
 * Throws on failure after one retry.
 */
export async function transcribeAudio(audioBuffer) {
  const start = Date.now();

  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const form = new FormData();
      form.append('file', audioBuffer, {
        filename: 'audio.ogg',
        contentType: 'audio/ogg',
      });
      form.append('model', 'whisper-1');
      // Do NOT set language — auto-detection handles Hindi, Hinglish, Tamil, English

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.WHISPER_API_KEY}`,
          ...form.getHeaders(),
        },
        body: form,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Whisper API error ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const text = data.text?.trim() || '';

      const duration = Date.now() - start;
      incrementMetric('whisperCalls').catch(() => {});
      logInfo('whisper', 'transcribed', { duration, chars: text.length });

      return text;
    } catch (err) {
      if (attempt === 1) {
        logError('whisper', 'transcription_failed', err);
        throw err;
      }
      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
