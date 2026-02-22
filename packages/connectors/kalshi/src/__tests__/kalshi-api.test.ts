// KalshiApi unit tests: 204 No Content handling, non-JSON error responses

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

vi.mock('../kalshi-auth.js', () => ({
  buildAuthHeaders: () => ({
    'KALSHI-ACCESS-KEY': 'test-key',
    'KALSHI-ACCESS-SIGNATURE': 'test-sig',
    'KALSHI-ACCESS-TIMESTAMP': '1700000000',
  }),
}));

const { KalshiApi } = await import('../kalshi-api.js');

function createApi() {
  return new KalshiApi({
    apiUrl: 'https://demo-api.kalshi.co',
    apiKey: 'test-key',
    privateKeyPem: '-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----',
  });
}

describe('204 No Content response handling', () => {
  it('returns empty object for DELETE 204 response (cancelOrder)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => { throw new Error('No body'); },
    });

    const api = createApi();
    // cancelOrder calls DELETE and returns void, but internally it goes through request<T>
    await expect(api.cancelOrder('ord-123')).resolves.not.toThrow();
  });

  it('returns empty object for DELETE 204 response (cancelAllOrders)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => { throw new Error('No body'); },
    });

    const api = createApi();
    await expect(api.cancelAllOrders()).resolves.not.toThrow();
  });
});

describe('Error response handling', () => {
  it('parses structured Kalshi error JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        error: { code: 'invalid_order', message: 'Invalid ticker: UNKNOWN-MKT' },
      }),
    });

    const api = createApi();

    await expect(api.placeOrder({
      ticker: 'UNKNOWN-MKT',
      action: 'buy',
      side: 'yes',
      count: 1,
    })).rejects.toThrow('invalid_order - Invalid ticker: UNKNOWN-MKT');
  });

  it('handles non-JSON error response (HTML from proxy)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => '<html><body>Bad Gateway</body></html>',
    });

    const api = createApi();

    await expect(api.placeOrder({
      ticker: 'BTC-100K',
      action: 'buy',
      side: 'yes',
      count: 1,
    })).rejects.toThrow('HTTP 502');
  });

  it('truncates long non-JSON error body', async () => {
    const longBody = 'E'.repeat(500);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => longBody,
    });

    const api = createApi();

    try {
      await api.getBalance();
      expect.unreachable('Should have thrown');
    } catch (error) {
      const msg = (error as Error).message;
      // Body should be truncated to 200 chars
      expect(msg.length).toBeLessThan(300);
      expect(msg).toContain('HTTP 500');
    }
  });
});

describe('Successful JSON responses', () => {
  it('parses positions response correctly', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        positions: [
          { ticker: 'BTC-100K', position: 5, market_exposure_cents: 250, total_traded_cents: 300, realized_pnl_cents: 0, fees_paid_cents: 10, resting_orders_count: 0 },
        ],
      }),
    });

    const api = createApi();
    const positions = await api.getPositions();

    expect(positions).toHaveLength(1);
    expect(positions[0].ticker).toBe('BTC-100K');
  });

  it('returns empty array when positions response has no positions field', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    const api = createApi();
    const positions = await api.getPositions();

    expect(positions).toEqual([]);
  });
});
