// KalshiConnector position mapping and health check tests

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Position } from '@pumpamp/core';
import type { KalshiPosition } from '../types.js';

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

const { KalshiConnector } = await import('../kalshi-connector.js');

function createConnector() {
  return new KalshiConnector({
    apiUrl: 'https://demo-api.kalshi.co',
    apiKey: 'test-api-key',
    privateKeyPem: '-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Position mapping', () => {
  it('maps positive position to "yes" side with correct entry price', async () => {
    const kalshiPos: KalshiPosition = {
      ticker: 'BTC-100K',
      position: 10,
      market_exposure_cents: 350,
      realized_pnl_cents: 0,
      fees_paid_cents: 20,
      total_traded_cents: 6500,
      resting_orders_count: 0,
    };
    mockGetPositions.mockResolvedValue([kalshiPos]);

    const connector = createConnector();
    const positions: Position[] = await connector.getPositions();

    expect(positions).toHaveLength(1);
    expect(positions[0].venue).toBe('kalshi');
    expect(positions[0].market_id).toBe('BTC-100K');
    expect(positions[0].side).toBe('yes');
    expect(positions[0].size).toBe(10);
    // entry_price = total_traded_cents / (size * 100) = 6500 / 1000 = 6.5
    expect(positions[0].entry_price).toBe(6.5);
    // unrealized_pnl = market_exposure_cents / 100 = 3.50
    expect(positions[0].unrealized_pnl).toBe(3.5);
  });

  it('maps negative position to "no" side with absolute size', async () => {
    const kalshiPos: KalshiPosition = {
      ticker: 'ETH-5K',
      position: -7,
      market_exposure_cents: -200,
      realized_pnl_cents: 50,
      fees_paid_cents: 14,
      total_traded_cents: 2800,
      resting_orders_count: 1,
    };
    mockGetPositions.mockResolvedValue([kalshiPos]);

    const connector = createConnector();
    const positions: Position[] = await connector.getPositions();

    expect(positions).toHaveLength(1);
    expect(positions[0].side).toBe('no');
    expect(positions[0].size).toBe(7); // abs(-7)
    // entry_price = 2800 / (7 * 100) = 4.0
    expect(positions[0].entry_price).toBe(4);
    // unrealized_pnl = -200 / 100 = -2.0
    expect(positions[0].unrealized_pnl).toBe(-2);
  });

  it('handles zero position (size=0, entry_price=0)', async () => {
    const kalshiPos: KalshiPosition = {
      ticker: 'SOL-200',
      position: 0,
      market_exposure_cents: 0,
      realized_pnl_cents: 100,
      fees_paid_cents: 5,
      total_traded_cents: 0,
      resting_orders_count: 0,
    };
    mockGetPositions.mockResolvedValue([kalshiPos]);

    const connector = createConnector();
    const positions: Position[] = await connector.getPositions();

    expect(positions).toHaveLength(1);
    expect(positions[0].size).toBe(0);
    expect(positions[0].entry_price).toBe(0); // Avoids division by zero
    expect(positions[0].side).toBe('yes'); // 0 >= 0, so 'yes'
  });

  it('maps multiple positions correctly', async () => {
    mockGetPositions.mockResolvedValue([
      { ticker: 'A', position: 5, market_exposure_cents: 100, total_traded_cents: 250, realized_pnl_cents: 0, fees_paid_cents: 0, resting_orders_count: 0 },
      { ticker: 'B', position: -3, market_exposure_cents: -50, total_traded_cents: 180, realized_pnl_cents: 0, fees_paid_cents: 0, resting_orders_count: 0 },
    ]);

    const connector = createConnector();
    const positions = await connector.getPositions();

    expect(positions).toHaveLength(2);
    expect(positions[0].market_id).toBe('A');
    expect(positions[1].market_id).toBe('B');
    expect(positions[0].side).toBe('yes');
    expect(positions[1].side).toBe('no');
  });
});

describe('Health check periodic interval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets healthy=true on connect, starts health check interval', async () => {
    mockGetBalance.mockResolvedValue({ balance: 10000, payout: 0 });

    const connector = createConnector();
    await connector.connect();

    expect(connector.isHealthy()).toBe(true);
    expect(mockGetBalance).toHaveBeenCalledOnce();
  });

  it('health check runs every 30 seconds after connect', async () => {
    mockGetBalance.mockResolvedValue({ balance: 10000, payout: 0 });

    const connector = createConnector();
    await connector.connect();

    mockGetBalance.mockClear();

    // Advance 30s - health check fires
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockGetBalance).toHaveBeenCalledOnce();

    // Advance another 30s
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockGetBalance).toHaveBeenCalledTimes(2);
  });

  it('marks connector unhealthy when health check fails', async () => {
    mockGetBalance.mockResolvedValue({ balance: 10000, payout: 0 });

    const connector = createConnector();
    await connector.connect();

    expect(connector.isHealthy()).toBe(true);

    // Next health check fails
    mockGetBalance.mockRejectedValue(new Error('connection refused'));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(connector.isHealthy()).toBe(false);
  });

  it('marks connector healthy again when health check recovers', async () => {
    mockGetBalance.mockResolvedValue({ balance: 10000, payout: 0 });

    const connector = createConnector();
    await connector.connect();

    // Health check fails
    mockGetBalance.mockRejectedValue(new Error('timeout'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connector.isHealthy()).toBe(false);

    // Health check recovers
    mockGetBalance.mockResolvedValue({ balance: 10000, payout: 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connector.isHealthy()).toBe(true);
  });

  it('disconnect clears health check interval', async () => {
    mockGetBalance.mockResolvedValue({ balance: 10000, payout: 0 });

    const connector = createConnector();
    await connector.connect();

    mockGetBalance.mockClear();

    await connector.disconnect();

    // Advance time - no more health checks
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockGetBalance).not.toHaveBeenCalled();
    expect(connector.isHealthy()).toBe(false);
  });
});
