// tests/processor.test.js — Agentic loop tests
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Mock all dependencies
jest.unstable_mockModule('ioredis', () => {
  const RedisMock = require('ioredis-mock');
  return { default: RedisMock };
});

jest.unstable_mockModule('../src/config.js', () => ({
  config: { REDIS_URL: 'redis://localhost:6379', GEMINI_API_KEY: 'test' },
  initConfig: jest.fn(),
}));

jest.unstable_mockModule('../src/db/pool.js', () => ({
  query: jest.fn(),
  getPool: jest.fn(),
  checkDb: jest.fn(),
  initDb: jest.fn(),
}));

jest.unstable_mockModule('../src/middleware/logger.js', () => ({
  logInfo: jest.fn(),
  logError: jest.fn(),
  incrementMetric: jest.fn().mockResolvedValue(1),
}));

// Mock gemini
const mockCallGemini = jest.fn();
jest.unstable_mockModule('../src/ai/gemini.js', () => ({
  callGemini: mockCallGemini,
}));

// Mock tools
jest.unstable_mockModule('../src/ai/tools.js', () => ({
  getToolsForRole: jest.fn().mockReturnValue([]),
  executeTool: jest.fn().mockResolvedValue({ result: 'tool_result' }),
}));

describe('Message processor (agentic loop)', () => {
  let processMessage;
  let mockQuery;

  const mockProfile = {
    phone: 'user_123',
    kitchen_id: 'kitchen_12345678',
    role: 'owner',
    display_name: 'Anita',
    language_code: 'hi',
  };
  const mockKitchen = {
    kitchen_id: 'kitchen_12345678',
    household_size: 4,
    address: 'Mumbai',
    dietary_prefs: ['vegetarian'],
  };

  beforeEach(async () => {
    jest.resetModules();
    const poolMod = await import('../src/db/pool.js');
    mockQuery = poolMod.query;

    // Default DB mocks
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('user_profiles')) return { rows: [mockProfile] };
      if (sql.includes('kitchen_sessions')) return { rows: [mockKitchen] };
      return { rows: [] };
    });

    mockCallGemini.mockClear();

    const mod = await import('../src/ai/processor.js');
    processMessage = mod.processMessage;
  });

  it('should return text response when Gemini returns text on first call', async () => {
    mockCallGemini.mockResolvedValueOnce({ type: 'text', text: 'Aaj dal makhani banana hai!' });

    const result = await processMessage('user_123', 'kya banana hai aaj?');
    expect(result).toBe('Aaj dal makhani banana hai!');
    expect(mockCallGemini).toHaveBeenCalledTimes(1);
  });

  it('should execute a tool call and return text on next iteration', async () => {
    mockCallGemini
      .mockResolvedValueOnce({
        type: 'function_call',
        name: 'search_recipe',
        args: { dish_name: 'paneer tikka' },
        rawParts: [{ functionCall: { name: 'search_recipe', args: { dish_name: 'paneer tikka' } } }],
      })
      .mockResolvedValueOnce({ type: 'text', text: 'Here is the paneer tikka recipe!' });

    const result = await processMessage('user_123', 'paneer tikka recipe do');
    expect(result).toBe('Here is the paneer tikka recipe!');
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
  });

  it('should return fallback message when loop exhausted after 5 tool calls', async () => {
    mockCallGemini.mockResolvedValue({
      type: 'function_call',
      name: 'search_recipe',
      args: { dish_name: 'test' },
      rawParts: [{ functionCall: { name: 'search_recipe', args: {} } }],
    });

    const result = await processMessage('user_123', 'test message');
    expect(result).toContain('Processing mein thoda time lag raha hai');
    expect(mockCallGemini).toHaveBeenCalledTimes(5);
  });
});
