// tests/gemini.test.js — Gemini API client tests
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock node-fetch
const mockFetch = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({ default: mockFetch }));

// Mock config
jest.unstable_mockModule('../src/config.js', () => ({
  config: { GEMINI_API_KEY: 'test-key' },
  initConfig: jest.fn(),
}));

// Mock logger
jest.unstable_mockModule('../src/middleware/logger.js', () => ({
  logInfo: jest.fn(),
  logError: jest.fn(),
  incrementMetric: jest.fn().mockResolvedValue(1),
}));

describe('Gemini AI client', () => {
  let callGemini;

  beforeEach(async () => {
    jest.clearAllMocks();
    const mod = await import('../src/ai/gemini.js');
    callGemini = mod.callGemini;
  });

  it('should parse a text response correctly', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ text: 'Aaj paneer tikka banana chahiye!' }],
          },
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    });

    const result = await callGemini('system', [{ role: 'user', parts: [{ text: 'hi' }] }], []);
    expect(result.type).toBe('text');
    expect(result.text).toBe('Aaj paneer tikka banana chahiye!');
  });

  it('should parse a function_call response correctly', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              functionCall: {
                name: 'search_recipe',
                args: { dish_name: 'dal makhani' },
              },
            }],
          },
        }],
        usageMetadata: {},
      }),
    });

    const result = await callGemini('system', [], []);
    expect(result.type).toBe('function_call');
    expect(result.name).toBe('search_recipe');
    expect(result.args.dish_name).toBe('dal makhani');
  });

  it('should strip thought parts from response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: {
            parts: [
              { thought: true, text: 'Let me think about this...' },
              { text: 'Here is the real answer.' },
            ],
          },
        }],
        usageMetadata: {},
      }),
    });

    const result = await callGemini('system', [], []);
    expect(result.type).toBe('text');
    expect(result.text).toBe('Here is the real answer.');
  });

  it('should retry once on 5xx error and succeed', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'Service Unavailable' })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{
            content: { parts: [{ text: 'Retry successful' }] },
          }],
          usageMetadata: {},
        }),
      });

    const result = await callGemini('system', [], []);
    expect(result.type).toBe('text');
    expect(result.text).toBe('Retry successful');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should NOT retry on 4xx error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Bad Request' } }),
    });

    await expect(callGemini('system', [], [])).rejects.toThrow('4xx');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
