// Replay performance test

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Signal } from '../../signals/signal-consumer.js';
import type { TradeCommand } from '../../../shared/protocol.js';

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

function makeSignal(id: string, date: string): Signal {
  return {
    id,
    signal_type: 'alert',
    signal_name: 'cross_venue_arbitrage',
    market_id: 'cross_venue:test',
    venue: 'cross_venue',
    base_currency: 'USD',
    quote_currency: 'USD',
    created_at: date,
    triggered_at: date,
    description: 'Test arb signal',
    payload: {
      buy_venue: 'polymarket',
      sell_venue: 'kalshi',
      buy_market_id: 'poly-test',
      sell_market_id: 'kalshi-test',
      buy_price: '0.42',
      sell_price: '0.58',
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Replay completes under 30s for 10,000-signal window', () => {
  it('processes 10,000 signals within 30 seconds', async () => {
    // Generate 10,000 signals across 10 pages of 1000
    const pages: Signal[][] = [];
    for (let page = 0; page < 10; page++) {
      const signals: Signal[] = [];
      for (let i = 0; i < 1000; i++) {
        const idx = page * 1000 + i;
        const day = Math.floor(idx / 333) + 1;
        const paddedDay = String(day).padStart(2, '0');
        signals.push(makeSignal(`sig-${idx}`, `2026-01-${paddedDay}T${String(idx % 24).padStart(2, '0')}:00:00Z`));
      }
      pages.push(signals);
    }

    // Mock strategy engine to return commands for each signal
    const mockEngine = {
      handleSignal: vi.fn((_signal: Signal): TradeCommand[] => [
        { type: 'trade', id: 'replay-buy', market_id: 'poly:test', venue: 'polymarket', side: 'buy', action: 'open', size: 10, order_type: 'market' },
        { type: 'trade', id: 'replay-sell', market_id: 'kalshi:test', venue: 'kalshi', side: 'sell', action: 'open', size: 10, order_type: 'market' },
      ]),
      name: 'test',
    };
    vi.mocked(StrategyEngine).mockImplementation(() => mockEngine as any);

    // Mock consumer with simulated <=50ms latency per page
    const mockFetchSignals = async function* () {
      for (const page of pages) {
        // Simulate minimal network latency (no actual delay in test)
        yield page;
      }
    };
    vi.mocked(ReplayConsumer).mockImplementation(() => ({
      fetchSignals: mockFetchSignals,
      signalsFetched: 10000,
      config: {},
    }) as any);

    const config: ReplayConfig = {
      strategy: { name: 'perf-test', enabled: true, dry_run: true, rules: [], market_mappings: {}, risk_limits: { max_trades_per_minute: 5, market_cooldown_seconds: 30, signal_dedup_window_seconds: 300 } },
      consumer: {
        apiUrl: 'https://api.pumpamp.com',
        apiKey: 'test',
        start: new Date('2026-01-01T00:00:00Z'),
        end: new Date('2026-02-01T00:00:00Z'),
      },
      feeRate: 0.02,
      speed: 'fast',
    };

    const startTime = performance.now();
    const engine = new ReplayEngine(config);
    const report = await engine.run();
    const elapsed = performance.now() - startTime;

    // Verify correctness
    expect(report.summary.totalSignals).toBe(10000);
    expect(report.summary.tradesGenerated).toBe(20000); // 2 per signal

    // Must complete under 30 seconds
    expect(elapsed).toBeLessThan(30000);

    // Emit runtime for baseline tracking
    console.log(`Replay of 10,000 signals completed in ${elapsed.toFixed(0)}ms`);
  });
});
