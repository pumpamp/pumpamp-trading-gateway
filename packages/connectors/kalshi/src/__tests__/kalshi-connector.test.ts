import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrderRequest, Balance } from '@pumpamp/core';
import { mapKalshiError } from '../kalshi-connector.js';
import type { KalshiBalance, KalshiOrderResponse } from '../types.js';

// ============================================================
// Mock KalshiApi to avoid real HTTP calls and fs.readFileSync
// ============================================================

const mockPlaceOrder = vi.fn();
const mockGetBalance = vi.fn();
const mockCancelOrder = vi.fn();
const mockCancelAllOrders = vi.fn();
const mockGetPositions = vi.fn();

vi.mock('../kalshi-api.js', () => ({
  KalshiApi: vi.fn().mockImplementation(() => ({
    placeOrder: mockPlaceOrder,
    getBalance: mockGetBalance,
    cancelOrder: mockCancelOrder,
    cancelAllOrders: mockCancelAllOrders,
    getPositions: mockGetPositions,
  })),
}));

// Import after mocks are set up
const { KalshiConnector } = await import('../kalshi-connector.js');

function createConnector() {
  return new KalshiConnector({
    apiUrl: 'https://demo-api.kalshi.co',
    apiKey: 'test-api-key',
    privateKeyPem: '-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----',
  });
}

// ============================================================
// UT-6a.2: Order formatting (3 tests)
// ============================================================

describe('UT-6a.2: Kalshi order formatting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('formats a market buy order correctly (maps open->buy, Yes->yes)', async () => {
    const filledResponse: KalshiOrderResponse = {
      order_id: 'kalshi-ord-1',
      ticker: 'BTC-100K',
      action: 'buy',
      side: 'yes',
      count: 5,
      status: 'filled',
      created_time: '2026-02-11T10:00:00Z',
      yes_price: 65,
      client_order_id: 'cmd-001',
    };
    mockPlaceOrder.mockResolvedValue(filledResponse);

    const connector = createConnector();

    // Frontend sends 'Yes' (capitalized) and 'open' (gateway standard)
    const order: OrderRequest = {
      market_id: 'BTC-100K',
      venue: 'kalshi',
      side: 'Yes',
      action: 'open',
      size: 5,
      order_type: 'market',
      command_id: 'cmd-001',
    };

    await connector.placeOrder(order);

    // Verify the connector maps to Kalshi-native format
    expect(mockPlaceOrder).toHaveBeenCalledOnce();
    const sentRequest = mockPlaceOrder.mock.calls[0][0];
    expect(sentRequest.ticker).toBe('BTC-100K');
    expect(sentRequest.action).toBe('buy');   // 'open' -> 'buy'
    expect(sentRequest.side).toBe('yes');      // 'Yes' -> 'yes'
    expect(sentRequest.count).toBe(5);
    expect(sentRequest.type).toBe('market');
    expect(sentRequest.client_order_id).toBe('cmd-001');
    // Market orders should not have yes_price or no_price
    expect(sentRequest.yes_price).toBeUndefined();
    expect(sentRequest.no_price).toBeUndefined();
  });

  it('converts decimal limit price to cents for Yes side', async () => {
    const restingResponse: KalshiOrderResponse = {
      order_id: 'kalshi-ord-2',
      ticker: 'ETH-5K',
      action: 'buy',
      side: 'yes',
      count: 10,
      status: 'resting',
      created_time: '2026-02-11T10:00:00Z',
      client_order_id: 'cmd-002',
    };
    mockPlaceOrder.mockResolvedValue(restingResponse);

    const connector = createConnector();

    // Frontend sends decimal price (0.55) and capitalized side ('Yes')
    const order: OrderRequest = {
      market_id: 'ETH-5K',
      venue: 'kalshi',
      side: 'Yes',
      action: 'open',
      size: 10,
      order_type: 'limit',
      limit_price: 0.55,
      command_id: 'cmd-002',
    };

    await connector.placeOrder(order);

    const sentRequest = mockPlaceOrder.mock.calls[0][0];
    expect(sentRequest.type).toBe('limit');
    expect(sentRequest.action).toBe('buy');    // 'open' -> 'buy'
    expect(sentRequest.side).toBe('yes');       // 'Yes' -> 'yes'
    // 0.55 decimal -> 55 cents
    expect(sentRequest.yes_price).toBe(55);
    expect(sentRequest.no_price).toBeUndefined();
  });

  it('converts decimal limit price to cents for No side', async () => {
    const restingResponse: KalshiOrderResponse = {
      order_id: 'kalshi-ord-3',
      ticker: 'BTC-100K',
      action: 'buy',
      side: 'no',
      count: 3,
      status: 'resting',
      created_time: '2026-02-11T10:00:00Z',
      client_order_id: 'cmd-003',
    };
    mockPlaceOrder.mockResolvedValue(restingResponse);

    const connector = createConnector();

    // Frontend sends 'No' (capitalized) and decimal price
    const order: OrderRequest = {
      market_id: 'BTC-100K',
      venue: 'kalshi',
      side: 'No',
      action: 'open',
      size: 3,
      order_type: 'limit',
      limit_price: 0.40,
      command_id: 'cmd-003',
    };

    await connector.placeOrder(order);

    const sentRequest = mockPlaceOrder.mock.calls[0][0];
    expect(sentRequest.side).toBe('no');       // 'No' -> 'no'
    expect(sentRequest.action).toBe('buy');    // 'open' -> 'buy'
    // 0.40 decimal -> 40 cents
    expect(sentRequest.no_price).toBe(40);
    expect(sentRequest.yes_price).toBeUndefined();
  });
});

