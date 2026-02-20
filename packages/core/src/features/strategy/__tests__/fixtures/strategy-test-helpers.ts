import type { Signal, SignalType, SignalDirection, AlertSeverity } from '../../../signals/signal-consumer.js';
import type { StrategyRule, StrategyConfig, RiskLimits } from '../../strategy-config.js';
import type { Position } from '../../../../shared/protocol.js';

export function createTestSignal(overrides?: Partial<Signal>): Signal {
  return {
    id: `sig-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    signal_type: 'strategy' as SignalType,
    signal_name: 'MomentumBreakout',
    market_id: 'binance:BTC/USDT',
    venue: 'binance',
    base_currency: 'BTC',
    quote_currency: 'USDT',
    created_at: new Date().toISOString(),
    severity: 'High' as AlertSeverity,
    direction: 'long' as SignalDirection,
    confidence: '85',
    description: 'Test signal',
    payload: {},
    ...overrides,
  };
}

export function createTestRule(overrides?: Partial<StrategyRule>): StrategyRule {
  return {
    name: 'test_rule',
    enabled: true,
    signal_types: ['strategy'],
    venues: ['binance'],
    min_confidence: 70,
    action: {
      side: 'from_signal',
      size: 0.01,
      order_type: 'market',
    },
    ...overrides,
  };
}

export function createTestConfig(overrides?: Partial<StrategyConfig>): StrategyConfig {
  return {
    enabled: true,
    dry_run: true,
    rules: [createTestRule()],
    market_mappings: {},
    risk_limits: {
      max_trades_per_minute: 5,
      market_cooldown_seconds: 30,
      signal_dedup_window_seconds: 300,
    },
    ...overrides,
  };
}

export function createTestPosition(overrides?: Partial<Position>): Position {
  return {
    venue: 'binance',
    market_id: 'binance:BTCUSDT',
    side: 'buy',
    size: 50,
    entry_price: 100,
    ...overrides,
  };
}

export const DEFAULT_TEST_CONFIG: StrategyConfig = createTestConfig();

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  max_trades_per_minute: 5,
  market_cooldown_seconds: 30,
  signal_dedup_window_seconds: 300,
};
