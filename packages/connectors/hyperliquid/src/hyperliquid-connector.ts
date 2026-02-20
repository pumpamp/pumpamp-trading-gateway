import type {
  VenueConnector,
  OrderRequest,
  OrderResult,
  Position,
  Balance,
} from '@pumpamp/core';
import { HyperliquidApi, type HyperliquidConfig } from './hyperliquid-api.js';
import type { HyperliquidOrderRequest } from './types.js';

// ============================================================
// Hyperliquid VenueConnector implementation
// ============================================================

export class HyperliquidConnector implements VenueConnector {
  readonly venue = 'hyperliquid';

  private api: HyperliquidApi;
  private lastHealthCheck: number = 0;
  private healthy: boolean = false;
  private assetMap: Map<string, number> = new Map(); // market_id -> asset index

  constructor(config: HyperliquidConfig) {
    this.api = new HyperliquidApi(config);
  }

  async connect(): Promise<void> {
    // Validate connection by fetching metadata and positions
    try {
      const meta = await this.api.getMeta();

      // Build asset map (coin name -> index)
      meta.universe.forEach((asset, index) => {
        // Map both 'BTC' and 'BTC-PERP' to the same asset index
        this.assetMap.set(asset.name, index);
        this.assetMap.set(`${asset.name}-PERP`, index);
      });

      // Verify we can fetch clearinghouse state
      await this.api.getClearinghouseState();

      this.healthy = true;
      this.lastHealthCheck = Date.now();
    } catch (error) {
      this.healthy = false;
      throw new Error(
        `Hyperliquid connection failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async disconnect(): Promise<void> {
    this.healthy = false;
    this.assetMap.clear();
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    // Map market_id to asset index
    const assetIndex = this.assetMap.get(order.market_id);
    if (assetIndex === undefined) {
      return {
        order_id: `${Date.now()}`,
        status: 'rejected',
        error: `Unknown market: ${order.market_id}`,
      };
    }

    // Determine if buy or sell
    const isBuy =
      (order.side === 'long' && order.action === 'open') ||
      (order.side === 'short' && order.action === 'close');

    // Convert to Hyperliquid format
    const hlOrder: HyperliquidOrderRequest = {
      a: assetIndex,
      b: isBuy,
      p: order.limit_price?.toFixed(2) ?? '0', // Market orders use 0 price with IoC
      s: order.size.toFixed(6),
      r: order.action === 'close', // reduce-only for close orders
      t: {
        limit:
          order.order_type === 'limit'
            ? { tif: 'Gtc' } // Good-till-cancel for limit
            : { tif: 'Ioc' }, // Immediate-or-cancel for market
      },
    };

    try {
      const response = await this.api.placeOrder(hlOrder);

      if (response.status === 'err' || !response.response?.data?.statuses) {
        return {
          order_id: `${Date.now()}`,
          status: 'rejected',
          error: 'Order placement failed',
        };
      }

      const status = response.response.data.statuses[0];

      if (status.error) {
        return {
          order_id: `${Date.now()}`,
          status: 'rejected',
          error: status.error,
        };
      }

      if (status.filled) {
        return {
          order_id: `${Date.now()}`,
          venue_order_id: String(status.filled.oid),
          status: 'filled',
          fill_price: parseFloat(status.filled.avgPx),
          filled_at: new Date().toISOString(),
        };
      }

      if (status.resting) {
        return {
          order_id: `${Date.now()}`,
          venue_order_id: String(status.resting.oid),
          status: 'submitted',
        };
      }

      return {
        order_id: `${Date.now()}`,
        status: 'rejected',
        error: 'Unknown order status',
      };
    } catch (error) {
      return {
        order_id: `${Date.now()}`,
        status: 'rejected',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    // Parse venue_order_id format: "asset:oid"
    const [assetStr, oidStr] = orderId.split(':');
    const asset = parseInt(assetStr, 10);
    const oid = parseInt(oidStr, 10);

    if (isNaN(asset) || isNaN(oid)) {
      throw new Error(`Invalid Hyperliquid order ID format: ${orderId}`);
    }

    await this.api.cancelOrder(asset, oid);
  }

  async cancelAllOrders(): Promise<void> {
    await this.api.cancelAllOrders();
  }

  async getPositions(): Promise<Position[]> {
    const hlPositions = await this.api.getPositions();

    return hlPositions.map((p) => {
      const size = parseFloat(p.position.szi);
      const side = size > 0 ? 'long' : 'short';

      return {
        venue: 'hyperliquid',
        market_id: p.position.coin,
        side,
        size: Math.abs(size),
        entry_price: parseFloat(p.position.entryPx),
        unrealized_pnl: parseFloat(p.position.unrealizedPnl),
      };
    });
  }

  async getBalance(): Promise<Balance> {
    const balance = await this.api.getBalance();

    return {
      venue: 'hyperliquid',
      available: balance.available,
      total: balance.total,
      currency: 'USDC',
    };
  }

  isHealthy(): boolean {
    const now = Date.now();
    const staleness = now - this.lastHealthCheck;

    // Trigger background health check if stale (30s)
    if (staleness > 30_000) {
      this.performHealthCheck();
    }

    return this.healthy;
  }

  private async performHealthCheck(): Promise<void> {
    try {
      await this.api.getClearinghouseState();
      this.healthy = true;
      this.lastHealthCheck = Date.now();
    } catch (_error) {
      this.healthy = false;
    }
  }
}
