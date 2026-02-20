import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrderRequest, Balance } from '@pumpamp/core';

// ============================================================
// Mock HyperliquidApi to avoid real HTTP calls
// ============================================================

const mockPlaceOrder = vi.fn();
const mockGetBalance = vi.fn();
const mockCancelOrder = vi.fn();
const mockCancelAllOrders = vi.fn();
const mockGetPositions = vi.fn();
const mockGetMeta = vi.fn();
const mockGetClearinghouseState = vi.fn();

vi.mock('../hyperliquid-api.js', () => ({
  HyperliquidApi: vi.fn().mockImplementation(() => ({
    placeOrder: mockPlaceOrder,
    getBalance: mockGetBalance,
    cancelOrder: mockCancelOrder,
    cancelAllOrders: mockCancelAllOrders,
    getPositions: mockGetPositions,
    getMeta: mockGetMeta,
    getClearinghouseState: mockGetClearinghouseState,
  })),
}));

const { HyperliquidConnector } = await import('../hyperliquid-connector.js');

function createConnector() {
  return new HyperliquidConnector({
    privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
  });
}

async function createConnectedConnector() {
  // Set up meta response so connect() builds the asset map
  mockGetMeta.mockResolvedValue({
    universe: [
      { name: 'BTC', szDecimals: 5 },
      { name: 'ETH', szDecimals: 4 },
      { name: 'SOL', szDecimals: 2 },
    ],
  });
  mockGetClearinghouseState.mockResolvedValue({
    assetPositions: [],
    marginSummary: { accountValue: '10000.00', totalNtlPos: '0', totalRawUsd: '10000.00' },
    crossMarginSummary: { crossMaintenanceMarginUsed: '0' },
    withdrawable: '10000.00',
  });

  const connector = createConnector();
  await connector.connect();
  return connector;
}

// ============================================================
// UT-6c.2: Order formatting (3 tests)
// ============================================================

describe('UT-6c.2: Hyperliquid order formatting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('formats a market order action correctly', async () => {
    mockPlaceOrder.mockResolvedValue({
      status: 'ok',
      response: {
        type: 'order',
        data: {
          statuses: [
            { filled: { oid: 12345, totalSz: '0.001000', avgPx: '50000.00' } },
          ],
        },
      },
    });

    const connector = await createConnectedConnector();

    const order: OrderRequest = {
      market_id: 'BTC',
      venue: 'hyperliquid',
      side: 'long',
      action: 'open',
      size: 0.001,
      order_type: 'market',
      command_id: 'cmd-001',
    };

    await connector.placeOrder(order);

    expect(mockPlaceOrder).toHaveBeenCalledOnce();
    const sentOrder = mockPlaceOrder.mock.calls[0][0];
    expect(sentOrder.a).toBe(0); // BTC is index 0
    expect(sentOrder.b).toBe(true); // long + open = buy
    expect(sentOrder.s).toBe('0.001000');
    expect(sentOrder.r).toBe(false); // not reduce-only for open
    expect(sentOrder.t.limit.tif).toBe('Ioc'); // Market orders use IoC
  });

  it('formats a limit order with price and size', async () => {
    mockPlaceOrder.mockResolvedValue({
      status: 'ok',
      response: {
        type: 'order',
        data: {
          statuses: [
            { resting: { oid: 67890 } },
          ],
        },
      },
    });

    const connector = await createConnectedConnector();

    const order: OrderRequest = {
      market_id: 'ETH',
      venue: 'hyperliquid',
      side: 'long',
      action: 'open',
      size: 0.5,
      order_type: 'limit',
      limit_price: 3200.50,
      command_id: 'cmd-002',
    };

    await connector.placeOrder(order);

    const sentOrder = mockPlaceOrder.mock.calls[0][0];
    expect(sentOrder.a).toBe(1); // ETH is index 1
    expect(sentOrder.b).toBe(true); // long + open = buy
    expect(sentOrder.p).toBe('3200.50');
    expect(sentOrder.s).toBe('0.500000');
    expect(sentOrder.t.limit.tif).toBe('Gtc'); // Limit orders use GTC
  });

  it('maps asset name from market_id to asset index', async () => {
    mockPlaceOrder.mockResolvedValue({
      status: 'ok',
      response: {
        type: 'order',
        data: {
          statuses: [
            { filled: { oid: 11111, totalSz: '1.00', avgPx: '150.00' } },
          ],
        },
      },
    });

    const connector = await createConnectedConnector();

    // SOL is at index 2 in our mocked meta
    const order: OrderRequest = {
      market_id: 'SOL',
      venue: 'hyperliquid',
      side: 'short',
      action: 'close',
      size: 1.0,
      order_type: 'market',
      command_id: 'cmd-003',
    };

    await connector.placeOrder(order);

    const sentOrder = mockPlaceOrder.mock.calls[0][0];
    expect(sentOrder.a).toBe(2); // SOL is index 2
    // short + close = buy (closing a short position)
    expect(sentOrder.b).toBe(true);
    expect(sentOrder.r).toBe(true); // reduce-only for close
  });
});

// ============================================================
// UT-6c.3: Balance retrieval (2 tests)
// ============================================================

describe('UT-6c.3: Hyperliquid balance retrieval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts balance from clearinghouseState with venue: "hyperliquid"', async () => {
    mockGetBalance.mockResolvedValue({
      available: 8500.25,
      total: 10000.00,
    });

    const connector = await createConnectedConnector();
    const balance: Balance = await connector.getBalance();

    expect(balance.venue).toBe('hyperliquid');
    expect(balance.available).toBe(8500.25);
    expect(balance.total).toBe(10000.00);
    expect(balance.currency).toBe('USDC');
    expect(typeof balance.available).toBe('number');
    expect(typeof balance.total).toBe('number');
  });

  it('throws when API returns an error', async () => {
    mockGetBalance.mockRejectedValue(
      new Error('Hyperliquid info error: 500 Internal Server Error')
    );

    const connector = await createConnectedConnector();

    await expect(connector.getBalance()).rejects.toThrow();
  });
});
