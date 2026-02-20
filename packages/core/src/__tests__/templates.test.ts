import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strategyConfigSchema } from '../features/strategy/strategy-config.js';

const TEMPLATES_DIR = resolve(__dirname, '../../../../templates');

function loadTemplate(name: string): unknown {
  const raw = readFileSync(resolve(TEMPLATES_DIR, name), 'utf-8');
  return JSON.parse(raw);
}

const TEMPLATE_FILES = [
  'prediction-arb.json',
  'sharp-line-movement.json',
  'prediction-whale-follow.json',
  'prediction-volume-spike.json',
  'crypto-15m-momentum.json',
  'crypto-15m-arb.json',
];

describe('templates', () => {
  it('All templates parse with Zod schema', () => {
    for (const file of TEMPLATE_FILES) {
      const json = loadTemplate(file);
      const result = strategyConfigSchema.safeParse(json);
      expect(result.success, `Template ${file} failed validation: ${result.success ? '' : result.error.message}`).toBe(true);
    }
  });

  it('prediction-arb has 2 rules with correct signal_names', () => {
    const json = loadTemplate('prediction-arb.json');
    const config = strategyConfigSchema.parse(json);

    expect(config.rules).toHaveLength(2);

    const signalNames = config.rules.map((r) => r.signal_names).flat();
    expect(signalNames).toContain('cross_venue_arbitrage');
    expect(signalNames).toContain('prediction_market_inefficiency');
  });

  it('sharp-line-movement targets correct venues (kalshi, polymarket)', () => {
    const json = loadTemplate('sharp-line-movement.json');
    const config = strategyConfigSchema.parse(json);

    const allVenues = new Set<string>();
    for (const rule of config.rules) {
      if (rule.venues) {
        for (const v of rule.venues) allVenues.add(v);
      }
    }

    expect(allVenues).toContain('kalshi');
    expect(allVenues).toContain('polymarket');
  });

  it('prediction-whale-follow has conservative defaults (max_position_size_per_market <= 25, market_cooldown_seconds >= 300)', () => {
    const json = loadTemplate('prediction-whale-follow.json');
    const config = strategyConfigSchema.parse(json);

    expect(config.risk_limits.max_position_size_per_market).toBeDefined();
    expect(config.risk_limits.max_position_size_per_market!).toBeLessThanOrEqual(25);
    expect(config.risk_limits.market_cooldown_seconds).toBeGreaterThanOrEqual(300);
    for (const rule of config.rules) {
      expect(rule.action.size).toBeLessThanOrEqual(5);
    }
  });

  it('volume-spike has contrarian rule disabled', () => {
    const json = loadTemplate('prediction-volume-spike.json');
    const config = strategyConfigSchema.parse(json);

    const contrarian = config.rules.find((r) => r.name === 'volume_spike_contrarian');
    expect(contrarian).toBeDefined();
    expect(contrarian!.enabled).toBe(false);
  });

  it('All templates have dry_run: true', () => {
    for (const file of TEMPLATE_FILES) {
      const json = loadTemplate(file);
      const config = strategyConfigSchema.parse(json);
      expect(config.dry_run, `Template ${file} should have dry_run: true`).toBe(true);
    }
  });

  it('All templates have _description and _usage fields', () => {
    for (const file of TEMPLATE_FILES) {
      const json = loadTemplate(file) as Record<string, unknown>;
      expect(json._description, `Template ${file} missing _description`).toBeDefined();
      expect(typeof json._description).toBe('string');
      expect((json._description as string).trim().length).toBeGreaterThan(0);
      expect(json._usage, `Template ${file} missing _usage`).toBeDefined();
      expect(typeof json._usage).toBe('string');
      expect((json._usage as string).trim().length).toBeGreaterThan(0);
    }
  });

  it('Invalid template fails validation', () => {
    const invalid = {
      enabled: true,
      dry_run: true,
      // rules intentionally omitted
    };

    const result = strategyConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('crypto-15m-momentum targets kalshi + polymarket with 90s cooldown', () => {
    const json = loadTemplate('crypto-15m-momentum.json');
    const config = strategyConfigSchema.parse(json);

    const allVenues = new Set<string>();
    for (const rule of config.rules) {
      if (rule.venues) {
        for (const v of rule.venues) allVenues.add(v);
      }
    }

    expect(allVenues).toContain('kalshi');
    expect(allVenues).toContain('polymarket');
    expect(config.risk_limits.market_cooldown_seconds).toBe(90);
    expect(config.rules.length).toBeGreaterThanOrEqual(2);
  });

  it('crypto-15m-arb uses cross_venue_arbitrage signal type', () => {
    const json = loadTemplate('crypto-15m-arb.json');
    const config = strategyConfigSchema.parse(json);

    expect(config.rules.length).toBeGreaterThanOrEqual(1);
    const arbRule = config.rules.find((r) => r.signal_types.includes('cross_venue_arbitrage'));
    expect(arbRule).toBeDefined();
  });
});
