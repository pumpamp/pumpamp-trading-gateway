import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrategyEngine } from '../strategy-engine.js';
import type { Signal } from '../../signals/signal-consumer.js';
import {
  createTestSignal,
  createTestRule,
  createTestConfig,
} from './fixtures/strategy-test-helpers.js';

function createArbSignal(overrides?: Partial<Signal>): Signal {
  return {
    id: 'sig-arb-001',
    signal_type: 'alert',
    signal_name: 'cross_venue_arbitrage',
    market_id: 'kalshi:KXBTCD-26FEB11',
    venue: 'kalshi',
    base_currency: 'BTC',
    quote_currency: 'YES',
    created_at: new Date().toISOString(),
    confidence: '85',
    severity: 'High',
    direction: 'above',
    description: 'Cross-venue arbitrage opportunity',
    payload: {
      version: 1,
      pair_id: 'BTC-100K',
      pair_name: 'Bitcoin $100K',
      direction: 'buy_kalshi_sell_poly',
      buy_venue: 'kalshi',
      sell_venue: 'polymarket',
      buy_market_id: 'KXBTCD-26FEB11',
      sell_market_id: '0xabc123:0',
      buy_price: '0.45',
      sell_price: '0.58',
      gross_spread_pct: '13.0',
      net_spread_pct: '10.5',
      liquidity_used_usd: '5000',
      potential_profit_usd: '525',
      emitted_at: new Date().toISOString(),
    },
    ...overrides,
  };
}

function createArbConfig(overrides?: Partial<Parameters<typeof createTestConfig>[0]>) {
  return createTestConfig({
    dry_run: false,
    rules: [
      createTestRule({
        name: 'arb_rule',
        signal_types: ['alert'],
        signal_names: ['cross_venue_arbitrage'],
        venues: ['kalshi', 'polymarket'],
        min_confidence: 70,
        action: { side: 'from_signal', size: 25, order_type: 'market' },
      }),
    ],
    ...overrides,
  });
}

