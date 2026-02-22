// Polymarket connector lifecycle tests: auto-derive credentials, getPositions stub

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Balance } from '@pumpamp/core';

const mockGetOpenOrders = vi.fn();
const mockGetMarket = vi.fn();
const mockCreateOrder = vi.fn();
const mockPostOrder = vi.fn();
const mockCancelOrder = vi.fn();
const mockCancelAll = vi.fn();
const mockDeriveApiKey = vi.fn();

// Track ClobClient construction calls to verify re-creation
const clobClientInstances: any[] = [];

vi.mock('@polymarket/clob-client', () => ({
  ClobClient: vi.fn().mockImplementation((...args: any[]) => {
    const instance = {
      getOpenOrders: mockGetOpenOrders,
      getMarket: mockGetMarket,
      createOrder: mockCreateOrder,
      postOrder: mockPostOrder,
      cancelOrder: mockCancelOrder,
      cancelAll: mockCancelAll,
      deriveApiKey: mockDeriveApiKey,
      _constructorArgs: args,
    };
    clobClientInstances.push(instance);
    return instance;
  }),
  Chain: { POLYGON: 137 },
  Side: { BUY: 'BUY', SELL: 'SELL' },
  OrderType: { GTC: 'GTC', FOK: 'FOK' },
}));

vi.mock('@ethersproject/wallet', () => ({
  Wallet: vi.fn().mockImplementation(() => ({})),
}));

const { PolymarketConnector } = await import('../polymarket-connector.js');

beforeEach(() => {
  vi.clearAllMocks();
  clobClientInstances.length = 0;
});

describe('Auto-derive API credentials', () => {
  it('auto-derives credentials when apiKey not provided', async () => {
    mockDeriveApiKey.mockResolvedValue({
      key: 'derived-key',
      secret: 'derived-secret',
      passphrase: 'derived-passphrase',
    });
    mockGetOpenOrders.mockResolvedValue({ data: [] });

    const connector = new PolymarketConnector({
      apiUrl: 'https://clob.polymarket.com',
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      // No apiKey, apiSecret, or passphrase
    });

    await connector.connect();

    // deriveApiKey should have been called
    expect(mockDeriveApiKey).toHaveBeenCalledOnce();

    // A second ClobClient should have been created with derived credentials
    expect(clobClientInstances.length).toBe(2);
    const secondInstance = clobClientInstances[1];
    expect(secondInstance._constructorArgs[3]).toEqual({
      key: 'derived-key',
      secret: 'derived-secret',
      passphrase: 'derived-passphrase',
    });

    expect(connector.isHealthy()).toBe(true);
  });

  it('skips auto-derive when all credentials are provided', async () => {
    mockGetOpenOrders.mockResolvedValue({ data: [] });

    const connector = new PolymarketConnector({
      apiUrl: 'https://clob.polymarket.com',
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      apiKey: 'explicit-key',
      apiSecret: 'explicit-secret',
      passphrase: 'explicit-passphrase',
    });

    await connector.connect();

    // deriveApiKey should NOT have been called
    expect(mockDeriveApiKey).not.toHaveBeenCalled();
    // Only the initial ClobClient created (no re-creation)
    expect(clobClientInstances.length).toBe(1);
    expect(connector.isHealthy()).toBe(true);
  });

  it('auto-derives when apiKey provided but passphrase missing', async () => {
    mockDeriveApiKey.mockResolvedValue({
      key: 'derived-key',
      secret: 'derived-secret',
      passphrase: 'derived-passphrase',
    });
    mockGetOpenOrders.mockResolvedValue({ data: [] });

    const connector = new PolymarketConnector({
      apiUrl: 'https://clob.polymarket.com',
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      apiKey: 'explicit-key',
      apiSecret: 'explicit-secret',
      // passphrase missing
    });

    await connector.connect();

    // Should auto-derive since passphrase is missing
    expect(mockDeriveApiKey).toHaveBeenCalledOnce();
  });

  it('throws connection error when auto-derive fails', async () => {
    mockDeriveApiKey.mockRejectedValue(new Error('derivation failed'));

    const connector = new PolymarketConnector({
      apiUrl: 'https://clob.polymarket.com',
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
    });

    await expect(connector.connect()).rejects.toThrow('Polymarket connection failed: derivation failed');
    expect(connector.isHealthy()).toBe(false);
  });

  it('throws connection error when getOpenOrders health check fails', async () => {
    mockGetOpenOrders.mockRejectedValue(new Error('unauthorized'));

    const connector = new PolymarketConnector({
      apiUrl: 'https://clob.polymarket.com',
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      apiKey: 'bad-key',
      apiSecret: 'bad-secret',
      passphrase: 'bad-passphrase',
    });

    await expect(connector.connect()).rejects.toThrow('Polymarket connection failed: unauthorized');
  });
});

describe('getPositions returns empty (unimplemented)', () => {
  it('returns empty array', async () => {
    const connector = new PolymarketConnector({
      apiUrl: 'https://clob.polymarket.com',
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      apiKey: 'key',
      apiSecret: 'secret',
      passphrase: 'pass',
    });

    const positions = await connector.getPositions();
    expect(positions).toEqual([]);
  });
});

describe('getBalance returns placeholder', () => {
  it('returns zero USDC balance', async () => {
    const connector = new PolymarketConnector({
      apiUrl: 'https://clob.polymarket.com',
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      apiKey: 'key',
      apiSecret: 'secret',
      passphrase: 'pass',
    });

    const balance: Balance = await connector.getBalance();
    expect(balance.venue).toBe('polymarket');
    expect(balance.currency).toBe('USDC');
    expect(balance.available).toBe(0);
    expect(balance.total).toBe(0);
  });
});
