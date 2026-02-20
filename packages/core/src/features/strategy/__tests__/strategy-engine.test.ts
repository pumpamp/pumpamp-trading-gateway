import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrategyEngine } from '../strategy-engine.js';
import type { TradeCommand } from '../../../shared/protocol.js';
import {
  createTestSignal,
  createTestRule,
  createTestConfig,
} from './fixtures/strategy-test-helpers.js';

describe('strategy-engine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Signal matches rule and generates command', () => {
    const config = createTestConfig({ dry_run: false });
    const engine = new StrategyEngine(config, () => []);

    const signal = createTestSignal({
      signal_type: 'strategy',
      venue: 'binance',
      confidence: '85',
      direction: 'long',
    });

    const result = engine.handleSignal(signal);
    expect(result).not.toBeNull();
    const command = result as TradeCommand;
    expect(command.type).toBe('trade');
    expect(command.market_id).toBe('binance:BTCUSDT');
    expect(command.venue).toBe('binance');
    expect(command.side).toBe('buy');
    expect(command.size).toBe(0.01);
  });

  it('Unmapped market_id skips signal', () => {
    const config = createTestConfig({
      dry_run: false,
      rules: [createTestRule({
        venues: ['kalshi'],
        signal_types: ['strategy'],
      })],
    });
    const engine = new StrategyEngine(config, () => []);

    // kalshi is a prediction market - needs explicit mapping which we don't provide
    const signal = createTestSignal({
      signal_type: 'strategy',
      venue: 'kalshi',
      market_id: 'kalshi:UNMAPPED/YES',
      confidence: '85',
      direction: 'long',
    });

    const command = engine.handleSignal(signal);
    expect(command).toBeNull();
  });

  it('Signal matches no rules', () => {
    const config = createTestConfig({ dry_run: false });
    const engine = new StrategyEngine(config, () => []);

    const signal = createTestSignal({
      signal_type: 'alert', // Rule expects 'strategy'
    });

    const command = engine.handleSignal(signal);
    expect(command).toBeNull();
  });

  it('Disabled engine drops signals', () => {
    const config = createTestConfig({ dry_run: false });
    const engine = new StrategyEngine(config, () => []);
    engine.disable();

    const signal = createTestSignal();
    const command = engine.handleSignal(signal);
    expect(command).toBeNull();
  });

  it('Re-enabled engine processes signals', () => {
    const config = createTestConfig({ dry_run: false });
    const engine = new StrategyEngine(config, () => []);

    engine.disable();
    expect(engine.handleSignal(createTestSignal())).toBeNull();

    engine.enable();
    const signal = createTestSignal({ direction: 'long', confidence: '85' });
    const command = engine.handleSignal(signal);
    expect(command).not.toBeNull();
  });

  it('Risk rejection prevents command', () => {
    const config = createTestConfig({
      dry_run: false,
      risk_limits: {
        max_trades_per_minute: 1,
        market_cooldown_seconds: 0,
        signal_dedup_window_seconds: 300,
      },
    });
    const engine = new StrategyEngine(config, () => []);

    // First signal: succeeds and records trade
    const signal1 = createTestSignal({ id: 'sig-1', direction: 'long' });
    const cmd1 = engine.handleSignal(signal1) as TradeCommand;
    expect(cmd1).not.toBeNull();
    engine.recordExecutedTrade(cmd1.market_id);

    // Second signal: rate limited
    vi.advanceTimersByTime(100);
    const signal2 = createTestSignal({ id: 'sig-2', direction: 'long' });
    const cmd2 = engine.handleSignal(signal2);
    expect(cmd2).toBeNull();

    const status = engine.getStatus();
    expect(status.trades_rejected_by_risk).toBe(1);
  });

  it('Dry-run mode emits event but returns command', () => {
    const config = createTestConfig({ dry_run: true });
    const engine = new StrategyEngine(config, () => []);

    const dryRunHandler = vi.fn();
    engine.on('dry_run_trade', dryRunHandler);

    const signal = createTestSignal({ direction: 'long', confidence: '85' });
    const command = engine.handleSignal(signal);

    expect(command).not.toBeNull();
    expect(dryRunHandler).toHaveBeenCalledOnce();
    expect(dryRunHandler).toHaveBeenCalledWith(command);

    const status = engine.getStatus();
    expect(status.dry_run_trades).toBe(1);
  });

  it('Expired signal skipped', () => {
    const config = createTestConfig({ dry_run: false });
    const engine = new StrategyEngine(config, () => []);

    const signal = createTestSignal({
      expires_at: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
    });

    const command = engine.handleSignal(signal);
    expect(command).toBeNull();

    const status = engine.getStatus();
    expect(status.signals_dropped_stale_or_duplicate).toBe(1);
  });

  it('Duplicate signal rejected', () => {
    const config = createTestConfig({ dry_run: false });
    const engine = new StrategyEngine(config, () => []);

    const signal = createTestSignal({ id: 'dup-signal-1', direction: 'long' });

    // First call: succeeds
    const cmd1 = engine.handleSignal(signal);
    expect(cmd1).not.toBeNull();

    // Second call with same id: rejected
    const cmd2 = engine.handleSignal(signal);
    expect(cmd2).toBeNull();

    const status = engine.getStatus();
    expect(status.signals_dropped_stale_or_duplicate).toBe(1);
  });

  it('Duplicate signal allowed after dedup window', () => {
    const config = createTestConfig({
      dry_run: false,
      risk_limits: {
        max_trades_per_minute: 100,
        market_cooldown_seconds: 0,
        signal_dedup_window_seconds: 10,
      },
    });
    const engine = new StrategyEngine(config, () => []);

    const signal = createTestSignal({ id: 'dup-window-1', direction: 'long' });

    const cmd1 = engine.handleSignal(signal);
    expect(cmd1).not.toBeNull();

    // Advance past dedup window (10 seconds)
    vi.advanceTimersByTime(11_000);

    const cmd2 = engine.handleSignal(signal);
    expect(cmd2).not.toBeNull();
  });

  it('"from_signal" side derivation: long -> buy', () => {
    const config = createTestConfig({
      dry_run: false,
      rules: [createTestRule({ action: { side: 'from_signal', size: 1, order_type: 'market' } })],
    });
    const engine = new StrategyEngine(config, () => []);

    const signal = createTestSignal({
      direction: 'long',
      venue: 'binance',
    });

    const command = engine.handleSignal(signal) as TradeCommand;
    expect(command).not.toBeNull();
    expect(command.side).toBe('buy');
  });

  it('"from_signal" side derivation: short -> sell', () => {
    const config = createTestConfig({
      dry_run: false,
      rules: [createTestRule({ action: { side: 'from_signal', size: 1, order_type: 'market' } })],
    });
    const engine = new StrategyEngine(config, () => []);

    const signal = createTestSignal({
      direction: 'short',
      venue: 'binance',
    });

    const command = engine.handleSignal(signal) as TradeCommand;
    expect(command).not.toBeNull();
    expect(command.side).toBe('sell');
  });

  it('"from_signal" side derivation: long -> yes (prediction)', () => {
    const config = createTestConfig({
      dry_run: false,
      rules: [createTestRule({
        venues: ['kalshi'],
        action: { side: 'from_signal', size: 10, order_type: 'market' },
      })],
      market_mappings: { 'kalshi:BTC-100K/YES': 'kalshi:KXBTCD-26DEC31' },
    });
    const engine = new StrategyEngine(config, () => []);

    const signal = createTestSignal({
      direction: 'long',
      venue: 'kalshi',
      market_id: 'kalshi:BTC-100K/YES',
    });

    const command = engine.handleSignal(signal) as TradeCommand;
    expect(command).not.toBeNull();
    expect(command.side).toBe('yes');
  });

  it('"from_signal" neutral direction skipped', () => {
    const config = createTestConfig({
      dry_run: false,
      rules: [createTestRule({ action: { side: 'from_signal', size: 1, order_type: 'market' } })],
    });
    const engine = new StrategyEngine(config, () => []);

    const signal = createTestSignal({
      direction: 'neutral',
    });

    const command = engine.handleSignal(signal);
    expect(command).toBeNull();
  });

  it('Multiple rules, first match wins', () => {
    const config = createTestConfig({
      dry_run: false,
      rules: [
        createTestRule({ name: 'rule_small', action: { side: 'buy', size: 0.001, order_type: 'market' } }),
        createTestRule({ name: 'rule_large', action: { side: 'buy', size: 10, order_type: 'market' } }),
      ],
    });
    const engine = new StrategyEngine(config, () => []);

    const signal = createTestSignal({ direction: 'long' });
    const command = engine.handleSignal(signal);

    expect(command).not.toBeNull();
    expect((command as TradeCommand).size).toBe(0.001); // First rule's size
  });

  it('Confidence gate filters low confidence', () => {
    const config = createTestConfig({
      dry_run: false,
      rules: [createTestRule({ min_confidence: 80 })],
    });
    const engine = new StrategyEngine(config, () => []);

    const signal = createTestSignal({
      confidence: '50', // Below min_confidence of 80
    });

    const command = engine.handleSignal(signal);
    expect(command).toBeNull();
  });

  it('Severity gate filters low severity', () => {
    const config = createTestConfig({
      dry_run: false,
      rules: [createTestRule({ min_severity: 'High' })],
    });
    const engine = new StrategyEngine(config, () => []);

    const signal = createTestSignal({
      severity: 'Low', // Below min_severity of 'High'
    });

    const command = engine.handleSignal(signal);
    expect(command).toBeNull();
  });

  it('getStatus() returns correct metrics', () => {
    const config = createTestConfig({ dry_run: true });
    const engine = new StrategyEngine(config, () => []);

    // Process a matching signal (dry run)
    const signal1 = createTestSignal({ id: 'status-1', direction: 'long', confidence: '85' });
    engine.handleSignal(signal1);

    // Process a non-matching signal
    const signal2 = createTestSignal({ id: 'status-2', signal_type: 'alert' });
    engine.handleSignal(signal2);

    const status = engine.getStatus();
    expect(status.signals_received).toBe(2);
    expect(status.signals_matched).toBe(1);
    expect(status.dry_run_trades).toBe(1);
    expect(status.trades_generated).toBe(0); // dry_run doesn't increment trades_generated
    expect(status.rules_count).toBe(1);
    expect(status.rules_enabled).toBe(1);
  });

  it('getStatusString() returns correct states', () => {
    // disabled
    const configDisabled = createTestConfig({ enabled: false });
    const engineDisabled = new StrategyEngine(configDisabled, () => []);
    expect(engineDisabled.getStatusString()).toBe('disabled');

    // active:dry_run
    const configDryRun = createTestConfig({ enabled: true, dry_run: true });
    const engineDryRun = new StrategyEngine(configDryRun, () => []);
    expect(engineDryRun.getStatusString()).toBe('active:dry_run');

    // active (live)
    const configLive = createTestConfig({ enabled: true, dry_run: false });
    const engineLive = new StrategyEngine(configLive, () => []);
    expect(engineLive.getStatusString()).toBe('active');
  });

  // --- limit_price_offset_bps tests ---

  const KALSHI_MARKET_MAPPINGS = { 'kalshi:KXBTC15M-TEST': 'kalshi:KXBTC15M-TEST' };

  it('limit_price_offset_bps: positive offset computes correct limit price', () => {
    const config = createTestConfig({
      dry_run: false,
      market_mappings: KALSHI_MARKET_MAPPINGS,
      rules: [
        createTestRule({
          name: 'limit_test',
          signal_types: ['alert'],
          venues: ['kalshi'],
          action: {
            side: 'yes',
            size: 5,
            order_type: 'limit',
            limit_price_offset_bps: 200, // +2%
          },
        }),
      ],
    });
    const engine = new StrategyEngine(config, () => []);

    const signal = createTestSignal({
      signal_type: 'alert',
      signal_name: 'sharp_line_movement',
      market_id: 'kalshi:KXBTC15M-TEST',
      venue: 'kalshi',
      direction: 'above',
      payload: { current_price: 0.50 },
    });

    const cmd = engine.handleSignal(signal) as TradeCommand;
    expect(cmd).not.toBeNull();
    expect(cmd.order_type).toBe('limit');
    expect(cmd.limit_price).toBe(0.51); // 0.50 * 1.02 = 0.51
  });

  it('limit_price_offset_bps: negative offset computes discounted limit price', () => {
    const config = createTestConfig({
      dry_run: false,
      market_mappings: KALSHI_MARKET_MAPPINGS,
      rules: [
        createTestRule({
          name: 'limit_discount',
          signal_types: ['alert'],
          venues: ['kalshi'],
          action: {
            side: 'yes',
            size: 5,
            order_type: 'limit',
            limit_price_offset_bps: -200, // -2%
          },
        }),
      ],
    });
    const engine = new StrategyEngine(config, () => []);

    const signal = createTestSignal({
      signal_type: 'alert',
      signal_name: 'sharp_line_movement',
      market_id: 'kalshi:KXBTC15M-TEST',
      venue: 'kalshi',
      direction: 'above',
      payload: { current_price: 0.80 },
    });

    const cmd = engine.handleSignal(signal) as TradeCommand;
    expect(cmd).not.toBeNull();
    expect(cmd.order_type).toBe('limit');
    expect(cmd.limit_price).toBe(0.78); // 0.80 * 0.98 = 0.784 -> rounded 0.78
  });

  it('limit_price_offset_bps: missing payload price leaves limit_price undefined', () => {
    const config = createTestConfig({
      dry_run: false,
      market_mappings: KALSHI_MARKET_MAPPINGS,
      rules: [
        createTestRule({
          name: 'limit_no_price',
          signal_types: ['alert'],
          venues: ['kalshi'],
          action: {
            side: 'yes',
            size: 5,
            order_type: 'limit',
            limit_price_offset_bps: 100,
          },
        }),
      ],
    });
    const engine = new StrategyEngine(config, () => []);

    const signal = createTestSignal({
      signal_type: 'alert',
      signal_name: 'sharp_line_movement',
      market_id: 'kalshi:KXBTC15M-TEST',
      venue: 'kalshi',
      direction: 'above',
      payload: { description: 'no price field' },
    });

    const cmd = engine.handleSignal(signal) as TradeCommand;
    expect(cmd).not.toBeNull();
    expect(cmd.order_type).toBe('limit');
    expect(cmd.limit_price).toBeUndefined();
  });

  it('limit_price_offset_bps: extracts from trigger_price field', () => {
    const config = createTestConfig({
      dry_run: false,
      market_mappings: KALSHI_MARKET_MAPPINGS,
      rules: [
        createTestRule({
          name: 'limit_trigger',
          signal_types: ['alert'],
          venues: ['kalshi'],
          action: {
            side: 'yes',
            size: 5,
            order_type: 'limit',
            limit_price_offset_bps: 500, // +5%
          },
        }),
      ],
    });
    const engine = new StrategyEngine(config, () => []);

    const signal = createTestSignal({
      signal_type: 'alert',
      signal_name: 'sharp_line_movement',
      market_id: 'kalshi:KXBTC15M-TEST',
      venue: 'kalshi',
      direction: 'above',
      payload: { trigger_price: 0.60 },
    });

    const cmd = engine.handleSignal(signal) as TradeCommand;
    expect(cmd).not.toBeNull();
    expect(cmd.limit_price).toBe(0.63); // 0.60 * 1.05 = 0.63
  });
});
