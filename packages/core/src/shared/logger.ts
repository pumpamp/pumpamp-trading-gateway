import pino from 'pino';

const redactPaths = [
  'PUMPAMP_API_KEY',
  'api_key',
  'apiKey',
  'api_secret',
  'apiSecret',
  'private_key',
  'privateKey',
  'passphrase',
  'apiPassphrase',
  'signature',
  'authorization',
  'x-mbx-apikey',
  'kalshi-access-signature',
  'kalshi-access-key',
  '*.PUMPAMP_API_KEY',
  '*.api_key',
  '*.apiKey',
  '*.api_secret',
  '*.apiSecret',
  '*.private_key',
  '*.privateKey',
  '*.passphrase',
  '*.apiPassphrase',
  '*.signature',
  '*.authorization',
  '*.x-mbx-apikey',
  '*.kalshi-access-signature',
  '*.kalshi-access-key',
];

export function createLogger(name: string, options?: { destination?: pino.DestinationStream; level?: string }): pino.Logger {
  return pino({
    name,
    level: options?.level ?? process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: redactPaths,
      censor: '[REDACTED]',
    },
  }, options?.destination);
}

/**
 * Strip query string from a URL for safe logging.
 * Removes api_key, pairing_code, pairing_id, and any other query params.
 */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // If URL parsing fails, strip everything after ?
    const qIndex = url.indexOf('?');
    return qIndex >= 0 ? url.substring(0, qIndex) : url;
  }
}