// ============================================================
// UT-6a.3: Balance retrieval (2 tests)
// ============================================================

describe('UT-6a.3: Kalshi balance retrieval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps API response to Balance type with venue, available, total, and currency', async () => {
    const kalshiBalance: KalshiBalance = {
      balance: 50000, // 500.00 USD in cents
      payout: 10000, // 100.00 USD in cents
    };
    mockGetBalance.mockResolvedValue(kalshiBalance);

    const connector = createConnector();
    const balance: Balance = await connector.getBalance();

    expect(balance.venue).toBe('kalshi');
    expect(balance.available).toBe(500); // 50000 cents -> 500 dollars
    expect(balance.total).toBe(600); // (50000 + 10000) / 100 = 600 dollars
    expect(balance.currency).toBe('USD');
    expect(typeof balance.available).toBe('number');
    expect(typeof balance.total).toBe('number');
  });

  it('throws when API returns an error', async () => {
    mockGetBalance.mockRejectedValue(new Error('Kalshi API error: unauthorized'));

    const connector = createConnector();

    await expect(connector.getBalance()).rejects.toThrow();
  });
});

// ============================================================
// UT-6a.4: Error mapping (4 tests)
// ============================================================

describe('UT-6a.4: Kalshi error mapping', () => {
  it('maps "insufficient_balance" to INSUFFICIENT_BALANCE', () => {
    expect(mapKalshiError('insufficient balance for this order')).toBe('INSUFFICIENT_BALANCE');
    expect(mapKalshiError('Insufficient funds available')).toBe('INSUFFICIENT_BALANCE');
  });

  it('maps "invalid_ticker" to INVALID_ORDER', () => {
    expect(mapKalshiError('invalid ticker: UNKNOWN-MKT')).toBe('INVALID_ORDER');
    expect(mapKalshiError('Invalid order parameters')).toBe('INVALID_ORDER');
  });

  it('maps rate limit errors to RATE_LIMITED', () => {
    expect(mapKalshiError('rate limit exceeded')).toBe('RATE_LIMITED');
    expect(mapKalshiError('Too many requests, slow down')).toBe('RATE_LIMITED');
  });

  it('maps unknown errors to UNKNOWN_ERROR', () => {
    expect(mapKalshiError('something completely unexpected')).toBe('UNKNOWN_ERROR');
    expect(mapKalshiError('')).toBe('UNKNOWN_ERROR');
  });
});
