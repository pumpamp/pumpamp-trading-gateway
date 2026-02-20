import { buildAuthHeaders } from './kalshi-auth.js';
import type {
  KalshiOrderRequest,
  KalshiOrderResponse,
  KalshiPosition,
  KalshiBalance,
  KalshiError,
} from './types.js';

export interface KalshiApiConfig {
  apiUrl: string;
  apiKey: string;
  privateKeyPem: string;
}

export class KalshiApi {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly privateKeyPem: string;

  constructor(config: KalshiApiConfig) {
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
    this.privateKeyPem = config.privateKeyPem;
  }

  /**
   * Place a new order on Kalshi.
   */
  async placeOrder(params: KalshiOrderRequest): Promise<KalshiOrderResponse> {
    return this.request<KalshiOrderResponse>(
      'POST',
      '/trade-api/v2/portfolio/orders',
      params
    );
  }

  /**
   * Cancel a specific order by ID.
   */
  async cancelOrder(orderId: string): Promise<void> {
    await this.request('DELETE', `/trade-api/v2/portfolio/orders/${orderId}`);
  }

  /**
   * Cancel all open orders.
   */
  async cancelAllOrders(): Promise<void> {
    await this.request('DELETE', '/trade-api/v2/portfolio/orders');
  }

  /**
   * Get all current positions.
   */
  async getPositions(): Promise<KalshiPosition[]> {
    const response = await this.request<{ positions: KalshiPosition[] }>(
      'GET',
      '/trade-api/v2/portfolio/positions'
    );
    return response.positions || [];
  }

  /**
   * Get account balance.
   */
  async getBalance(): Promise<KalshiBalance> {
    return this.request<KalshiBalance>('GET', '/trade-api/v2/portfolio/balance');
  }

  /**
   * Internal request helper with authentication.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const authHeaders = buildAuthHeaders(
      this.apiKey,
      this.privateKeyPem,
      method,
      path
    );

    const headers: Record<string, string> = {
      ...authHeaders,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    const url = `${this.apiUrl}${path}`;
    const options: RequestInit = {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    };

    const response = await fetch(url, options);

    if (!response.ok) {
      const text = await response.text();
      let message: string;
      try {
        const errorBody = JSON.parse(text) as KalshiError;
        message = `${errorBody.error.code} - ${errorBody.error.message}`;
      } catch {
        message = `HTTP ${response.status}: ${text.slice(0, 200)}`;
      }
      throw new Error(`Kalshi API error: ${message}`);
    }

    // DELETE requests may return 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }
}