describe('strategy-engine-arb', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Arbitrage signal generates two commands', () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);

    const signal = createArbSignal();
    const result = engine.handleSignal(signal);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it('Buy command uses buy_venue and buy_market_id', () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);

    const signal = createArbSignal();
    const result = engine.handleSignal(signal);

    expect(Array.isArray(result)).toBe(true);
    const commands = result as any[];
    const buyCmd = commands[0];

    expect(buyCmd.venue).toBe('kalshi');
    expect(buyCmd.market_id).toBe('kalshi:KXBTCD-26FEB11');
    expect(buyCmd.side).toBe('buy');
  });

  it('Sell command uses sell_venue and sell_market_id', () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);

    const signal = createArbSignal();
    const result = engine.handleSignal(signal);

    expect(Array.isArray(result)).toBe(true);
    const commands = result as any[];
    const sellCmd = commands[1];

    expect(sellCmd.venue).toBe('polymarket');
    expect(sellCmd.market_id).toBe('polymarket:0xabc123:0');
    expect(sellCmd.side).toBe('sell');
  });

  it('Missing payload fields returns null', () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);

    const signal = createArbSignal({
      payload: {
        version: 1,
        pair_id: 'BTC-100K',
        // Missing buy_market_id, sell_market_id, etc.
      },
    });

    const result = engine.handleSignal(signal);
    expect(result).toBeNull();
  });

  it('Risk check applied to both legs (both rejected if one fails)', () => {
    const config = createArbConfig({
      risk_limits: {
        max_trades_per_minute: 1,
        market_cooldown_seconds: 0,
        signal_dedup_window_seconds: 300,
      },
    });
    const _engine = new StrategyEngine(config, () => []);

    // Use up the rate limit with a regular trade
    const _regularSignal = createTestSignal({ id: 'pre-trade', direction: 'long' });
    // Force a regular signal match by adding a compatible rule
    const configWithBoth = createArbConfig({
      rules: [
        createTestRule({
          name: 'regular_rule',
          signal_types: ['strategy'],
          venues: ['binance'],
          action: { side: 'buy', size: 1, order_type: 'market' },
        }),
        createTestRule({
          name: 'arb_rule',
          signal_types: ['alert'],
          signal_names: ['cross_venue_arbitrage'],
          venues: ['kalshi', 'polymarket'],
          min_confidence: 70,
          action: { side: 'from_signal', size: 25, order_type: 'market' },
        }),
      ],
      risk_limits: {
        max_trades_per_minute: 1,
        market_cooldown_seconds: 0,
        signal_dedup_window_seconds: 300,
      },
    });

    const engine2 = new StrategyEngine(configWithBoth, () => []);

    // First signal: generate and record a regular trade
    const cmd1 = engine2.handleSignal(createTestSignal({ id: 'fill-limit', direction: 'long' }));
    expect(cmd1).not.toBeNull();
    engine2.recordExecutedTrade((cmd1 as any).market_id);

    // Arb signal should be rejected due to rate limit
    vi.advanceTimersByTime(100);
    const arbSignal = createArbSignal({ id: 'arb-risk-test' });
    const result = engine2.handleSignal(arbSignal);
    expect(result).toBeNull();

    const status = engine2.getStatus();
    expect(status.trades_rejected_by_risk).toBeGreaterThanOrEqual(1);
  });

  it('Dry-run mode logs both legs (dry_run_trades incremented, not trades_generated)', () => {
    const config = createArbConfig({ dry_run: true });
    const engine = new StrategyEngine(config, () => []);

    const dryRunHandler = vi.fn();
    engine.on('dry_run_trade', dryRunHandler);

    const signal = createArbSignal();
    const result = engine.handleSignal(signal);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(dryRunHandler).toHaveBeenCalledTimes(2);

    const status = engine.getStatus();
    expect(status.dry_run_trades).toBe(2);
    expect(status.trades_generated).toBe(0);
  });

  it('Non-arb signal still returns single command', () => {
    const config = createTestConfig({
      dry_run: false,
      rules: [
        createTestRule({
          signal_types: ['strategy'],
          venues: ['binance'],
          min_confidence: 70,
        }),
      ],
    });
    const engine = new StrategyEngine(config, () => []);

    const signal = createTestSignal({
      signal_type: 'strategy',
      venue: 'binance',
      confidence: '85',
      direction: 'long',
    });

    const result = engine.handleSignal(signal);
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(false);
    expect((result as any).type).toBe('trade');
  });

  it('Arb signal with low confidence returns null', () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);

    const signal = createArbSignal({
      confidence: '30', // Below min_confidence of 70
    });

    const result = engine.handleSignal(signal);
    expect(result).toBeNull();
  });

  it('Super-hedge signal uses outcome sides with action open', () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);

    const signal = createArbSignal({
      payload: {
        ...(createArbSignal().payload as Record<string, unknown>),
        strategy: 'super_hedge',
        buy_outcome: 'Yes',
        sell_outcome: 'No',
        pattern: 'A',
      },
    });

    const result = engine.handleSignal(signal);
    expect(Array.isArray(result)).toBe(true);
    const commands = result as any[];
    expect(commands).toHaveLength(2);

    // Buy leg: side = buy_outcome ('Yes'), action = 'open'
    expect(commands[0].side).toBe('Yes');
    expect(commands[0].action).toBe('open');

    // Sell leg: side = sell_outcome ('No'), action = 'open'
    expect(commands[1].side).toBe('No');
    expect(commands[1].action).toBe('open');
  });

  it('Super-hedge PatternB uses reversed outcome sides', () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);

    const signal = createArbSignal({
      payload: {
        ...(createArbSignal().payload as Record<string, unknown>),
        strategy: 'super_hedge',
        buy_outcome: 'No',
        sell_outcome: 'Yes',
        pattern: 'B',
      },
    });

    const result = engine.handleSignal(signal);
    expect(Array.isArray(result)).toBe(true);
    const commands = result as any[];

    expect(commands[0].side).toBe('No');
    expect(commands[0].action).toBe('open');
    expect(commands[1].side).toBe('Yes');
    expect(commands[1].action).toBe('open');
  });

  it('Directional signal uses standard buy/sell', () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);

    const signal = createArbSignal({
      payload: {
        ...(createArbSignal().payload as Record<string, unknown>),
        strategy: 'directional',
      },
    });

    const result = engine.handleSignal(signal);
    expect(Array.isArray(result)).toBe(true);
    const commands = result as any[];

    expect(commands[0].side).toBe('buy');
    expect(commands[0].action).toBe('buy');
    expect(commands[1].side).toBe('sell');
    expect(commands[1].action).toBe('sell');
  });

  it('Signal without strategy uses directional fallback', () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);

    const signal = createArbSignal(); // No strategy field
    const result = engine.handleSignal(signal);
    expect(Array.isArray(result)).toBe(true);
    const commands = result as any[];

    // Should use standard buy/sell (no strategy = directional fallback)
    expect(commands[0].side).toBe('buy');
    expect(commands[1].side).toBe('sell');
  });

  it('Signal past cutoff returns null', () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);

    const pastCutoff = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    const signal = createArbSignal({
      payload: {
        ...(createArbSignal().payload as Record<string, unknown>),
        signal_cutoff_utc: pastCutoff,
      },
    });

    const result = engine.handleSignal(signal);
    expect(result).toBeNull();
  });

  it('window_end_utc fallback allows signal when far from settlement', () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);

    const futureWindowEnd = new Date(Date.now() + 10 * 60_000).toISOString();
    const signal = createArbSignal({
      payload: {
        ...(createArbSignal().payload as Record<string, unknown>),
        window_end_utc: futureWindowEnd,
      },
    });

    const result = engine.handleSignal(signal);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it('window_end_utc fallback rejects signal within 15s of settlement', () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);

    const nearWindowEnd = new Date(Date.now() + 10_000).toISOString(); // 10s from now
    const signal = createArbSignal({
      payload: {
        ...(createArbSignal().payload as Record<string, unknown>),
        window_end_utc: nearWindowEnd,
      },
    });

    const result = engine.handleSignal(signal);
    expect(result).toBeNull();
  });

  it('Signal without cutoff generates commands', () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);

    const signal = createArbSignal(); // No signal_cutoff_utc
    const result = engine.handleSignal(signal);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it('signal_cutoff_utc takes precedence over window_end_utc', () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);

    const pastCutoff = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    const futureWindow = new Date(Date.now() + 600_000).toISOString(); // 10 min from now
    const signal = createArbSignal({
      payload: {
        ...(createArbSignal().payload as Record<string, unknown>),
        signal_cutoff_utc: pastCutoff,
        window_end_utc: futureWindow,
      },
    });

    const result = engine.handleSignal(signal);
    expect(result).toBeNull(); // Rejected by cutoff even though window_end is far away
  });
});
