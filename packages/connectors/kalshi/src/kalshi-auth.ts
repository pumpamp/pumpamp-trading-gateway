import { createSign, constants } from 'node:crypto';

/**
 * Signs a Kalshi API request using RSA-PSS SHA256.
 *
 * @param privateKey - PEM-encoded RSA private key
 * @param timestamp - ISO 8601 timestamp (milliseconds)
 * @param method - HTTP method (GET, POST, DELETE)
 * @param path - API path (e.g., '/trade-api/v2/portfolio/orders')
 * @returns Base64-encoded signature
 */
export function signRequest(
  privateKey: string,
  timestamp: string,
  method: string,
  path: string
): string {
  const message = `${timestamp}${method}${path}`;

  const sign = createSign('RSA-SHA256');
  sign.update(message);
  sign.end();

  const signature = sign.sign(
    {
      key: privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    },
    'base64'
  );

  return signature;
}

/**
 * Builds authentication headers for Kalshi API requests.
 *
 * @param apiKey - Kalshi API key
 * @param privateKey - PEM-encoded RSA private key
 * @param method - HTTP method
 * @param path - API path
 * @returns Headers object with authentication
 */
export function buildAuthHeaders(
  apiKey: string,
  privateKey: string,
  method: string,
  path: string
): Record<string, string> {
  const timestamp = Date.now().toString();
  const signature = signRequest(privateKey, timestamp, method, path);

  return {
    'KALSHI-ACCESS-KEY': apiKey,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
  };
}
