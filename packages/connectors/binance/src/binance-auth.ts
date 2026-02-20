import { createHmac } from 'node:crypto';

/**
 * Sign a query string using HMAC-SHA256
 */
export function signQuery(secret: string, queryString: string): string {
  return createHmac('sha256', secret).update(queryString).digest('hex');
}

/**
 * Build a signed URL for Binance API requests
 * Adds timestamp, builds query string, and appends signature
 */
export function buildSignedUrl(
  baseUrl: string,
  params: Record<string, string | number | boolean | undefined>,
  secret: string
): string {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };

  // Filter out undefined values and build query string
  const queryParts: string[] = [];
  for (const [key, value] of Object.entries(allParams)) {
    if (value !== undefined) {
      queryParts.push(`${key}=${encodeURIComponent(value)}`);
    }
  }

  const queryString = queryParts.join('&');
  const signature = signQuery(secret, queryString);

  return `${baseUrl}?${queryString}&signature=${signature}`;
}

/**
 * Build authentication headers for Binance API requests
 */
export function buildAuthHeaders(apiKey: string): Record<string, string> {
  return {
    'X-MBX-APIKEY': apiKey,
    'Content-Type': 'application/json',
  };
}
