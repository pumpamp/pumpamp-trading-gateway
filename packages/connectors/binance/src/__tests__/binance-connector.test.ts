import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrderRequest, Balance } from '@pumpamp/core';
import type { BinanceOrderResponse, BinanceBalance } from '../types.js';

// ============================================================
// Mock BinanceApi to avoid real HTTP calls
// ============================================================

const mockPlaceOrder = vi.fn();
const mockGetBalance = vi.fn();
const mockCancelOrder = vi.fn();
const mockCancelAllOrders = vi.fn();
const mockGetPositions = vi.fn();

vi.mock('../binance-api.js', () => ({
  BinanceApi: vi.fn().mockImplementation(() => ({
    placeOrder: mockPlaceOrder,
    getBalance: mockGetBalance,
    cancelOrder: mockCancelOrder,
    cancelAllOrders: mockCancelAllOrders,
    getPositions: mockGetPositions,
  })),
}));

const { BinanceConnector } = await import('../binance-connector.js');

function createConnector(futures = true) {
  return new BinanceConnector({
    apiUrl: 'https://fapi.binance.com',
    apiKey: 'test-api-key',
    apiSecret: 'test-api-secret',
    futures,
  });
}

// ============================================================
// ============================================================

describe('Binance order formatting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('formats a market order matching Binance API spec', async () => {
    const response: BinanceOrderResponse = {
      orderId: 123456,
      symbol: 'BTCUSDT',
      status: 'FILLED',
      clientOrderId: 'cmd-001',
      price: '0',
      avgPrice: '50000.00',
      origQty: '0.001',
      executedQty: '0.001',
      cumQty: '0.001',
      cumQuote: '50.00',
      timeInForce: 'GTC',
      type: 'MARKET',
      reduceOnly: false,
      closePosition: false,
      side: 'BUY',
      positionSide: 'BOTH',
      stopPrice: '0',
      workingType: 'CONTRACT_PRICE',
      priceProtect: false,
      origType: 'MARKET',
      updateTime: Date.now(),
    };
    mockPlaceOrder.mockResolvedValue(response);

    const connector = createConnector();

    const order: OrderRequest = {
      market_id: 'binance:BTCUSDT',
      venue: 'binance',
      side: 'long',
      action: 'open',
      size: 0.001,
      order_type: 'market',
      command_id: 'cmd-001',
    };

    await connector.placeOrder(order);

    expect(mockPlaceOrder).toHaveBeenCalledOnce();
    const sentParams = mockPlaceOrder.mock.calls[0][0];
    expect(sentParams.symbol).toBe('BTCUSDT');
    expect(sentParams.side).toBe('BUY'); // long + open = BUY
    expect(sentParams.type).toBe('MARKET');
    expect(sentParams.quantity).toBe(0.001);
    // Market orders should NOT have price or timeInForce
    expect(sentParams.price).toBeUndefined();
    expect(sentParams.timeInForce).toBeUndefined();
  });

  it('formats a limit order with price and timeInForce', async () => {
    const response: BinanceOrderResponse = {
      orderId: 789012,
      symbol: 'ETHUSDT',
      status: 'NEW',
      clientOrderId: 'cmd-002',
      price: '3200.50',
      avgPrice: '0',
      origQty: '0.5',
      executedQty: '0',
      cumQty: '0',
      cumQuote: '0',
      timeInForce: 'GTC',
      type: 'LIMIT',
      reduceOnly: false,
      closePosition: false,
      side: 'BUY',
      positionSide: 'BOTH',
      stopPrice: '0',
      workingType: 'CONTRACT_PRICE',
      priceProtect: false,
      origType: 'LIMIT',
      updateTime: Date.now(),
    };
    mockPlaceOrder.mockResolvedValue(response);

    const connector = createConnector();

    const order: OrderRequest = {
      market_id: 'binance:ETHUSDT',
      venue: 'binance',
      side: 'long',
      action: 'open',
      size: 0.5,
      order_type: 'limit',
      limit_price: 3200.50,
      command_id: 'cmd-002',
    };

    await connector.placeOrder(order);

    const sentParams = mockPlaceOrder.mock.calls[0][0];
    expect(sentParams.symbol).toBe('ETHUSDT');
    expect(sentParams.type).toBe('LIMIT');
    expect(sentParams.price).toBe(3200.50);
    expect(sentParams.timeInForce).toBe('GTC');
  });

  it('extracts symbol from market_id with binance: prefix', async () => {
    const response: BinanceOrderResponse = {
      orderId: 345678,
      symbol: 'SOLUSDT',
      status: 'FILLED',
      clientOrderId: 'cmd-003',
      price: '0',
      avgPrice: '150.00',
      origQty: '1',
      executedQty: '1',
      cumQty: '1',
      cumQuote: '150.00',
      timeInForce: 'GTC',
      type: 'MARKET',
      reduceOnly: true,
      closePosition: false,
      side: 'SELL',
      positionSide: 'BOTH',
      stopPrice: '0',
      workingType: 'CONTRACT_PRICE',
      priceProtect: false,
      origType: 'MARKET',
      updateTime: Date.now(),
    };
    mockPlaceOrder.mockResolvedValue(response);

    const connector = createConnector();

    // market_id with prefix
    const order: OrderRequest = {
      market_id: 'binance:SOLUSDT',
      venue: 'binance',
      side: 'long',
      action: 'close',
      size: 1,
      order_type: 'market',
      command_id: 'cmd-003',
    };

    await connector.placeOrder(order);

    const sentParams = mockPlaceOrder.mock.calls[0][0];
    // Symbol should be extracted without the prefix
    expect(sentParams.symbol).toBe('SOLUSDT');
    // Closing a long position = SELL
    expect(sentParams.side).toBe('SELL');
    expect(sentParams.reduceOnly).toBe(true);
  });
});

// ============================================================
// ============================================================

describe('Binance balance retrieval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps futures balance response with venue: "binance"', async () => {
    const futuresBalances: BinanceBalance[] = [
      {
        accountAlias: 'main',
        asset: 'BTC',
        balance: '0.00100000',
        crossWalletBalance: '0.00100000',
        crossUnPnl: '0.00000000',
        availableBalance: '0.00100000',
        maxWithdrawAmount: '0.00100000',
        marginAvailable: true,
        updateTime: Date.now(),
      },
      {
        accountAlias: 'main',
        asset: 'USDT',
        balance: '10000.00000000',
        crossWalletBalance: '10000.00000000',
        crossUnPnl: '0.00000000',
        availableBalance: '8500.00000000',
        maxWithdrawAmount: '8500.00000000',
        marginAvailable: true,
        updateTime: Date.now(),
      },
    ];
    mockGetBalance.mockResolvedValue(futuresBalances);

    const connector = createConnector(true);
    const balance: Balance = await connector.getBalance();

    expect(balance.venue).toBe('binance');
    expect(balance.available).toBe(8500);
    expect(balance.total).toBe(10000);
    expect(balance.currency).toBe('USDT');
    expect(typeof balance.available).toBe('number');
    expect(typeof balance.total).toBe('number');
  });

  it('throws when API returns an error', async () => {
    mockGetBalance.mockRejectedValue(
      new Error('Binance API error: -1021 - Timestamp for this request is outside of the recvWindow')
    );

    const connector = createConnector();

    await expect(connector.getBalance()).rejects.toThrow();
  });
});
