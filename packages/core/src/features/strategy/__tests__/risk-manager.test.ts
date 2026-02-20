import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RiskManager } from '../risk-manager.js';
import type { TradeCommand, Position } from '../../../shared/protocol.js';
import type { RiskLimits } from '../strategy-config.js';

function makeCommand(overrides?: Partial<TradeCommand>): TradeCommand {
  return {
    type: 'trade',
    id: 'cmd-001',
    market_id: 'binance:BTCUSDT',
    venue: 'binance',
    side: 'buy',
    action: 'buy',
    size: 10,
    order_type: 'market',
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<RiskLimits>): RiskLimits {
  return {
    max_trades_per_minute: 5,
    market_cooldown_seconds: 30,
    signal_dedup_window_seconds: 300,
    ...overrides,
  };
}

describe('risk-manager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Rate limit blocks excess trades', () => {
    const rm = new RiskManager(makeConfig({ max_trades_per_minute: 5 }));

    // Record 5 trades (at the limit)
    for (let i = 0; i < 5; i++) {
      rm.recordTrade('binance:BTCUSDT');
    }

    // 6th should be blocked
    const result = rm.evaluate(makeCommand(), []);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('rate_limit_exceeded');
    }
  });

  it('Rate limit allows within limit', () => {
    const rm = new RiskManager(makeConfig({ max_trades_per_minute: 5 }));

    // Record 4 trades
    for (let i = 0; i < 4; i++) {
      rm.recordTrade(`market-${i}`);
    }

    // 5th should be allowed
    const result = rm.evaluate(makeCommand(), []);
    expect(result.allowed).toBe(true);
  });

  it('Cooldown blocks repeat trade', () => {
    const rm = new RiskManager(makeConfig({ market_cooldown_seconds: 30 }));

    rm.recordTrade('binance:BTCUSDT');

    // Same market within cooldown
    const result = rm.evaluate(makeCommand({ market_id: 'binance:BTCUSDT' }), []);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('cooldown_active');
    }
  });

  it('Cooldown allows after window', () => {
    const rm = new RiskManager(makeConfig({ market_cooldown_seconds: 30 }));

    rm.recordTrade('binance:BTCUSDT');

    // Advance past cooldown
    vi.advanceTimersByTime(31_000);

    const result = rm.evaluate(makeCommand({ market_id: 'binance:BTCUSDT' }), []);
    expect(result.allowed).toBe(true);
  });

  it('Max position size blocks oversize', () => {
    const rm = new RiskManager(makeConfig({ max_position_size_per_market: 100 }));

    const positions: Position[] = [
      { venue: 'binance', market_id: 'binance:BTCUSDT', side: 'buy', size: 80, entry_price: 100 },
    ];

    const result = rm.evaluate(makeCommand({ size: 30, market_id: 'binance:BTCUSDT' }), positions);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('max_position_exceeded');
    }
  });

  it('Max position size allows within limit', () => {
    const rm = new RiskManager(makeConfig({ max_position_size_per_market: 100 }));

    const positions: Position[] = [
      { venue: 'binance', market_id: 'binance:BTCUSDT', side: 'buy', size: 60, entry_price: 100 },
    ];

    const result = rm.evaluate(makeCommand({ size: 30, market_id: 'binance:BTCUSDT' }), positions);
    expect(result.allowed).toBe(true);
  });

  it('Max exposure blocks', () => {
    const rm = new RiskManager(makeConfig({ max_total_exposure_usd: 5000 }));

    const positions: Position[] = [
      { venue: 'binance', market_id: 'binance:BTCUSDT', side: 'buy', size: 49, entry_price: 100 },
    ];
    // Existing exposure: 49 * 100 = 4900
    // New trade: size=10, limit_price undefined -> uses 1 as fallback -> 10
    // But for a realistic test, use limit_price:
    const result = rm.evaluate(makeCommand({ size: 2, limit_price: 100 }), positions);
    // New trade value: 2 * 100 = 200, total = 4900 + 200 = 5100 > 5000
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('max_exposure_exceeded');
    }
  });

  it('All checks pass when within limits', () => {
    const rm = new RiskManager(makeConfig({
      max_trades_per_minute: 5,
      market_cooldown_seconds: 30,
      max_position_size_per_market: 100,
      max_total_exposure_usd: 10000,
    }));

    const positions: Position[] = [
      { venue: 'binance', market_id: 'binance:ETHUSDT', side: 'buy', size: 10, entry_price: 100 },
    ];

    const result = rm.evaluate(makeCommand({ size: 5, market_id: 'binance:BTCUSDT' }), positions);
    expect(result.allowed).toBe(true);
  });

  it('recordTrade updates state correctly', () => {
    const rm = new RiskManager(makeConfig({ max_trades_per_minute: 2, market_cooldown_seconds: 30 }));

    rm.recordTrade('binance:BTCUSDT');

    // Rate limit: 1 trade recorded, should still allow (limit is 2)
    const result1 = rm.evaluate(makeCommand({ market_id: 'binance:ETHUSDT' }), []);
    expect(result1.allowed).toBe(true);

    rm.recordTrade('binance:ETHUSDT');

    // Rate limit: 2 trades recorded, should block (limit is 2)
    const result2 = rm.evaluate(makeCommand({ market_id: 'binance:SOLUSDT' }), []);
    expect(result2.allowed).toBe(false);

    // Cooldown: trade for BTCUSDT within window should be blocked
    const result3 = rm.evaluate(makeCommand({ market_id: 'binance:BTCUSDT' }), []);
    expect(result3.allowed).toBe(false);
  });
});
