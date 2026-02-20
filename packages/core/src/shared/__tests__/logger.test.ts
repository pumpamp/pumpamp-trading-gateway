import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger, sanitizeUrl } from '../logger.js';

/**
 * Captures pino JSON output into a buffer.
 * Returns a function that retrieves the last logged JSON object.
 */
function createCapture(): { stream: Writable; getOutput: () => Record<string, unknown> } {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      callback();
    },
  });
  return {
    stream,
    getOutput(): Record<string, unknown> {
      // pino writes newline-delimited JSON; take the last non-empty line
      const lines = buffer.trim().split('\n').filter(Boolean);
      const last = lines[lines.length - 1];
      return JSON.parse(last) as Record<string, unknown>;
    },
  };
}

describe('Logger redaction', () => {
  it('Log object with PUMPAMP_API_KEY field is redacted', () => {
    const { stream, getOutput } = createCapture();
    const logger = createLogger('test-redact', { destination: stream, level: 'info' });

    logger.info({ PUMPAMP_API_KEY: 'super-secret-key-123' }, 'testing key redaction');

    const out = getOutput();
    expect(out['PUMPAMP_API_KEY']).toBe('[REDACTED]');
  });

  it('Log object with nested api_secret field is redacted', () => {
    const { stream, getOutput } = createCapture();
    const logger = createLogger('test-redact', { destination: stream, level: 'info' });

    logger.info({ credentials: { api_secret: 'my-secret-value' } }, 'nested redaction');

    const out = getOutput();
    const credentials = out['credentials'] as Record<string, unknown>;
    expect(credentials['api_secret']).toBe('[REDACTED]');
  });

  it('Log with URL containing query string ?api_key= has query string stripped', () => {
    // sanitizeUrl is the exported helper for URL sanitization.
    // pino redact paths handle object keys; URL sanitization is done via sanitizeUrl.
    const url = 'https://api.venue.com/v1/orders?api_key=secret123&timestamp=1234567890';
    const sanitized = sanitizeUrl(url);

    expect(sanitized).toBe('https://api.venue.com/v1/orders');
    expect(sanitized).not.toContain('api_key');
    expect(sanitized).not.toContain('secret123');
    expect(sanitized).not.toContain('?');
  });

  it('Log object with private_key field is redacted', () => {
    const { stream, getOutput } = createCapture();
    const logger = createLogger('test-redact', { destination: stream, level: 'info' });

    logger.info({ private_key: '0xdeadbeef1234567890' }, 'private key test');

    const out = getOutput();
    expect(out['private_key']).toBe('[REDACTED]');
  });

  it('Log object with passphrase field is redacted', () => {
    const { stream, getOutput } = createCapture();
    const logger = createLogger('test-redact', { destination: stream, level: 'info' });

    logger.info({ passphrase: 'hunter2' }, 'passphrase test');

    const out = getOutput();
    expect(out['passphrase']).toBe('[REDACTED]');
  });

  it('Log object with non-sensitive field is NOT redacted', () => {
    const { stream, getOutput } = createCapture();
    const logger = createLogger('test-redact', { destination: stream, level: 'info' });

    logger.info({ venue: 'kalshi', market_id: 'BTC-100K', size: 10 }, 'safe fields');

    const out = getOutput();
    expect(out['venue']).toBe('kalshi');
    expect(out['market_id']).toBe('BTC-100K');
    expect(out['size']).toBe(10);
  });

  it('Log object containing auth headers is sanitized', () => {
    const { stream, getOutput } = createCapture();
    const logger = createLogger('test-redact', { destination: stream, level: 'info' });

    logger.info({
      headers: {
        authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret',
        'x-mbx-apikey': 'binance-api-key-value',
        'kalshi-access-signature': 'sig-abc123',
        'content-type': 'application/json',
      },
    }, 'auth headers test');

    const out = getOutput();
    const headers = out['headers'] as Record<string, unknown>;
    expect(headers['authorization']).toBe('[REDACTED]');
    expect(headers['x-mbx-apikey']).toBe('[REDACTED]');
    expect(headers['kalshi-access-signature']).toBe('[REDACTED]');
    // Non-sensitive header should remain
    expect(headers['content-type']).toBe('application/json');
  });
});
