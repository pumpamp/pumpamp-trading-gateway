import type {
  VenueConnector,
  OrderRequest,
  OrderResult,
  Position,
  Balance,
} from '@pumpamp/core';
import { createLogger } from '@pumpamp/core';
import { KalshiApi } from './kalshi-api.js';

const logger = createLogger('KalshiConnector');
import type {
  KalshiOrderRequest,
  KalshiOrderResponse,
  KalshiPosition,
} from './types.js';

export interface KalshiConnectorConfig {
  apiUrl: string;
  apiKey: string;
  privateKeyPem: string;
}

/**
 * Maps Kalshi error messages to standardized error codes.
 */
export function mapKalshiError(errorMessage: string): string {
  const lowerMessage = errorMessage.toLowerCase();

  if (lowerMessage.includes('insufficient balance') || lowerMessage.includes('insufficient funds')) {
    return 'INSUFFICIENT_BALANCE';
  }
  if (lowerMessage.includes('invalid order') || lowerMessage.includes('invalid ticker')) {
    return 'INVALID_ORDER';
  }
  if (lowerMessage.includes('rate limit') || lowerMessage.includes('too many requests')) {
    return 'RATE_LIMITED';
  }
  if (lowerMessage.includes('unauthorized') || lowerMessage.includes('forbidden')) {
    return 'AUTH_ERROR';
  }

  return 'UNKNOWN_ERROR';
}

export class KalshiConnector implements VenueConnector {
  readonly venue = 'kalshi';

  private readonly api: KalshiApi;
  private healthy = false;
  private healthCheckInterval?: NodeJS.Timeout;

  constructor(config: KalshiConnectorConfig) {
    this.api = new KalshiApi({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      privateKeyPem: config.privateKeyPem,
    });
  }

  async connect(): Promise<void> {
    try {
      // Validate credentials by fetching balance
      await this.api.getBalance();
      this.healthy = true;
      this.setHealthCheck();
    } catch (error) {
      this.healthy = false;
      throw new Error(`Failed to connect to Kalshi: ${(error as Error).message}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
    this.healthy = false;
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    try {
      const kalshiRequest = this.mapOrderRequest(order);
      logger.info({
        command_id: order.command_id,
        ticker: kalshiRequest.ticker,
        action: kalshiRequest.action,
        side: kalshiRequest.side,
        count: kalshiRequest.count,
        order_type: order.order_type,
        yes_price: kalshiRequest.yes_price,
        no_price: kalshiRequest.no_price,
      }, 'Sending order to Kalshi API');
      const response = await this.api.placeOrder(kalshiRequest);
      logger.info({
        command_id: order.command_id,
        order_id: response.order_id,
        status: response.status,
      }, 'Kalshi API response');
      return this.mapOrderResponse(response);
    } catch (error) {
      const errorMessage = (error as Error).message;
      const errorCode = mapKalshiError(errorMessage);

      return {
        order_id: order.command_id,
        status: 'rejected',
        error: `${errorCode}: ${errorMessage}`,
      };
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.api.cancelOrder(orderId);
  }

  async cancelAllOrders(): Promise<void> {
    await this.api.cancelAllOrders();
  }

  async getPositions(): Promise<Position[]> {
    const kalshiPositions = await this.api.getPositions();
    return kalshiPositions.map((pos) => this.mapPosition(pos));
  }

  async getBalance(): Promise<Balance> {
    const kalshiBalance = await this.api.getBalance();

    return {
      venue: 'kalshi',
      available: kalshiBalance.balance / 100, // Convert cents to dollars
      total: (kalshiBalance.balance + kalshiBalance.payout) / 100,
      currency: 'USD',
    };
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  /**
   * Start periodic health checks every 30 seconds.
   */
  private setHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.api.getBalance();
        this.healthy = true;
      } catch (error) {
        logger.error({ error }, 'Kalshi health check failed');
        this.healthy = false;
      }
    }, 30_000);
  }

  /**
   * Map OrderRequest to Kalshi-specific format.
   *
   * Kalshi v2 has no "type" field -- order behavior is determined by price + time_in_force.
   * Market orders: set price to extreme boundary (99 for buy, 1 for sell) to fill immediately.
   * Limit orders: set price to the user's specified limit price.
   */
  private mapOrderRequest(order: OrderRequest): KalshiOrderRequest {
    const side = order.side.toLowerCase() as 'yes' | 'no';
    const action = order.action.toLowerCase() === 'open' ? 'buy' : 'sell';

    const request: KalshiOrderRequest = {
      ticker: order.market_id,
      action,
      side,
      count: order.size,
      client_order_id: order.command_id,
    };

    // Kalshi prices are in cents (1-99 integer); gateway sends decimal (0.01-0.99)
    if (order.order_type === 'market') {
      // Market order: use extreme price to ensure immediate fill
      const extremePrice = action === 'buy' ? 99 : 1;
      if (side === 'yes') {
        request.yes_price = extremePrice;
      } else {
        request.no_price = extremePrice;
      }
    } else if (order.limit_price !== undefined) {
      // Limit order: use the specified price
      const priceCents = Math.round(order.limit_price * 100);
      if (side === 'yes') {
        request.yes_price = priceCents;
      } else {
        request.no_price = priceCents;
      }
    }

    return request;
  }

  /**
   * Map Kalshi order response to OrderResult.
   */
  private mapOrderResponse(response: KalshiOrderResponse): OrderResult {
    let status: OrderResult['status'];

    switch (response.status) {
      case 'filled':
        status = 'filled';
        break;
      case 'resting':
      case 'pending':
        status = 'submitted';
        break;
      case 'canceled':
        status = 'cancelled';
        break;
      case 'rejected':
        status = 'rejected';
        break;
      default:
        status = 'submitted';
    }

    const fillPrice = response.yes_price || response.no_price;

    return {
      order_id: response.client_order_id || response.order_id,
      venue_order_id: response.order_id,
      status,
      fill_price: fillPrice ? fillPrice / 100 : undefined, // Convert cents to dollars
      filled_at: response.updated_time || response.created_time,
    };
  }

  /**
   * Map Kalshi position to standardized Position.
   */
  private mapPosition(pos: KalshiPosition): Position {
    const size = Math.abs(pos.position);
    const side = pos.position >= 0 ? 'yes' : 'no';

    // Calculate entry price: total_traded / position
    const entryPrice = size > 0
      ? pos.total_traded_cents / (size * 100)
      : 0;

    return {
      venue: 'kalshi',
      market_id: pos.ticker,
      side,
      size,
      entry_price: entryPrice,
      unrealized_pnl: pos.market_exposure_cents / 100, // Convert cents to dollars
    };
  }
}
