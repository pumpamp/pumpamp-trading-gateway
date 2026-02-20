// ============================================================
// OrderRouter: Routes commands to venue connectors
// Handles trade execution, cancellations, order lifecycle tracking
// ============================================================

import { EventEmitter } from 'events';
import type {
  BotUserCommand,
  TradeCommand,
  CancelCommand,
  CancelAllCommand,
  PauseCommand,
  ResumeCommand,
  OrderRequest,
  OrderUpdateReport,
  ErrorReport,
} from '../../shared/protocol.js';
import type { VenueConnector } from './venue-connector.js';
import { createLogger } from '../../shared/logger.js';

const logger = createLogger('OrderRouter');

export interface MarketIdParts {
  venue: string;
  nativeId: string;
}

export interface OrderState {
  orderId: string;
  venue: string;
  marketId: string;
  status: 'pending' | 'submitted' | 'filled' | 'rejected' | 'cancelled';
  commandId: string;
}

/**
 * Parse market_id string (format: "venue:native_id")
 * @param marketId - Market identifier (e.g., "kalshi:KXBTCD-26FEB11")
 * @returns Parsed venue and native_id, or null on error
 */
export function parseMarketId(marketId: string): MarketIdParts | null {
  const colonIndex = marketId.indexOf(':');
  if (colonIndex === -1) {
    return null;
  }

  const venue = marketId.substring(0, colonIndex);
  const nativeId = marketId.substring(colonIndex + 1);

  if (!venue || !nativeId) {
    return null;
  }

  return { venue, nativeId };
}

/**
 * OrderRouter manages command routing and order lifecycle
 * Events:
 * - 'order_update': (OrderUpdateReport) - Order status changes
 * - 'error': (ErrorReport) - Routing or execution errors
 */
export class OrderRouter extends EventEmitter {
  private connectors = new Map<string, VenueConnector>();
  private orders = new Map<string, OrderState>();
  private paused = false;

  /**
   * Register a venue connector
   * @param connector - Venue connector instance
   */
  registerConnector(connector: VenueConnector): void {
    this.connectors.set(connector.venue.toLowerCase(), connector);
  }

  /**
   * Route incoming command to appropriate handler
   * @param command - Bot user command
   */
  async routeCommand(command: BotUserCommand): Promise<void> {
    switch (command.type) {
      case 'trade':
        await this.handleTradeCommand(command);
        break;
      case 'cancel':
        await this.handleCancelCommand(command);
        break;
      case 'cancel_all':
        await this.handleCancelAllCommand(command);
        break;
      case 'pause':
        this.handlePauseCommand(command);
        break;
      case 'resume':
        this.handleResumeCommand(command);
        break;
    }
  }

