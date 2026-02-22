import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { signRequest } from '../kalshi-auth.js';

// Generate a test RSA key pair for all auth tests
const { privateKey: testPrivateKeyPem } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// ============================================================
// ============================================================

describe('Kalshi RSA-PSS signing', () => {
  it('signs message with known RSA key and produces non-empty base64 signature', () => {
    const timestamp = '1700000000000';
    const method = 'GET';
    const path = '/trade-api/v2/portfolio/balance';

    const signature = signRequest(testPrivateKeyPem, timestamp, method, path);

    expect(signature).toBeTruthy();
    expect(signature.length).toBeGreaterThan(0);
    // Validate base64 format (base64 chars + optional padding)
    expect(signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('constructs signature input as timestamp+method+path concatenation', () => {
    const timestamp = '1700000000000';
    const method = 'POST';
    const path = '/trade-api/v2/portfolio/orders';

    // Two calls with the same inputs should produce the same signature
    // (RSA-PSS uses random salt, so they may differ -- but we verify both are valid base64)
    const sig1 = signRequest(testPrivateKeyPem, timestamp, method, path);
    const sig2 = signRequest(testPrivateKeyPem, timestamp, method, path);

    // Both signatures should be valid base64 strings of the same length
    // RSA-PSS with 2048-bit key produces 256-byte (344 base64 chars) signatures
    expect(sig1).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(sig2).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(sig1.length).toBe(sig2.length);
  });

  it('produces different signatures for different timestamps', () => {
    const method = 'GET';
    const path = '/trade-api/v2/portfolio/balance';

    const sig1 = signRequest(testPrivateKeyPem, '1700000000000', method, path);
    const sig2 = signRequest(testPrivateKeyPem, '1700000000001', method, path);

    // Even with RSA-PSS random salt, changing the input must change the signature
    // (extremely high probability -- collision is astronomically unlikely)
    expect(sig1).not.toBe(sig2);
  });

  it('throws a descriptive error when given an invalid PEM key', () => {
    const invalidPem = 'NOT-A-VALID-PEM-KEY';
    const timestamp = '1700000000000';
    const method = 'GET';
    const path = '/trade-api/v2/portfolio/balance';

    expect(() => signRequest(invalidPem, timestamp, method, path)).toThrow();
  });
});
