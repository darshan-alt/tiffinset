import { jest, describe, test, expect, afterEach } from '@jest/globals';

const mockFetch = jest.fn();

jest.unstable_mockModule('node-fetch', () => ({
  default: mockFetch,
}));
jest.unstable_mockModule('../src/config.js', () => ({
  default: { GEMINI_API_KEY: 'test-key' },
}));
jest.unstable_mockModule('../src/middleware/logger.js', () => ({
  logInfo: jest.fn(),
  logError: jest.fn(),
  incrementMetric: jest.fn(),
}));

const { callGemini } = await import('../src/ai/gemini.js');

afterEach(() => {
  jest.clearAllMocks();
});

function makeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('callGemini', () => {
  test('parses a text response correctly', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({
      candidates: [{ content: { parts: [{ text: 'Hello world' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }));

    const result = await callGemini('sys prompt', [{ role: 'user', parts: [{ text: 'hi' }] }], []);
    expect(result.type).toBe('text');
    expect(result.text).toBe('Hello world');
  });

  test('parses a function_call response', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({
      candidates: [{
        content: {
          parts: [{ functionCall: { name: 'search_recipe', args: { dish_name: 'dal' } } }],
        },
      }],
    }));

    const result = await callGemini('sys prompt', [{ role: 'user', parts: [{ text: 'dal recipe' }] }], []);
    expect(result.type).toBe('function_call');
    expect(result.name).toBe('search_recipe');
    expect(result.args).toEqual({ dish_name: 'dal' });
  });

  test('retries on 5xx and succeeds', async () => {
    // First call: 500
    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'server error' }, 500));
    // Retry: success
    mockFetch.mockResolvedValueOnce(makeResponse({
      candidates: [{ content: { parts: [{ text: 'Recovered' }] } }],
    }));

    const result = await callGemini('sys prompt', [{ role: 'user', parts: [{ text: 'test' }] }], []);
    expect(result.type).toBe('text');
    expect(result.text).toBe('Recovered');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('throws on 4xx without retry', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'bad request' }, 400));

    await expect(
      callGemini('sys prompt', [{ role: 'user', parts: [{ text: 'test' }] }], [])
    ).rejects.toThrow(/Gemini API 400/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
