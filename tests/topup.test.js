import { jest, describe, test, expect, afterEach } from '@jest/globals';

const mockQuery = jest.fn();

jest.unstable_mockModule('../src/db/pool.js', () => ({
  default: { query: mockQuery },
}));

const { suggestTopUp } = await import('../src/order/topup.js');

afterEach(() => {
  jest.clearAllMocks();
});

describe('suggestTopUp', () => {
  test('returns null when cart total is above free delivery minimum', async () => {
    const result = await suggestTopUp('kitchen_1', 250, 199);
    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('returns null when no items meet the threshold', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await suggestTopUp('kitchen_1', 100, 199);
    expect(result).toBeNull();
  });

  test('returns null when item price exceeds gap + 50', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          item_name: 'Atta',
          avg_price: 280,
          last_ordered: new Date(Date.now() - 20 * 86400000),
          count_orders: 5,
          avg_cycle: 15,
          days_since_last: 20,
        },
      ],
    });

    const result = await suggestTopUp('kitchen_1', 50, 199);
    // gap = 149, avg_price 280 > gap+50 (199), so it should NOT be included
    expect(result).toBeNull();
  });

  test('returns items when price fits within gap range', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          item_name: 'Green Chilli',
          avg_price: 15,
          last_ordered: new Date(Date.now() - 10 * 86400000),
          count_orders: 4,
          avg_cycle: 7,
          days_since_last: 10,
        },
      ],
    });

    const result = await suggestTopUp('kitchen_1', 150, 199);
    // gap = 49, avg_price 15 <= 49+50 (99), score = 10/7 = 1.43 > 0.8 → included
    expect(result).not.toBeNull();
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].name).toBe('Green Chilli');
    expect(result.gap).toBe(49);
  });
});
