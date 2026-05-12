import fetch from 'node-fetch';
import FormData from 'form-data';
import config from '../config.js';
import { logInfo, logError } from '../middleware/logger.js';

export async function transcribeAudio(audioBuffer) {
  const start = Date.now();
  
  const createFormData = () => {
    const formData = new FormData();
    formData.append('file', audioBuffer, { filename: 'voice.ogg', contentType: 'audio/ogg' });
    formData.append('model', 'whisper-1');
    return formData;
  };

  const attempt = async () => {
    const formData = createFormData();
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.WHISPER_API_KEY}`,
        ...formData.getHeaders(),
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Whisper API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  };

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  let data;
  try {
    data = await attempt();
  } catch (error) {
    logInfo({}, 'whisper_retry', { reason: error.message });
    await delay(2000);
    try {
      data = await attempt();
    } catch (retryError) {
      throw new Error(`Whisper transcription failed after retry. Details: ${retryError.message}`);
    }
  }

  const duration = Date.now() - start;
  const text = data.text;
  logInfo({}, 'whisper_transcription_complete', { duration, textLength: text.length });
  
  return text;
}
