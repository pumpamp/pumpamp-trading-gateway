import type { VenueConnector, OrderRequest, OrderResult, Position, Balance } from '@pumpamp/core';
import { BinanceApi } from './binance-api.js';
import type { BinanceOrderRequest, BinanceOrderResponse, BinancePosition } from './types.js';

export interface BinanceConnectorConfig {
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
  futures?: boolean;
}

export class BinanceConnector implements VenueConnector {
  public readonly venue = 'binance';
  private readonly api: BinanceApi;
  private lastHealthCheck = 0;
  private healthy = false;
  private readonly healthCheckInterval = 30_000; // 30 seconds

  constructor(config: BinanceConnectorConfig) {
    this.api = new BinanceApi({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      futures: config.futures ?? false,
    });
  }

  async connect(): Promise<void> {
    try {
      await this.api.getBalance();
      this.healthy = true;
      this.lastHealthCheck = Date.now();
    } catch (error) {
      this.healthy = false;
      throw new Error(`Failed to connect to Binance: ${error}`);
    }
  }

  async disconnect(): Promise<void> {
    this.healthy = false;
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    try {
      const binanceOrder = this.mapToBinanceOrder(order);
      const response = await this.api.placeOrder(binanceOrder);

      return this.mapToOrderResult(order.command_id, response);
    } catch (error) {
      const mappedError = this.mapError(error);
      return {
        order_id: order.command_id,
        status: 'rejected',
        error: mappedError,
      };
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    // Extract Binance order ID from our internal ID format
    // Expected format: "binance-BTCUSDT-123456"
    const parts = orderId.split('-');
    if (parts.length < 3) {
      throw new Error(`Invalid order ID format: ${orderId}`);
    }

    const symbol = parts[1];
    const binanceOrderId = parseInt(parts[2], 10);

    await this.api.cancelOrder(symbol, binanceOrderId);
  }

  async cancelAllOrders(): Promise<void> {
    // Get all positions to find active symbols
    const positions = await this.getPositions();
    const symbols = new Set(positions.map((p) => this.extractSymbol(p.market_id)));

    // Cancel all orders for each symbol
    for (const symbol of symbols) {
      try {
        await this.api.cancelAllOrders(symbol);
      } catch (error) {
        console.error(`Failed to cancel orders for ${symbol}:`, error);
      }
    }
  }

  async getPositions(): Promise<Position[]> {
    const binancePositions = await this.api.getPositions();

    return binancePositions
      .filter((p) => parseFloat(p.positionAmt) !== 0) // Filter out zero positions
      .map((p) => this.mapToPosition(p));
  }

  async getBalance(): Promise<Balance> {
    const balanceData = await this.api.getBalance();

    if (Array.isArray(balanceData)) {
      // Futures balance
      const usdtBalance = balanceData.find((b) => b.asset === 'USDT');
      if (!usdtBalance) {
        throw new Error('USDT balance not found');
      }

      return {
        venue: 'binance',
        available: parseFloat(usdtBalance.availableBalance),
        total: parseFloat(usdtBalance.balance),
        currency: 'USDT',
      };
    } else {
      // Spot balance
      const usdtBalance = balanceData.balances.find((b) => b.asset === 'USDT');
      if (!usdtBalance) {
        throw new Error('USDT balance not found');
      }

      const available = parseFloat(usdtBalance.free);
      const locked = parseFloat(usdtBalance.locked);

      return {
        venue: 'binance',
        available,
        total: available + locked,
        currency: 'USDT',
      };
    }
  }

  isHealthy(): boolean {
    const now = Date.now();
    if (now - this.lastHealthCheck > this.healthCheckInterval) {
      // Trigger async health check without blocking
      this.performHealthCheck().catch(console.error);
    }
    return this.healthy;
  }

  // --- Private helpers ---

  private async performHealthCheck(): Promise<void> {
    try {
      await this.api.getBalance();
      this.healthy = true;
      this.lastHealthCheck = Date.now();
    } catch (error) {
      console.error('Binance health check failed:', error);
      this.healthy = false;
    }
  }

  private mapToBinanceOrder(order: OrderRequest): Partial<BinanceOrderRequest> {
    const symbol = this.extractSymbol(order.market_id);
    const side = this.mapSide(order.side, order.action);
    const type = order.order_type === 'market' ? 'MARKET' : 'LIMIT';

    const binanceOrder: Partial<BinanceOrderRequest> = {
      symbol,
      side,
      type,
      quantity: order.size,
      timestamp: Date.now(),
    };

    if (type === 'LIMIT' && order.limit_price) {
      binanceOrder.price = order.limit_price;
      binanceOrder.timeInForce = 'GTC';
    }

    // Set reduceOnly for closing positions
    if (order.action === 'close') {
      binanceOrder.reduceOnly = true;
    }

    return binanceOrder;
  }

  private mapToOrderResult(commandId: string, response: BinanceOrderResponse): OrderResult {
    const status = this.mapOrderStatus(response.status);
    const fillPrice = parseFloat(response.avgPrice) || undefined;

    return {
      order_id: commandId,
      venue_order_id: `binance-${response.symbol}-${response.orderId}`,
      status,
      fill_price: fillPrice && fillPrice > 0 ? fillPrice : undefined,
      filled_at: status === 'filled' ? new Date(response.updateTime).toISOString() : undefined,
    };
  }

  private mapToPosition(p: BinancePosition): Position {
    const size = parseFloat(p.positionAmt);
    const side = size > 0 ? 'long' : 'short';

    return {
      venue: 'binance',
      market_id: p.symbol,
      side,
      size: Math.abs(size),
      entry_price: parseFloat(p.entryPrice),
      current_price: parseFloat(p.markPrice),
      unrealized_pnl: parseFloat(p.unRealizedProfit),
    };
  }

  private extractSymbol(marketId: string): string {
    // Market ID format: "binance:BTCUSDT" -> "BTCUSDT"
    const parts = marketId.split(':');
    return parts.length > 1 ? parts[1] : marketId;
  }

  private mapSide(side: string, action: string): 'BUY' | 'SELL' {
    // For opening positions: side is 'long' or 'short'
    // For closing positions: reverse the side
    if (action === 'open') {
      return side === 'long' ? 'BUY' : 'SELL';
    } else {
      return side === 'long' ? 'SELL' : 'BUY';
    }
  }

  private mapOrderStatus(
    status: BinanceOrderResponse['status']
  ): OrderResult['status'] {
    switch (status) {
      case 'NEW':
      case 'PARTIALLY_FILLED':
        return 'submitted';
      case 'FILLED':
        return 'filled';
      case 'CANCELED':
        return 'cancelled';
      case 'REJECTED':
      case 'EXPIRED':
        return 'rejected';
      default:
        return 'rejected';
    }
  }

  private mapError(error: unknown): string {
    if (error instanceof Error) {
      const message = error.message;

      // Map Binance error codes to standard error types
      if (message.includes('-2019')) {
        return 'INSUFFICIENT_BALANCE';
      }
      if (message.includes('-1102')) {
        return 'INVALID_ORDER';
      }
      if (message.includes('-1003')) {
        return 'RATE_LIMITED';
      }
      if (message.includes('-2010')) {
        return 'ORDER_NOT_FOUND';
      }
      if (message.includes('-1021')) {
        return 'TIMESTAMP_OUT_OF_SYNC';
      }

      return `BINANCE_ERROR: ${message}`;
    }

    return 'UNKNOWN_ERROR';
  }
}
