import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrderRequest, Balance } from '@pumpamp/core';

// ============================================================
// Mock ClobClient to avoid real HTTP calls
// ============================================================

const mockGetOpenOrders = vi.fn();
const mockGetMarket = vi.fn();
const mockCreateOrder = vi.fn();
const mockPostOrder = vi.fn();
const mockCancelOrder = vi.fn();
const mockCancelAll = vi.fn();

vi.mock('@polymarket/clob-client', () => ({
  ClobClient: vi.fn().mockImplementation(() => ({
    getOpenOrders: mockGetOpenOrders,
    getMarket: mockGetMarket,
    createOrder: mockCreateOrder,
    postOrder: mockPostOrder,
    cancelOrder: mockCancelOrder,
    cancelAll: mockCancelAll,
  })),
  Chain: { POLYGON: 137 },
  Side: { BUY: 'BUY', SELL: 'SELL' },
  OrderType: { GTC: 'GTC', FOK: 'FOK' },
}));

vi.mock('@ethersproject/wallet', () => ({
  Wallet: vi.fn().mockImplementation(() => ({})),
}));

const { PolymarketConnector } = await import('../polymarket-connector.js');

function createConnector() {
  return new PolymarketConnector({
    apiUrl: 'https://clob.polymarket.com',
    privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
    apiKey: 'test-api-key',
    apiSecret: 'test-api-secret',
    passphrase: 'test-passphrase',
  });
}

// ============================================================
// ============================================================

describe('Polymarket order formatting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates and posts a buy order with explicit token_id', async () => {
    const signedOrder = { id: 'signed-1' };
    mockGetMarket.mockResolvedValue({
      tokens: [
        { token_id: 'token456', outcome: 'Up' },
        { token_id: 'token789', outcome: 'Down' },
      ],
      maker_base_fee: 500,
      neg_risk: false,
    });
    mockCreateOrder.mockResolvedValue(signedOrder);
    mockPostOrder.mockResolvedValue({ orderID: 'poly-ord-1', success: true });

    const connector = createConnector();
    const order: OrderRequest = {
      market_id: 'polymarket:cond123:token456',
      venue: 'polymarket',
      side: 'Yes',
      action: 'open',
      size: 10,
      order_type: 'limit',
      limit_price: 0.65,
      command_id: 'cmd-001',
    };

    const result = await connector.placeOrder(order);

    // Still fetches market for fee rate, but uses explicit token_id
    expect(mockGetMarket).toHaveBeenCalledWith('cond123');
    expect(mockCreateOrder).toHaveBeenCalledOnce();
    const createArgs = mockCreateOrder.mock.calls[0][0];
    expect(createArgs.tokenID).toBe('token456');
    expect(createArgs.side).toBe('BUY');
    expect(createArgs.price).toBe(0.65);
    expect(createArgs.size).toBe(10);
    expect(createArgs.feeRateBps).toBe(500);

    expect(mockPostOrder).toHaveBeenCalledWith(signedOrder, 'GTC');
    expect(result.order_id).toBe('poly-ord-1');
    expect(result.status).toBe('filled');
  });

  it('uses FOK order type for market orders', async () => {
    mockGetMarket.mockResolvedValue({
      tokens: [
        { token_id: 'token012', outcome: 'Up' },
        { token_id: 'token345', outcome: 'Down' },
      ],
      maker_base_fee: 1000,
      neg_risk: false,
    });
    mockCreateOrder.mockResolvedValue({ id: 'signed-2' });
    mockPostOrder.mockResolvedValue({ orderID: 'poly-ord-2', success: false });

    const connector = createConnector();
    const order: OrderRequest = {
      market_id: 'polymarket:cond789:token012',
      venue: 'polymarket',
      side: 'No',
      action: 'close',
      size: 5,
      order_type: 'market',
      command_id: 'cmd-002',
    };

    const result = await connector.placeOrder(order);

    expect(mockCreateOrder.mock.calls[0][0].side).toBe('SELL');
    expect(mockPostOrder).toHaveBeenCalledWith({ id: 'signed-2' }, 'FOK');
    expect(result.status).toBe('submitted');
  });
});

