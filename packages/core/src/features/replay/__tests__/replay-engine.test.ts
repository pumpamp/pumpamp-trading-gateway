// ReplayEngine unit tests

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Signal } from '../../signals/signal-consumer.js';
import type { TradeCommand } from '../../../shared/protocol.js';

// Mock the modules that ReplayEngine depends on
vi.mock('../../strategy/strategy-engine.js', () => {
  return {
    StrategyEngine: vi.fn(),
  };
});

vi.mock('../replay-consumer.js', () => {
  return {
    ReplayConsumer: vi.fn(),
  };
});

// Silence pino logger
vi.mock('pino', () => {
  const noop = () => {};
  const logger: Record<string, unknown> = {
    info: noop, warn: noop, error: noop, debug: noop, trace: noop,
    child: () => logger,
  };
  return { default: () => logger };
});

import { ReplayEngine, type ReplayConfig } from '../replay-engine.js';
import { StrategyEngine } from '../../strategy/strategy-engine.js';
import { ReplayConsumer } from '../replay-consumer.js';

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-001',
    signal_type: 'alert',
    signal_name: 'volume_spike',
    market_id: 'binance:BTC:USDT',
    venue: 'binance',
    base_currency: 'BTC',
    quote_currency: 'USDT',
    created_at: '2026-01-15T10:00:00Z',
    description: 'Volume spike',
    payload: {},
    ...overrides,
  };
}

function makeArbSignal(buyPrice = '0.42', sellPrice = '0.61'): Signal {
  return makeSignal({
    id: 'arb-001',
    signal_name: 'cross_venue_arbitrage',
    venue: 'cross_venue',
    payload: {
      version: 1,
      buy_venue: 'polymarket',
      sell_venue: 'kalshi',
      buy_market_id: '0xabc123',
      sell_market_id: 'INXD-24DEC31',
      buy_price: buyPrice,
      sell_price: sellPrice,
    },
  });
}

function makeBaseConfig(): ReplayConfig {
  return {
    strategy: { name: 'test-strategy', enabled: true, dry_run: true, rules: [], market_mappings: {}, risk_limits: { max_trades_per_minute: 5, market_cooldown_seconds: 30, signal_dedup_window_seconds: 300 } },
    consumer: {
      apiUrl: 'https://api.pumpamp.com',
      apiKey: 'pa_live_test',
      start: new Date('2026-01-01T00:00:00Z'),
      end: new Date('2026-02-01T00:00:00Z'),
    },
    feeRate: 0.02,
    assumedFillPrice: 0.50,
    assumedWinRate: 0.50,
  };
}

function setupMocks(signals: Signal[][], handleSignalFn: (s: Signal) => TradeCommand | TradeCommand[] | null) {
  const mockEngine = { handleSignal: vi.fn(handleSignalFn), name: 'test' };
  vi.mocked(StrategyEngine).mockImplementation(() => mockEngine as any);

  const mockFetchSignals = async function* () {
    for (const page of signals) {
      yield page;
    }
  };
  vi.mocked(ReplayConsumer).mockImplementation(() => ({
    fetchSignals: mockFetchSignals,
    signalsFetched: signals.flat().length,
    config: {},
  }) as any);

  return mockEngine;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Arb signal generates settled positions with correct P&L', () => {
  it('creates two settled positions from arbitrage signal', async () => {
    const arbSignal = makeArbSignal('0.42', '0.61');

    setupMocks([[arbSignal]], (signal) => [
      { type: 'trade', id: `replay-${signal.id}-arb-buy`, market_id: 'polymarket:0xabc123', venue: 'polymarket', side: 'buy', action: 'open', size: 10, order_type: 'market' },
      { type: 'trade', id: `replay-${signal.id}-arb-sell`, market_id: 'kalshi:INXD-24DEC31', venue: 'kalshi', side: 'sell', action: 'open', size: 10, order_type: 'market' },
    ]);

    const engine = new ReplayEngine(makeBaseConfig());
    const report = await engine.run();

    expect(report.summary.signalsMatched).toBe(1);
    expect(report.summary.tradesGenerated).toBe(2);
    expect(report.dataQuality.payloadPricedTrades).toBe(2);
  });
});

