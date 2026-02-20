import { buildSignedUrl, buildAuthHeaders } from './binance-auth.js';
import type {
  BinanceOrderRequest,
  BinanceOrderResponse,
  BinancePosition,
  BinanceBalance,
  BinanceSpotAccount,
  BinanceErrorResponse,
} from './types.js';

export interface BinanceApiConfig {
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
  futures?: boolean;
  recvWindow?: number;
}

export class BinanceApi {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly futures: boolean;
  private readonly recvWindow: number;

  constructor(config: BinanceApiConfig) {
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.futures = config.futures ?? false;
    this.recvWindow = config.recvWindow ?? 5000;
  }

  /**
   * Place an order (futures or spot)
   */
  async placeOrder(params: Partial<BinanceOrderRequest>): Promise<BinanceOrderResponse> {
    const endpoint = this.futures ? '/fapi/v1/order' : '/api/v3/order';
    return this.signedRequest<BinanceOrderResponse>('POST', endpoint, params);
  }

  /**
   * Cancel a specific order
   */
  async cancelOrder(symbol: string, orderId: number): Promise<BinanceOrderResponse> {
    const endpoint = this.futures ? '/fapi/v1/order' : '/api/v3/order';
    return this.signedRequest<BinanceOrderResponse>('DELETE', endpoint, { symbol, orderId });
  }

  /**
   * Cancel all open orders for a symbol
   */
  async cancelAllOrders(symbol: string): Promise<{ code: number; msg: string }> {
    const endpoint = this.futures ? '/fapi/v1/allOpenOrders' : '/api/v3/openOrders';
    return this.signedRequest('DELETE', endpoint, { symbol });
  }

  /**
   * Get all positions (futures only)
   */
  async getPositions(): Promise<BinancePosition[]> {
    if (!this.futures) {
      throw new Error('getPositions() is only available for futures');
    }
    return this.signedRequest<BinancePosition[]>('GET', '/fapi/v2/positionRisk', {});
  }

  /**
   * Get balance (futures or spot)
   */
  async getBalance(): Promise<BinanceBalance[] | BinanceSpotAccount> {
    if (this.futures) {
      return this.signedRequest<BinanceBalance[]>('GET', '/fapi/v2/balance', {});
    } else {
      return this.signedRequest<BinanceSpotAccount>('GET', '/api/v3/account', {});
    }
  }

  /**
   * Execute a signed request
   */
  private async signedRequest<T>(
    method: string,
    path: string,
    params: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    const url = buildSignedUrl(`${this.apiUrl}${path}`, params, this.apiSecret);
    const headers = buildAuthHeaders(this.apiKey);

    const response = await fetch(url, {
      method,
      headers,
    });

    const data = await response.json();

    if (!response.ok) {
      const error = data as BinanceErrorResponse;
      throw new Error(`Binance API error: ${error.code} - ${error.msg}`);
    }

    return data as T;
  }
}
