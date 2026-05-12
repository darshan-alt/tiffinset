import { jest, describe, test, expect, afterEach } from '@jest/globals';

const mockQuery = jest.fn();
const mockSendText = jest.fn();

jest.unstable_mockModule('../src/db/pool.js', () => ({
  default: { query: mockQuery },
}));
jest.unstable_mockModule('../src/transport/index.js', () => ({
  sendText: mockSendText,
}));
jest.unstable_mockModule('../src/middleware/logger.js', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
}));

const { getKitchenMembers, routeEvent } = await import('../src/kitchen/routing.js');

afterEach(() => {
  jest.clearAllMocks();
});

describe('getKitchenMembers', () => {
  test('returns all members when no role filter', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { phone: '111', role: 'owner', display_name: 'Owner', language: 'hi' },
        { phone: '222', role: 'cook', display_name: 'Cook', language: 'hi' },
      ],
    });

    const members = await getKitchenMembers('kitchen_1');
    expect(members).toHaveLength(2);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE kitchen_id = $1'),
      ['kitchen_1']
    );
  });

  test('filters by role when provided', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ phone: '222', role: 'cook', display_name: 'Cook', language: 'hi' }],
    });

    const members = await getKitchenMembers('kitchen_1', 'cook');
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe('cook');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('AND role = $2'),
      ['kitchen_1', 'cook']
    );
  });
});

describe('routeEvent', () => {
  test('menu_set dispatches to cooks and contributors', async () => {
    // getKitchenMembers('kitchen_1', 'cook')
    mockQuery.mockResolvedValueOnce({
      rows: [{ phone: '222', role: 'cook', display_name: 'Cook' }],
    });
    // getKitchenMembers('kitchen_1', 'contributor')
    mockQuery.mockResolvedValueOnce({
      rows: [{ phone: '333', role: 'contributor', display_name: 'Contrib' }],
    });
    // logEvent SELECT role
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    // logEvent INSERT
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await routeEvent({
      type: 'menu_set',
      kitchenId: 'kitchen_1',
      sourcePhone: '111',
      payload: { recipe: 'Dal', videoUrl: 'https://youtube.com/xyz', summary: 'Dal for lunch' },
    });

    expect(mockSendText).toHaveBeenCalledWith('222', expect.stringContaining('Dal'));
    expect(mockSendText).toHaveBeenCalledWith('333', expect.stringContaining('summary'));
  });

  test('shortage_report dispatches to owners', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ phone: '111', role: 'owner', display_name: 'Owner' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'cook' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await routeEvent({
      type: 'shortage_report',
      kitchenId: 'kitchen_1',
      sourcePhone: '222',
      payload: { itemDetails: 'Atta khatam', brandOptions: 'Aashirvaad, Pillsbury' },
    });

    expect(mockSendText).toHaveBeenCalledWith('111', expect.stringContaining('Shortage'));
  });
});
