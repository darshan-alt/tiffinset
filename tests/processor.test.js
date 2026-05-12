import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import Redis from 'ioredis-mock';

const mockCallGemini = jest.fn();
const mockExecuteTool = jest.fn();
const mockQuery = jest.fn();

// Create a shared redis instance for the mock
const redis = new Redis();

jest.unstable_mockModule('../src/ai/gemini.js', () => ({
  callGemini: mockCallGemini,
}));
jest.unstable_mockModule('../src/ai/tools.js', () => ({
  toolDefinitions: [
    { name: 'search_recipe', description: 'Search recipe', parameters: { type: 'object', properties: {}, required: [] } },
  ],
  executeTool: mockExecuteTool,
}));
jest.unstable_mockModule('../src/db/pool.js', () => ({
  default: { query: mockQuery },
}));
jest.unstable_mockModule('../src/db/redis.js', () => ({
  default: redis,
}));
jest.unstable_mockModule('../src/middleware/logger.js', () => ({
  logInfo: jest.fn(),
  logError: jest.fn(),
  incrementMetric: jest.fn(),
}));

const { processMessage } = await import('../src/ai/processor.js');

afterEach(async () => {
  await redis.flushall();
  jest.clearAllMocks();
});

describe('processMessage (agentic loop)', () => {
  // Setup mock profile + kitchen for every test
  beforeEach(() => {
    // user_profiles query
    mockQuery.mockResolvedValueOnce({
      rows: [{ phone: '111', kitchen_id: 'k1', role: 'owner', display_name: 'Test', language_code: 'hi' }],
    });
    // kitchen_sessions query
    mockQuery.mockResolvedValueOnce({
      rows: [{ household_size: 4, address: '123 Test St', dietary_prefs: '[]' }],
    });
  });

  test('terminates after text response from Gemini', async () => {
    mockCallGemini.mockResolvedValueOnce({
      type: 'text',
      text: 'Namaste!',
    });

    const result = await processMessage('111', 'hello');
    expect(result).toBe('Namaste!');
    expect(mockCallGemini).toHaveBeenCalledTimes(1);
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  test('executes tool then returns text on next iteration', async () => {
    // First Gemini call: function call
    mockCallGemini.mockResolvedValueOnce({
      type: 'function_call',
      name: 'search_recipe',
      args: { dish_name: 'dal' },
      rawParts: [{ functionCall: { name: 'search_recipe', args: { dish_name: 'dal' } } }],
    });

    mockExecuteTool.mockResolvedValueOnce({ dish_name: 'dal', servings: 4 });

    // Second Gemini call: text response
    mockCallGemini.mockResolvedValueOnce({
      type: 'text',
      text: 'Here is your dal recipe!',
    });

    const result = await processMessage('111', 'dal recipe batao');
    expect(result).toBe('Here is your dal recipe!');
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
  });

  test('caps at 5 iterations if Gemini keeps calling tools', async () => {
    // All 5 iterations return function calls
    for (let i = 0; i < 5; i++) {
      mockCallGemini.mockResolvedValueOnce({
        type: 'function_call',
        name: 'search_recipe',
        args: { dish_name: 'loop' },
        rawParts: [{ functionCall: { name: 'search_recipe', args: { dish_name: 'loop' } } }],
      });
      mockExecuteTool.mockResolvedValueOnce({ note: 'keep going' });
    }

    const result = await processMessage('111', 'infinite loop test');
    expect(result).toContain('Processing mein thoda time lag raha hai');
    expect(mockCallGemini).toHaveBeenCalledTimes(5);
    expect(mockExecuteTool).toHaveBeenCalledTimes(5);
  });
});