// ============================================================
// ============================================================

describe('Polymarket condition_id resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves condition_id to YES token_id via getMarket', async () => {
    mockGetMarket.mockResolvedValue({
      tokens: [
        { token_id: '123456789', outcome: 'Up' },
        { token_id: '987654321', outcome: 'Down' },
      ],
      maker_base_fee: 1000,
      neg_risk: false,
    });
    mockCreateOrder.mockResolvedValue({ id: 'signed-3' });
    mockPostOrder.mockResolvedValue({ orderID: 'poly-ord-3', success: true });

    const connector = createConnector();
    const order: OrderRequest = {
      market_id: 'polymarket:0xabcdef1234567890',
      venue: 'polymarket',
      side: 'Yes',
      action: 'open',
      size: 10,
      order_type: 'limit',
      limit_price: 0.55,
      command_id: 'cmd-003',
    };

    const result = await connector.placeOrder(order);

    expect(mockGetMarket).toHaveBeenCalledWith('0xabcdef1234567890');
    const createArgs = mockCreateOrder.mock.calls[0][0];
    expect(createArgs.tokenID).toBe('123456789');
    expect(createArgs.feeRateBps).toBe(1000);
    expect(result.status).toBe('filled');
  });

  it('resolves condition_id to NO token_id when side is No', async () => {
    mockGetMarket.mockResolvedValue({
      tokens: [
        { token_id: '123456789', outcome: 'Up' },
        { token_id: '987654321', outcome: 'Down' },
      ],
      maker_base_fee: 1000,
      neg_risk: false,
    });
    mockCreateOrder.mockResolvedValue({ id: 'signed-4' });
    mockPostOrder.mockResolvedValue({ orderID: 'poly-ord-4', success: true });

    const connector = createConnector();
    const order: OrderRequest = {
      market_id: 'polymarket:0xabcdef1234567890',
      venue: 'polymarket',
      side: 'No',
      action: 'open',
      size: 5,
      order_type: 'limit',
      limit_price: 0.45,
      command_id: 'cmd-004',
    };

    const result = await connector.placeOrder(order);

    expect(mockGetMarket).toHaveBeenCalledOnce();
    expect(mockCreateOrder.mock.calls[0][0].tokenID).toBe('987654321');
    expect(result.status).toBe('filled');
  });

  it('caches token resolution across orders', async () => {
    mockGetMarket.mockResolvedValue({
      tokens: [
        { token_id: '111', outcome: 'Up' },
        { token_id: '222', outcome: 'Down' },
      ],
      maker_base_fee: 1000,
      neg_risk: false,
    });
    mockCreateOrder.mockResolvedValue({ id: 'signed-5' });
    mockPostOrder.mockResolvedValue({ orderID: 'poly-ord-5', success: true });

    const connector = createConnector();
    const base: OrderRequest = {
      market_id: 'polymarket:0xsame_condition',
      venue: 'polymarket',
      side: 'Yes',
      action: 'open',
      size: 10,
      order_type: 'limit',
      limit_price: 0.50,
      command_id: 'cmd-005',
    };

    await connector.placeOrder(base);
    await connector.placeOrder({ ...base, command_id: 'cmd-006' });

    // getMarket should only be called once due to caching
    expect(mockGetMarket).toHaveBeenCalledOnce();
    expect(mockCreateOrder).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// ============================================================

describe('Polymarket health and balance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('connect() uses getOpenOrders as health check', async () => {
    mockGetOpenOrders.mockResolvedValue({ data: [] });

    const connector = createConnector();
    await connector.connect();

    expect(mockGetOpenOrders).toHaveBeenCalledOnce();
    expect(connector.isHealthy()).toBe(true);
  });

  it('getBalance returns placeholder USDC balance', async () => {
    const connector = createConnector();
    const balance: Balance = await connector.getBalance();

    expect(balance.venue).toBe('polymarket');
    expect(balance.currency).toBe('USDC');
  });
});
