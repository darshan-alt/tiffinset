import fetch from 'node-fetch';
import FormData from 'form-data';
import config from '../config.js';

export async function transcribeAudio(audioBuffer) {
  const start = Date.now();
  
  const formData = new FormData();
  formData.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
  formData.append('model', 'whisper-1');

  async function attempt() {
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.WHISPER_API_KEY}`,
        ...formData.getHeaders(),
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Whisper API error: ${error.error?.message || response.statusText}`);
    }

    return response.json();
  }

  try {
    let result;
    try {
      result = await attempt();
    } catch (e) {
      console.warn('Whisper API first attempt failed, retrying...', e.message);
      result = await attempt();
    }

    const duration = Date.now() - start;
    console.log(`Whisper transcription took ${duration}ms`);
    return result.text;
  } catch (error) {
    console.error('Whisper transcription failed:', error);
    throw error;
  }
}

export default {
  transcribeAudio,
};
