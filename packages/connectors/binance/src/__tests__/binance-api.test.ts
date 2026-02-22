// BinanceApi unit tests: non-JSON response handling, error responses

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

// We mock the auth module so we don't need real HMAC keys
vi.mock('../binance-auth.js', () => ({
  buildSignedUrl: (_base: string, _params: unknown, _secret: string) =>
    'https://fapi.binance.com/fapi/v1/order?symbol=BTCUSDT&signature=abc',
  buildAuthHeaders: (_apiKey: string) => ({
    'X-MBX-APIKEY': 'test-key',
    'Content-Type': 'application/json',
  }),
}));

const { BinanceApi } = await import('../binance-api.js');

function createApi() {
  return new BinanceApi({
    apiUrl: 'https://fapi.binance.com',
    apiKey: 'test-api-key',
    apiSecret: 'test-api-secret',
    futures: true,
  });
}

describe('Non-JSON response handling', () => {
  it('throws descriptive error when response is HTML (geo-block)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/html; charset=utf-8']]),
      text: async () => '<html><body>Access Denied</body></html>',
    });

    const api = createApi();

    await expect(api.placeOrder({ symbol: 'BTCUSDT' })).rejects.toThrow(
      'Binance API returned non-JSON response (200)'
    );
  });

  it('truncates long non-JSON response body to 200 chars', async () => {
    const longBody = 'X'.repeat(500);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 403,
      headers: new Map([['content-type', 'text/plain']]),
      text: async () => longBody,
    });

    const api = createApi();

    try {
      await api.placeOrder({ symbol: 'BTCUSDT' });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const msg = (error as Error).message;
      // Message should contain the truncated body (200 chars max)
      expect(msg.length).toBeLessThan(300);
      expect(msg).toContain('non-JSON response (403)');
    }
  });

  it('throws when content-type header is missing', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map(), // No content-type
      text: async () => 'plain text',
    });

    const api = createApi();

    await expect(api.placeOrder({ symbol: 'BTCUSDT' })).rejects.toThrow(
      'non-JSON response'
    );
  });

  it('parses valid JSON response with application/json content-type', async () => {
    const orderResponse = {
      orderId: 123,
      symbol: 'BTCUSDT',
      status: 'FILLED',
    };

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => orderResponse,
    });

    const api = createApi();
    const result = await api.placeOrder({ symbol: 'BTCUSDT' });

    expect(result).toEqual(orderResponse);
  });

  it('throws Binance error for JSON error response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => ({ code: -1021, msg: 'Timestamp outside recvWindow' }),
    });

    const api = createApi();

    await expect(api.placeOrder({ symbol: 'BTCUSDT' })).rejects.toThrow(
      'Binance API error: -1021 - Timestamp outside recvWindow'
    );
  });
});

describe('Futures-only getPositions guard', () => {
  it('throws when calling getPositions on spot API', async () => {
    const spotApi = new BinanceApi({
      apiUrl: 'https://api.binance.com',
      apiKey: 'test',
      apiSecret: 'test',
      futures: false,
    });

    await expect(spotApi.getPositions()).rejects.toThrow(
      'getPositions() is only available for futures'
    );
  });
});