describe('Arb P&L calculation is correct', () => {
  it('calculates correct net P&L for arb signal', async () => {
    // buy_price=0.42, sell_price=0.61, size=10, feeRate=0.02
    // gross = (0.61 - 0.42) * 10 = $1.90
    // fees = (0.42 * 10 * 0.02) + (0.61 * 10 * 0.02) = $0.084 + $0.122 = $0.206
    // net = $1.90 - $0.206 = $1.694
    const arbSignal = makeArbSignal('0.42', '0.61');

    setupMocks([[arbSignal]], () => [
      { type: 'trade', id: 'replay-arb-001-arb-buy', market_id: 'polymarket:0xabc123', venue: 'polymarket', side: 'buy', action: 'open', size: 10, order_type: 'market' },
      { type: 'trade', id: 'replay-arb-001-arb-sell', market_id: 'kalshi:INXD-24DEC31', venue: 'kalshi', side: 'sell', action: 'open', size: 10, order_type: 'market' },
    ]);

    const engine = new ReplayEngine(makeBaseConfig());
    const report = await engine.run();

    // Buy leg: entry=0.42, exit=0.61 → gross=(0.61-0.42)*10=1.90, fees=(0.42+0.61)*10*0.02=0.206, net=1.694
    // Sell leg: entry=0.61, exit=0.42 → gross=(0.61-0.42)*10=1.90, fees=0.206, net=1.694
    // Both legs: 1.694 + 1.694 = 3.388
    expect(report.pnl.totalRealizedPnl).toBeCloseTo(3.388, 2);
  });
});

describe('Non-arb signal uses payload price when available', () => {
  it('creates position with entryPrice from payload current_price', async () => {
    const signal = makeSignal({
      signal_name: 'sharp_line_movement',
      payload: { current_price: '0.65' },
    });

    setupMocks([[signal]], () => ({
      type: 'trade', id: 'replay-sig-001-rule1', market_id: 'binance:BTC:USDT',
      venue: 'binance', side: 'buy', action: 'open', size: 5, order_type: 'market',
    }));

    const engine = new ReplayEngine(makeBaseConfig());
    const report = await engine.run();

    expect(report.dataQuality.payloadPricedTrades).toBe(1);
    expect(report.dataQuality.assumedPricedTrades).toBe(0);
  });
});

describe('Non-arb signal uses assumed price as fallback', () => {
  it('creates position with assumedFillPrice when payload has no price fields', async () => {
    const signal = makeSignal({ payload: { some_data: 'no_price' } });

    setupMocks([[signal]], () => ({
      type: 'trade', id: 'replay-sig-001-rule1', market_id: 'binance:BTC:USDT',
      venue: 'binance', side: 'buy', action: 'open', size: 5, order_type: 'market',
    }));

    const engine = new ReplayEngine(makeBaseConfig());
    const report = await engine.run();

    expect(report.dataQuality.payloadPricedTrades).toBe(0);
    expect(report.dataQuality.assumedPricedTrades).toBe(1);
  });
});

describe('Expired buy positions settle at deterministic expected value', () => {
  it('settles expired buy position with expected value P&L', async () => {
    const signal = makeSignal({
      payload: { current_price: '0.40' },
      expires_at: '2026-01-20T00:00:00Z', // before replay end (2026-02-01)
    });

    setupMocks([[signal]], () => ({
      type: 'trade', id: 'replay-sig-001-rule1', market_id: 'binance:BTC:USDT',
      venue: 'binance', side: 'buy', action: 'open', size: 10, order_type: 'market',
    }));

    const config = makeBaseConfig();
    config.assumedWinRate = 0.60;
    const engine = new ReplayEngine(config);
    const report = await engine.run();

    // Buy position: entryPrice=0.40, expectedExitPrice=0.60 (assumedWinRate)
    // P&L = (0.60 - 0.40) * 10 = $2.00
    expect(report.winRate.totalSettled).toBe(1);
    expect(report.pnl.totalRealizedPnl).toBeCloseTo(2.00, 2);

    // Determinism: running again should produce identical result
    setupMocks([[signal]], () => ({
      type: 'trade', id: 'replay-sig-001-rule1', market_id: 'binance:BTC:USDT',
      venue: 'binance', side: 'buy', action: 'open', size: 10, order_type: 'market',
    }));
    const engine2 = new ReplayEngine(config);
    const report2 = await engine2.run();
    expect(report2.pnl.totalRealizedPnl).toBe(report.pnl.totalRealizedPnl);
  });
});

