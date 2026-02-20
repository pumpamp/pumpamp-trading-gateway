import { describe, it, expect } from 'vitest';
import { strategyConfigSchema } from '../strategy-config.js';

describe('strategy-config', () => {
  it('Valid config parses successfully', () => {
    const input = {
      enabled: true,
      dry_run: false,
      rules: [
        {
          name: 'test_rule',
          signal_types: ['strategy'],
          venues: ['binance'],
          min_confidence: 80,
          action: { side: 'buy', size: 0.01, order_type: 'market' },
        },
      ],
      market_mappings: { 'kalshi:BTC-100K/YES': 'kalshi:KXBTCD-26DEC31' },
      risk_limits: {
        max_position_size_per_market: 100,
        max_total_exposure_usd: 5000,
        max_trades_per_minute: 3,
        market_cooldown_seconds: 60,
        signal_dedup_window_seconds: 300,
      },
    };

    const result = strategyConfigSchema.parse(input);
    expect(result.enabled).toBe(true);
    expect(result.dry_run).toBe(false);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].name).toBe('test_rule');
    expect(result.risk_limits.max_trades_per_minute).toBe(3);
    expect(result.market_mappings['kalshi:BTC-100K/YES']).toBe('kalshi:KXBTCD-26DEC31');
  });

  it('Empty rules array is valid', () => {
    const input = { rules: [] };
    const result = strategyConfigSchema.parse(input);
    expect(result.rules).toHaveLength(0);
    expect(result.enabled).toBe(true);
    expect(result.dry_run).toBe(true);
  });

  it('Missing required fields rejected', () => {
    expect(() => strategyConfigSchema.parse({})).toThrow();
    expect(() => strategyConfigSchema.parse({ enabled: true })).toThrow();
  });

  it('dry_run defaults to true', () => {
    const input = { rules: [] };
    const result = strategyConfigSchema.parse(input);
    expect(result.dry_run).toBe(true);
  });

  it('enabled defaults to true', () => {
    const input = { rules: [] };
    const result = strategyConfigSchema.parse(input);
    expect(result.enabled).toBe(true);
  });

  it('Invalid rule signal_type rejected', () => {
    const input = {
      rules: [
        {
          name: 'bad_rule',
          signal_types: ['invalid_type'],
          action: { side: 'buy', size: 1 },
        },
      ],
    };
    expect(() => strategyConfigSchema.parse(input)).toThrow();
  });

  it('Partial risk_limits gets defaults', () => {
    const input = {
      rules: [],
      risk_limits: { max_total_exposure_usd: 5000 },
    };
    const result = strategyConfigSchema.parse(input);
    expect(result.risk_limits.max_total_exposure_usd).toBe(5000);
    expect(result.risk_limits.max_trades_per_minute).toBe(5);
    expect(result.risk_limits.market_cooldown_seconds).toBe(30);
    expect(result.risk_limits.signal_dedup_window_seconds).toBe(300);
  });

  it('signal_dedup_window_seconds defaults to 300', () => {
    const input = { rules: [] };
    const result = strategyConfigSchema.parse(input);
    expect(result.risk_limits.signal_dedup_window_seconds).toBe(300);
  });
});
