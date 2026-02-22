// Replay integration tests

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Signal } from '../../signals/signal-consumer.js';

// Mock modules
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
import type { TradeCommand } from '../../../shared/protocol.js';

function makeArbSignal(id: string, buyPrice: string, sellPrice: string, date: string): Signal {
  return {
    id,
    signal_type: 'alert',
    signal_name: 'cross_venue_arbitrage',
    market_id: `cross_venue:${id}`,
    venue: 'cross_venue',
    base_currency: 'USD',
    quote_currency: 'USD',
    created_at: date,
    triggered_at: date,
    description: 'Cross-venue arb opportunity',
    payload: {
      version: 1,
      buy_venue: 'polymarket',
      sell_venue: 'kalshi',
      buy_market_id: `poly-${id}`,
      sell_market_id: `kalshi-${id}`,
      buy_price: buyPrice,
      sell_price: sellPrice,
    },
  };
}

function makeBaseConfig(): ReplayConfig {
  return {
    strategy: {
      name: 'prediction-arb',
      enabled: true,
      dry_run: true,
      rules: [{
        name: 'arb',
        enabled: true,
        signal_types: ['alert' as const],
        signal_names: ['cross_venue_arbitrage'],
        action: { side: 'buy', size: 10, order_type: 'market' as const },
      }],
      market_mappings: {},
      risk_limits: { max_trades_per_minute: 5, market_cooldown_seconds: 30, signal_dedup_window_seconds: 300 },
    },
    consumer: {
      apiUrl: 'https://api.pumpamp.com',
      apiKey: 'pa_live_test',
      start: new Date('2026-01-01T00:00:00Z'),
      end: new Date('2026-02-01T00:00:00Z'),
    },
    feeRate: 0.02,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Full replay with arbitrage signals produces correct report', () => {
  it('processes 10 arb signals and generates complete report', async () => {
    // Create 10 arb signals across 2 pages
    const page1 = Array.from({ length: 5 }, (_, i) =>
      makeArbSignal(`arb-${i}`, '0.40', '0.55', `2026-01-${10 + i}T10:00:00Z`),
    );
    const page2 = Array.from({ length: 5 }, (_, i) =>
      makeArbSignal(`arb-${5 + i}`, '0.45', '0.60', `2026-01-${15 + i}T10:00:00Z`),
    );

    const mockEngine = {
      handleSignal: vi.fn((signal: Signal): TradeCommand[] => [
        {
          type: 'trade',
          id: `replay-${signal.id}-arb-buy`,
          market_id: `polymarket:poly-${signal.id}`,
          venue: 'polymarket',
          side: 'buy',
          action: 'open',
          size: 10,
          order_type: 'market',
        },
        {
          type: 'trade',
          id: `replay-${signal.id}-arb-sell`,
          market_id: `kalshi:kalshi-${signal.id}`,
          venue: 'kalshi',
          side: 'sell',
          action: 'open',
          size: 10,
          order_type: 'market',
        },
      ]),
      name: 'prediction-arb',
    };
    vi.mocked(StrategyEngine).mockImplementation(() => mockEngine as any);

    const mockFetchSignals = async function* () {
      yield page1;
      yield page2;
    };
    vi.mocked(ReplayConsumer).mockImplementation(() => ({
      fetchSignals: mockFetchSignals,
      signalsFetched: 10,
      config: {},
    }) as any);

    const engine = new ReplayEngine(makeBaseConfig());
    const report = await engine.run();

    expect(report.summary.totalSignals).toBe(10);
    expect(report.summary.signalsMatched).toBeGreaterThan(0);
    expect(report.pnl.totalRealizedPnl).not.toBe(0);
    expect(report.winRate.winRate).toBeGreaterThanOrEqual(0);
    expect(report.winRate.winRate).toBeLessThanOrEqual(1);
    expect(report.risk.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(report.dataQuality.payloadPricedTrades).toBe(report.summary.tradesGenerated);
  });
});

describe('Strategy comparison produces side-by-side results', () => {
  it('returns array of results with matching signal counts', async () => {
    const signals = Array.from({ length: 5 }, (_, i) =>
      makeArbSignal(`arb-${i}`, '0.42', '0.58', `2026-01-${10 + i}T10:00:00Z`),
    );

    // Mock for compare mode -- ReplayConsumer is used once for fetching, then engines use cached
    const mockFetchSignals = async function* () {
      yield signals;
    };
    vi.mocked(ReplayConsumer).mockImplementation(() => ({
      fetchSignals: mockFetchSignals,
      signalsFetched: 5,
      config: {},
    }) as any);

    const engineInstances: any[] = [];
    vi.mocked(StrategyEngine).mockImplementation((config: any) => {
      const instance = {
        handleSignal: vi.fn((signal: Signal): TradeCommand[] | null => {
          if (config.name === 'prediction-arb') {
            return [
              { type: 'trade', id: `replay-${signal.id}-buy`, market_id: 'poly:test', venue: 'polymarket', side: 'buy', action: 'open', size: 10, order_type: 'market' },
              { type: 'trade', id: `replay-${signal.id}-sell`, market_id: 'kalshi:test', venue: 'kalshi', side: 'sell', action: 'open', size: 10, order_type: 'market' },
            ];
          }
          // Second strategy matches fewer signals
          return Math.random() > 0.5 ? [{
            type: 'trade', id: `replay-${signal.id}-rule`, market_id: signal.market_id, venue: signal.venue, side: 'buy', action: 'open', size: 5, order_type: 'market',
          } as TradeCommand] : null;
        }),
        name: config.name,
      };
      engineInstances.push(instance);
      return instance as any;
    });

    const results = await ReplayEngine.compare(
      [
        { name: 'prediction-arb', config: { name: 'prediction-arb', enabled: true, dry_run: true, rules: [], market_mappings: {}, risk_limits: { max_trades_per_minute: 5, market_cooldown_seconds: 30, signal_dedup_window_seconds: 300 } } },
        { name: 'sharp-line', config: { name: 'sharp-line', enabled: true, dry_run: true, rules: [], market_mappings: {}, risk_limits: { max_trades_per_minute: 5, market_cooldown_seconds: 30, signal_dedup_window_seconds: 300 } } },
      ],
      {
        apiUrl: 'https://api.pumpamp.com',
        apiKey: 'pa_live_test',
        start: new Date('2026-01-01T00:00:00Z'),
        end: new Date('2026-02-01T00:00:00Z'),
      },
      { feeRate: 0.02 },
    );

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('prediction-arb');
    expect(results[1].name).toBe('sharp-line');

    // Both process same total signal count
    expect(results[0].report.summary.totalSignals).toBe(results[1].report.summary.totalSignals);
  });
});