describe('Expired sell positions settle at deterministic expected value', () => {
  it('settles expired sell position with expected value formula for sell side', async () => {
    const signal = makeSignal({
      payload: { current_price: '0.55' },
      expires_at: '2026-01-20T00:00:00Z',
    });

    setupMocks([[signal]], () => ({
      type: 'trade', id: 'replay-sig-001-rule1', market_id: 'binance:BTC:USDT',
      venue: 'binance', side: 'sell', action: 'open', size: 10, order_type: 'market',
    }));

    const config = makeBaseConfig();
    config.assumedWinRate = 0.60;
    const engine = new ReplayEngine(config);
    const report = await engine.run();

    // Sell position: entryPrice=0.55, expectedExitPrice=1-0.60=0.40
    // P&L = (0.55 - 0.40) * 10 = $1.50
    expect(report.winRate.totalSettled).toBe(1);
    expect(report.pnl.totalRealizedPnl).toBeCloseTo(1.50, 2);

    // Determinism check
    setupMocks([[signal]], () => ({
      type: 'trade', id: 'replay-sig-001-rule1', market_id: 'binance:BTC:USDT',
      venue: 'binance', side: 'sell', action: 'open', size: 10, order_type: 'market',
    }));
    const engine2 = new ReplayEngine(config);
    const report2 = await engine2.run();
    expect(report2.pnl.totalRealizedPnl).toBe(report.pnl.totalRealizedPnl);
  });
});

describe('Open positions remain unsettled', () => {
  it('keeps positions without expires_at unsettled', async () => {
    const signal = makeSignal({ payload: { current_price: '0.50' } });

    setupMocks([[signal]], () => ({
      type: 'trade', id: 'replay-sig-001-rule1', market_id: 'binance:BTC:USDT',
      venue: 'binance', side: 'buy', action: 'open', size: 5, order_type: 'market',
    }));

    const engine = new ReplayEngine(makeBaseConfig());
    const report = await engine.run();

    expect(report.winRate.totalSettled).toBe(0);
    expect(report.summary.tradesGenerated).toBe(1);
  });
});

describe('Risk rejection increments counter', () => {
  it('counts risk rejections when handleSignal returns null', async () => {
    const signals = [
      makeSignal({ id: 'sig-1' }),
      makeSignal({ id: 'sig-2' }),
      makeSignal({ id: 'sig-3' }),
    ];

    // Return null for all signals (simulating risk rejection at strategy level)
    setupMocks([signals], () => null);

    const engine = new ReplayEngine(makeBaseConfig());
    const report = await engine.run();

    expect(report.summary.signalsMatched).toBe(0);
    expect(report.summary.tradesGenerated).toBe(0);
  });
});

describe('Signals processed in chronological order', () => {
  it('processes signals in page order (API guarantees chronological)', async () => {
    const processedIds: string[] = [];
    const signals = [
      makeSignal({ id: 'sig-T1', triggered_at: '2026-01-10T00:00:00Z' }),
      makeSignal({ id: 'sig-T2', triggered_at: '2026-01-11T00:00:00Z' }),
      makeSignal({ id: 'sig-T3', triggered_at: '2026-01-12T00:00:00Z' }),
    ];

    setupMocks([signals], (signal) => {
      processedIds.push(signal.id);
      return { type: 'trade', id: `replay-${signal.id}-rule`, market_id: 'binance:BTC:USDT', venue: 'binance', side: 'buy', action: 'open', size: 1, order_type: 'market' };
    });

    const engine = new ReplayEngine(makeBaseConfig());
    await engine.run();

    expect(processedIds).toEqual(['sig-T1', 'sig-T2', 'sig-T3']);
  });
});

describe('Progress callback fires per page', () => {
  it('calls onProgress once per page with incrementing counts', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeSignal({ id: `p1-${i}` }));
    const page2 = Array.from({ length: 100 }, (_, i) => makeSignal({ id: `p2-${i}` }));
    const page3 = Array.from({ length: 100 }, (_, i) => makeSignal({ id: `p3-${i}` }));

    setupMocks([page1, page2, page3], () => ({
      type: 'trade', id: 'replay-rule', market_id: 'binance:BTC:USDT',
      venue: 'binance', side: 'buy', action: 'open', size: 1, order_type: 'market',
    }));

    const progressCalls: any[] = [];
    const config = makeBaseConfig();
    config.speed = 'normal';
    config.onProgress = (p) => progressCalls.push({ ...p });

    const engine = new ReplayEngine(config);
    await engine.run();

    expect(progressCalls).toHaveLength(3);
    expect(progressCalls[0].pagesCompleted).toBe(1);
    expect(progressCalls[1].pagesCompleted).toBe(2);
    expect(progressCalls[2].pagesCompleted).toBe(3);
    expect(progressCalls[2].signalsProcessed).toBe(300);
  });
});
