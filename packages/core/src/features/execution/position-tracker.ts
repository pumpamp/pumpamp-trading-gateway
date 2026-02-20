// ============================================================
// Position Tracker - Aggregate positions across venues
// ============================================================

import { EventEmitter } from 'events';
import { Position, Settlement } from '../../shared/protocol.js';

/**
 * Aggregates positions across venues and tracks settlements.
 * Emits events: 'position_update', 'position_removed', 'settlement'
 */
export class PositionTracker extends EventEmitter {
  private positions: Map<string, Position>;
  private settlements: Settlement[];

  constructor() {
    super();
    this.positions = new Map();
    this.settlements = [];
  }

  /**
   * Upsert position by venue:market_id key.
   * Computes unrealized P&L if current_price is available.
   */
  updatePosition(position: Position): void {
    const key = this.makeKey(position.venue, position.market_id);

    // Compute unrealized P&L if current_price exists
    const positionWithPnl: Position = {
      ...position,
      unrealized_pnl: this.computePnl(position),
    };

    this.positions.set(key, positionWithPnl);
    this.emit('position_update', positionWithPnl);
  }

  /**
   * Remove position from tracking.
   */
  removePosition(venue: string, marketId: string): void {
    const key = this.makeKey(venue, marketId);
    const position = this.positions.get(key);
    if (position) {
      this.positions.delete(key);
      this.emit('position_removed', { venue, market_id: marketId });
    }
  }

  /**
   * Record settlement, remove corresponding position, emit event.
   */
  addSettlement(settlement: Settlement): void {
    this.settlements.push(settlement);
    this.removePosition(settlement.venue, settlement.market_id);
    this.emit('settlement', settlement);
  }

  /**
   * Get all current positions.
   */
  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get all recorded settlements.
   */
  getSettlements(): Settlement[] {
    return [...this.settlements];
  }

  /**
   * Compute unrealized P&L for a position.
   * Returns undefined if current_price is not available.
   *
   * Logic:
   * - Long positions (yes/buy/long): (current_price - entry_price) * size
   * - Short positions (no/sell/short): (entry_price - current_price) * size
   */
  computePnl(position: Position): number | undefined {
    if (position.current_price === undefined) {
      return undefined;
    }

    const isLong = this.isLongSide(position.side);
    const priceDiff = isLong
      ? position.current_price - position.entry_price
      : position.entry_price - position.current_price;

    return priceDiff * position.size;
  }

  /**
   * Determine if a side is long (yes/buy/long) vs short (no/sell/short).
   */
  private isLongSide(side: string): boolean {
    const normalized = side.toLowerCase();
    return normalized === 'yes' || normalized === 'buy' || normalized === 'long';
  }

  /**
   * Generate composite key for position tracking.
   */
  private makeKey(venue: string, marketId: string): string {
    return `${venue}:${marketId}`;
  }
}
