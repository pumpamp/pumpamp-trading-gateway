import type { OrderRequest, OrderResult, Position, Balance } from '../../shared/protocol.js';

export interface VenueConnector {
  readonly venue: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  placeOrder(order: OrderRequest): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  cancelAllOrders(): Promise<void>;
  getPositions(): Promise<Position[]>;
  getBalance(): Promise<Balance>;
  isHealthy(): boolean;
  onPositionUpdate?(callback: (position: Position) => void): void;
}
