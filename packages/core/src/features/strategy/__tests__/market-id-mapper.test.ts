import { describe, it, expect } from 'vitest';
import { MarketIdMapper } from '../market-id-mapper.js';

describe('market-id-mapper', () => {
  it('Crypto convention: strip slash', () => {
    const mapper = new MarketIdMapper();
    expect(mapper.resolve('binance:BTC/USDT')).toBe('binance:BTCUSDT');
  });

  it('Crypto convention: no slash passthrough', () => {
    const mapper = new MarketIdMapper();
    expect(mapper.resolve('binance:BTCUSDT')).toBe('binance:BTCUSDT');
  });

  it('Explicit mapping takes priority', () => {
    const mapper = new MarketIdMapper({
      'kalshi:BTC-100K/YES': 'kalshi:KXBTCD-26DEC31',
    });
    expect(mapper.resolve('kalshi:BTC-100K/YES')).toBe('kalshi:KXBTCD-26DEC31');
  });

  it('Unknown prediction market returns null', () => {
    const mapper = new MarketIdMapper({
      'kalshi:BTC-100K/YES': 'kalshi:KXBTCD-26DEC31',
    });
    // Prediction markets (kalshi, polymarket) require explicit mapping
    expect(mapper.resolve('kalshi:UNKNOWN/YES')).toBeNull();
  });

  it('Empty market_id returns null', () => {
    const mapper = new MarketIdMapper();
    expect(mapper.resolve('')).toBeNull();
  });

  it('Multi-segment venue name', () => {
    const mapper = new MarketIdMapper();
    expect(mapper.resolve('hyperliquid:ETH/USD')).toBe('hyperliquid:ETHUSD');
  });

  it('loadMappings replaces mapping table', () => {
    const mapper = new MarketIdMapper({
      'kalshi:OLD/YES': 'kalshi:OLD-MAPPED',
    });
    expect(mapper.resolve('kalshi:OLD/YES')).toBe('kalshi:OLD-MAPPED');

    // Replace with new mappings
    mapper.loadMappings({
      'kalshi:NEW/YES': 'kalshi:NEW-MAPPED',
    });

    // Old mapping no longer resolves (prediction market -> null without explicit mapping)
    expect(mapper.resolve('kalshi:OLD/YES')).toBeNull();
    // New mapping resolves
    expect(mapper.resolve('kalshi:NEW/YES')).toBe('kalshi:NEW-MAPPED');
  });
});
