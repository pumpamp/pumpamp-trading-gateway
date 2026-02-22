import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config.js';
import { ZodError } from 'zod';

/**
 * Helper: returns a minimal valid env for loadConfig.
 * Only PUMPAMP_API_KEY is strictly required; everything else has defaults.
 */
function minimalEnv(overrides?: Record<string, string>): Record<string, string> {
  return {
    PUMPAMP_API_KEY: 'test-key-abc123',
    ...overrides,
  };
}

// ============================================================
// ============================================================

describe('Config validation (Zod schema)', () => {
  it('Valid minimal config passes', () => {
    const config = loadConfig(minimalEnv());

    expect(config.pumpampApiKey).toBe('test-key-abc123');
    expect(config.pumpampHost).toBe('api.pumpamp.com');
    expect(config.cancelOnShutdown).toBe(false);
    expect(config.logLevel).toBe('info');
    expect(config.kalshi).toBeUndefined();
    expect(config.polymarket).toBeUndefined();
    expect(config.hyperliquid).toBeUndefined();
    expect(config.binance).toBeUndefined();
  });

  it('Missing PUMPAMP_API_KEY fails with ZodError', () => {
    expect(() => loadConfig({})).toThrow(ZodError);
  });

  it('Missing PUMPAMP_HOST uses default', () => {
    const config = loadConfig(minimalEnv());
    expect(config.pumpampHost).toBe('api.pumpamp.com');
  });

  it('Full Kalshi config passes with base64-encoded PEM', () => {
    // base64("-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----")
    const b64Pem = Buffer.from('-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----').toString('base64');
    const config = loadConfig(minimalEnv({
      KALSHI_API_KEY: 'kalshi-key-123',
      KALSHI_PRIVATE_KEY: b64Pem,
    }));

    expect(config.kalshi).toBeDefined();
    expect(config.kalshi!.apiKey).toBe('kalshi-key-123');
    expect(config.kalshi!.privateKeyPem).toBe('-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----');
    expect(config.kalshi!.apiUrl).toBe('https://api.elections.kalshi.com');
  });

  it('Partial Kalshi config rejects block (no private key)', () => {
    const config = loadConfig(minimalEnv({
      KALSHI_API_KEY: 'kalshi-key-123',
      // Missing both KALSHI_PRIVATE_KEY and KALSHI_PRIVATE_KEY_PATH
    }));

    expect(config.kalshi).toBeUndefined();
  });

  it('Full Polymarket config passes', () => {
    const config = loadConfig(minimalEnv({
      POLYMARKET_PRIVATE_KEY: '0xdeadbeef',
      POLYMARKET_API_KEY: 'poly-key',
      POLYMARKET_API_SECRET: 'poly-secret',
      POLYMARKET_API_PASSPHRASE: 'poly-pass',
    }));

    expect(config.polymarket).toBeDefined();
    expect(config.polymarket!.privateKey).toBe('0xdeadbeef');
    expect(config.polymarket!.apiKey).toBe('poly-key');
    expect(config.polymarket!.apiSecret).toBe('poly-secret');
    expect(config.polymarket!.passphrase).toBe('poly-pass');
    expect(config.polymarket!.apiUrl).toBe('https://clob.polymarket.com');
  });

  it('Polymarket with only private key enables connector (API creds auto-derived)', () => {
    const config = loadConfig(minimalEnv({
      POLYMARKET_PRIVATE_KEY: '0xdeadbeef',
    }));

    expect(config.polymarket).toBeDefined();
    expect(config.polymarket!.privateKey).toBe('0xdeadbeef');
    expect(config.polymarket!.apiKey).toBeUndefined();
    expect(config.polymarket!.apiSecret).toBeUndefined();
    expect(config.polymarket!.passphrase).toBeUndefined();
  });

  it('Hyperliquid config passes', () => {
    const config = loadConfig(minimalEnv({
      HYPERLIQUID_PRIVATE_KEY: '0xhyperliquid-key',
    }));

    expect(config.hyperliquid).toBeDefined();
    expect(config.hyperliquid!.privateKey).toBe('0xhyperliquid-key');
  });

  it('Binance config passes', () => {
    const config = loadConfig(minimalEnv({
      BINANCE_API_KEY: 'binance-key-abc',
      BINANCE_API_SECRET: 'binance-secret-xyz',
      BINANCE_FUTURES: 'true',
    }));

    expect(config.binance).toBeDefined();
    expect(config.binance!.apiKey).toBe('binance-key-abc');
    expect(config.binance!.apiSecret).toBe('binance-secret-xyz');
    expect(config.binance!.futures).toBe(true);
    expect(config.binance!.apiUrl).toBe('https://fapi.binance.com');
  });

  it('Partial Binance config rejects (not enabled)', () => {
    const config = loadConfig(minimalEnv({
      BINANCE_API_KEY: 'binance-key-abc',
      // Missing BINANCE_API_SECRET
    }));

    expect(config.binance).toBeUndefined();
  });

  it('CANCEL_ON_SHUTDOWN parses boolean', () => {
    const configTrue = loadConfig(minimalEnv({ CANCEL_ON_SHUTDOWN: 'true' }));
    expect(configTrue.cancelOnShutdown).toBe(true);

    const configFalse = loadConfig(minimalEnv({ CANCEL_ON_SHUTDOWN: 'false' }));
    expect(configFalse.cancelOnShutdown).toBe(false);
  });

  it('LOG_LEVEL accepts valid values', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      const config = loadConfig(minimalEnv({ LOG_LEVEL: level }));
      expect(config.logLevel).toBe(level);
    }
  });
});
