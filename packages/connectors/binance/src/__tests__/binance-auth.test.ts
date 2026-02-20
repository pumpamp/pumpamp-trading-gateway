import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { signQuery, buildSignedUrl, buildAuthHeaders } from '../binance-auth.js';

// ============================================================
// UT-6d.1: HMAC-SHA256 signing (3 tests)
// ============================================================

describe('UT-6d.1: Binance HMAC-SHA256 signing', () => {
  it('signs a query string with known key and produces expected HMAC', () => {
    const secret = 'test-secret-key-12345';
    const queryString = 'symbol=BTCUSDT&side=BUY&type=MARKET&quantity=0.001&timestamp=1700000000000';

    const signature = signQuery(secret, queryString);

    // Manually compute the expected HMAC
    const expected = createHmac('sha256', secret)
      .update(queryString)
      .digest('hex');

    expect(signature).toBe(expected);
    // HMAC-SHA256 produces 64 hex characters
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it('appends signature to query string as signature param via buildSignedUrl', () => {
    const secret = 'test-secret-key-12345';
    const baseUrl = 'https://fapi.binance.com/fapi/v1/order';
    const params = {
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 0.001,
    };

    const signedUrl = buildSignedUrl(baseUrl, params, secret);

    // URL should start with base URL
    expect(signedUrl.startsWith(baseUrl + '?')).toBe(true);

    // URL should contain all params
    expect(signedUrl).toContain('symbol=BTCUSDT');
    expect(signedUrl).toContain('side=BUY');
    expect(signedUrl).toContain('type=MARKET');
    expect(signedUrl).toContain('quantity=0.001');

    // URL should contain timestamp param (auto-added)
    expect(signedUrl).toContain('timestamp=');

    // URL should end with &signature=<hex>
    expect(signedUrl).toMatch(/&signature=[a-f0-9]{64}$/);
  });

  it('sets API key in X-MBX-APIKEY header', () => {
    const apiKey = 'my-binance-api-key-abc123';

    const headers = buildAuthHeaders(apiKey);

    expect(headers['X-MBX-APIKEY']).toBe(apiKey);
    expect(headers['Content-Type']).toBe('application/json');
  });
});