  /**
   * Handle trade command
   */
  private async handleTradeCommand(command: TradeCommand): Promise<void> {
    // Check if gateway is paused
    if (this.paused) {
      this.emitError({
        type: 'error',
        code: 'GATEWAY_PAUSED',
        message: 'Gateway is paused, trade command rejected',
        command_id: command.id,
      });
      return;
    }

    // Parse market_id to extract venue and native_id
    const parsed = parseMarketId(command.market_id);
    if (!parsed) {
      this.emitError({
        type: 'error',
        code: 'INVALID_MARKET_ID',
        message: `Invalid market_id format: ${command.market_id}. Expected "venue:native_id"`,
        command_id: command.id,
      });
      return;
    }

    const { venue, nativeId } = parsed;

    // Find matching connector
    const connector = this.connectors.get(venue.toLowerCase());
    if (!connector) {
      this.emitError({
        type: 'error',
        code: 'VENUE_NOT_FOUND',
        venue,
        message: `No connector registered for venue: ${venue}`,
        command_id: command.id,
      });
      return;
    }

    // Check venue health
    if (!connector.isHealthy()) {
      this.emitError({
        type: 'error',
        code: 'VENUE_UNHEALTHY',
        venue,
        message: `Venue ${venue} is not healthy`,
        command_id: command.id,
      });
      return;
    }

    // Create order request
    const orderRequest: OrderRequest = {
      market_id: nativeId,
      venue,
      side: command.side,
      action: command.action,
      size: command.size,
      order_type: command.order_type as 'market' | 'limit',
      limit_price: command.limit_price,
      command_id: command.id,
    };

    // Track order as pending
    const orderId = `${venue}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    this.orders.set(orderId, {
      orderId,
      venue,
      marketId: command.market_id,
      status: 'pending',
      commandId: command.id,
    });

    logger.info({
      command_id: command.id,
      venue,
      market_id: nativeId,
      side: command.side,
      action: command.action,
      size: command.size,
      order_type: command.order_type,
      limit_price: command.limit_price,
    }, 'Routing trade to venue connector');

    try {
      // Place order via connector
      const result = await connector.placeOrder(orderRequest);

      logger.info({
        command_id: command.id,
        venue,
        order_id: result.order_id,
        status: result.status,
        venue_order_id: result.venue_order_id,
        fill_price: result.fill_price,
      }, 'Venue order result');

      // Update order state
      const order = this.orders.get(orderId)!;
      order.status = result.status;
      this.orders.set(orderId, order);

      // Emit order update
      this.emit('order_update', {
        type: 'order_update',
        order_id: orderId,
        venue,
        venue_order_id: result.venue_order_id,
        market_id: command.market_id,
        status: result.status,
        side: command.side,
        action: command.action,
        size: command.size,
        fill_price: result.fill_price,
        filled_at: result.filled_at,
      } as OrderUpdateReport);

      // If order was rejected, also emit error
      if (result.status === 'rejected' && result.error) {
        this.emitError({
          type: 'error',
          code: 'ORDER_REJECTED',
          venue,
          message: result.error,
          command_id: command.id,
        });
      }
    } catch (error) {
      // Update order state to rejected
      const order = this.orders.get(orderId)!;
      order.status = 'rejected';
      this.orders.set(orderId, order);

      // Emit error
      this.emitError({
        type: 'error',
        code: 'ORDER_PLACEMENT_FAILED',
        venue,
        message: error instanceof Error ? error.message : String(error),
        command_id: command.id,
      });

      // Emit order update with rejected status
      this.emit('order_update', {
        type: 'order_update',
        order_id: orderId,
        venue,
        market_id: command.market_id,
        status: 'rejected',
        side: command.side,
        action: command.action,
        size: command.size,
      } as OrderUpdateReport);
    }
  }

  /**
   * Handle cancel command
   */
  private async handleCancelCommand(command: CancelCommand): Promise<void> {
    // Find order in tracking
    const order = this.orders.get(command.order_id);
    if (!order) {
      this.emitError({
        type: 'error',
        code: 'ORDER_NOT_FOUND',
        message: `Order not found: ${command.order_id}`,
        command_id: command.id,
      });
      return;
    }

    // Get connector for venue
    const connector = this.connectors.get(order.venue.toLowerCase());
    if (!connector) {
      this.emitError({
        type: 'error',
        code: 'VENUE_NOT_FOUND',
        venue: order.venue,
        message: `No connector registered for venue: ${order.venue}`,
        command_id: command.id,
      });
      return;
    }

    try {
      // Cancel order via connector
      await connector.cancelOrder(command.order_id);

      // Update order state
      order.status = 'cancelled';
      this.orders.set(command.order_id, order);

      // Emit order update
      this.emit('order_update', {
        type: 'order_update',
        order_id: command.order_id,
        venue: order.venue,
        market_id: order.marketId,
        status: 'cancelled',
        side: 'unknown', // Not tracked in OrderState
        action: 'unknown',
        size: 0,
      } as OrderUpdateReport);
    } catch (error) {
      this.emitError({
        type: 'error',
        code: 'CANCEL_FAILED',
        venue: order.venue,
        message: error instanceof Error ? error.message : String(error),
        command_id: command.id,
      });
    }
  }

  /**
   * Handle cancel_all command
   */
  private async handleCancelAllCommand(command: CancelAllCommand): Promise<void> {
    const cancelPromises: Promise<void>[] = [];

    // Call cancelAllOrders on all connectors
    for (const [venueName, connector] of this.connectors.entries()) {
      cancelPromises.push(
        connector.cancelAllOrders().catch((error) => {
          this.emitError({
            type: 'error',
            code: 'CANCEL_ALL_FAILED',
            venue: venueName,
            message: error instanceof Error ? error.message : String(error),
            command_id: command.id,
          });
        })
      );
    }

    // Wait for all cancellations to complete
    await Promise.allSettled(cancelPromises);

    // Update all tracked orders to cancelled and emit updates
    for (const [orderId, order] of this.orders.entries()) {
      if (order.status === 'pending' || order.status === 'submitted') {
        order.status = 'cancelled';
        this.orders.set(orderId, order);

        this.emit('order_update', {
          type: 'order_update',
          order_id: orderId,
          venue: order.venue,
          market_id: order.marketId,
          status: 'cancelled',
          side: 'unknown',
          action: 'unknown',
          size: 0,
        } as OrderUpdateReport);
      }
    }
  }

  /**
   * Handle pause command
   */
  private handlePauseCommand(_command: PauseCommand): void {
    this.paused = true;
  }

  /**
   * Handle resume command
   */
  private handleResumeCommand(_command: ResumeCommand): void {
    this.paused = false;
  }

  /**
   * Emit error report
   */
  private emitError(error: ErrorReport): void {
    this.emit('error', error);
  }

  /**
   * Get current pause state
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Get all tracked orders
   */
  getOrders(): Map<string, OrderState> {
    return new Map(this.orders);
  }

  /**
   * Get registered connectors
   */
  getConnectors(): Map<string, VenueConnector> {
    return new Map(this.connectors);
  }
}
