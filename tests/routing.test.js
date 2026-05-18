// tests/routing.test.js — Kitchen event routing tests
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock DB
jest.unstable_mockModule('../src/db/pool.js', () => ({
  query: jest.fn(),
  getPool: jest.fn(),
  checkDb: jest.fn(),
  initDb: jest.fn(),
  getClient: jest.fn(),
}));

// Mock transport
jest.unstable_mockModule('../src/transport/index.js', () => ({
  sendText: jest.fn().mockResolvedValue({}),
  sendList: jest.fn(),
  sendButtons: jest.fn(),
  answerCallbackQuery: jest.fn(),
  default: { sendText: jest.fn() },
}));

// Mock logger
jest.unstable_mockModule('../src/middleware/logger.js', () => ({
  logInfo: jest.fn(),
  logError: jest.fn(),
  incrementMetric: jest.fn(),
}));

describe('Kitchen routing', () => {
  let routeEvent, getKitchenMembers, logEvent;
  let mockQuery, mockSendText;

  const mockCooks = [
    { phone: 'cook_111', role: 'cook', display_name: 'Ramu', language_code: 'hi' },
  ];
  const mockContributors = [
    { phone: 'contrib_222', role: 'contributor', display_name: 'Priya', language_code: 'hi' },
  ];
  const mockOwners = [
    { phone: 'owner_333', role: 'owner', display_name: 'Anita', language_code: 'hi' },
  ];

  beforeEach(async () => {
    jest.resetModules();

    const poolMod = await import('../src/db/pool.js');
    mockQuery = poolMod.query;

    const transportMod = await import('../src/transport/index.js');
    mockSendText = transportMod.sendText;
    mockSendText.mockClear();

    // Default: query returns based on role param
    mockQuery.mockImplementation(async (sql, params) => {
      if (params && params[1] === 'cook') return { rows: mockCooks };
      if (params && params[1] === 'contributor') return { rows: mockContributors };
      if (params && params[1] === 'owner') return { rows: mockOwners };
      if (params && params.length === 1) return { rows: [...mockCooks, ...mockContributors, ...mockOwners] };
      return { rows: [] };
    });

    const mod = await import('../src/kitchen/routing.js');
    routeEvent = mod.routeEvent;
    getKitchenMembers = mod.getKitchenMembers;
    logEvent = mod.logEvent;
  });

  it('menu_set should route to cooks and contributors', async () => {
    await routeEvent({
      type: 'menu_set',
      kitchenId: 'kitchen_test',
      sourcePhone: 'owner_333',
      sourceRole: 'owner',
      payload: { dishes: ['Dal Makhani', 'Roti'] },
    });

    // Should have sent messages (cook + contributor + event_log insert)
    expect(mockSendText).toHaveBeenCalledWith('cook_111', expect.stringContaining('Dal Makhani'));
    expect(mockSendText).toHaveBeenCalledWith('contrib_222', expect.stringContaining('Dal Makhani'));
  });

  it('shortage_report should route to owners', async () => {
    await routeEvent({
      type: 'shortage_report',
      kitchenId: 'kitchen_test',
      sourcePhone: 'cook_111',
      sourceRole: 'cook',
      payload: {
        item: 'paneer',
        brands: [
          { name: 'Amul', quantity: '500g', price: 165 },
        ],
      },
    });

    expect(mockSendText).toHaveBeenCalledWith('owner_333', expect.stringContaining('paneer'));
  });

  it('dish_suggested should route to owners', async () => {
    await routeEvent({
      type: 'dish_suggested',
      kitchenId: 'kitchen_test',
      sourcePhone: 'contrib_222',
      sourceRole: 'contributor',
      payload: { dish: 'Pav Bhaji', suggesterName: 'Priya' },
    });

    expect(mockSendText).toHaveBeenCalledWith('owner_333', expect.stringContaining('Pav Bhaji'));
  });
});
