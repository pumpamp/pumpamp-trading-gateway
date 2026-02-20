// ============================================================
// Simulator: Self-contained simulation mode for the gateway
// Provides SimulatorVenueConnector (fake venue) and
// SimulatorRelay (synthetic command generator)
// ============================================================

import { EventEmitter } from 'events';
import type { VenueConnector } from '../execution/venue-connector.js';
import type {
  OrderRequest,
  OrderResult,
  Position,
  Balance,
  TradeCommand,
} from '../../shared/protocol.js';

// ============================================================
// Configuration
// ============================================================

export interface SimulatorConfig {
  /** Interval between generated commands in seconds (default: 5) */
  interval: number;
  /** Simulated venue names (default: ['kalshi', 'binance']) */
  venues: string[];
  /** Fraction of orders that fill vs reject, 0-1 (default: 0.9) */
  fillRate: number;
  /** Simulated fill latency in milliseconds (default: 200) */
  fillDelay: number;
  /** Number of commands to generate, 0 = infinite (default: 0) */
  count: number;
  /** Scenario name: 'basic', 'mixed', 'stress' (default: 'basic') */
  scenario: 'basic' | 'mixed' | 'stress';
}

export const DEFAULT_SIMULATOR_CONFIG: SimulatorConfig = {
  interval: 5,
  venues: ['kalshi', 'binance'],
  fillRate: 0.9,
  fillDelay: 200,
  count: 0,
  scenario: 'basic',
};

// ============================================================
// Scenario definitions
// ============================================================

interface ScenarioMarket {
  venue: string;
  marketId: string;
  side: string;
  action: string;
  size: number;
  orderType: 'market' | 'limit';
  limitPrice?: number;
}

function getScenarioMarkets(scenario: string, venues: string[]): ScenarioMarket[] {
  const kalshi = venues.includes('kalshi') ? 'kalshi' : venues[0];
  const binance = venues.includes('binance') ? 'binance' : venues[venues.length - 1];

  switch (scenario) {
    case 'stress':
      return [
        { venue: kalshi, marketId: `${kalshi}:KXBTCD-SIM-STRESS`, side: 'yes', action: 'buy', size: 10, orderType: 'market' },
        { venue: binance, marketId: `${binance}:BTCUSDT`, side: 'buy', action: 'buy', size: 0.1, orderType: 'limit', limitPrice: 95000 },
        { venue: kalshi, marketId: `${kalshi}:KXETHD-SIM-STRESS`, side: 'no', action: 'buy', size: 5, orderType: 'market' },
        { venue: binance, marketId: `${binance}:ETHUSDT`, side: 'sell', action: 'sell', size: 1.0, orderType: 'market' },
      ];

    case 'mixed':
      return [
        { venue: kalshi, marketId: `${kalshi}:KXBTCD-SIM-MIX`, side: 'yes', action: 'buy', size: 10, orderType: 'market' },
        { venue: binance, marketId: `${binance}:BTCUSDT`, side: 'buy', action: 'buy', size: 0.1, orderType: 'limit', limitPrice: 95000 },
        { venue: kalshi, marketId: `${kalshi}:KXBTCD-SIM-MIX`, side: 'no', action: 'buy', size: 5, orderType: 'market' },
        { venue: binance, marketId: `${binance}:ETHUSDT`, side: 'sell', action: 'sell', size: 1.0, orderType: 'limit', limitPrice: 3200 },
      ];

    case 'basic':
    default:
      return [
        { venue: kalshi, marketId: `${kalshi}:KXBTCD-SIM-01`, side: 'yes', action: 'buy', size: 10, orderType: 'market' },
        { venue: kalshi, marketId: `${kalshi}:KXBTCD-SIM-01`, side: 'yes', action: 'sell', size: 10, orderType: 'market' },
      ];
  }
}

// ============================================================
// SimulatorVenueConnector
// ============================================================

export class SimulatorVenueConnector implements VenueConnector {
  readonly venue: string;
  private fillRate: number;
  private fillDelay: number;
  private orderCounter = 0;
  private positions: Map<string, Position> = new Map();
  private healthy = true;

  constructor(venue: string, fillRate = 0.9, fillDelay = 200) {
    this.venue = venue;
    this.fillRate = fillRate;
    this.fillDelay = fillDelay;
  }

  async connect(): Promise<void> {
    // No-op for simulator
  }

  async disconnect(): Promise<void> {
    // No-op for simulator
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    this.orderCounter++;
    const orderId = `${this.venue}-sim-${String(this.orderCounter).padStart(3, '0')}`;

    // Simulate network latency
    await new Promise((resolve) => setTimeout(resolve, this.fillDelay));

    // Determine fill vs reject
    const shouldFill = Math.random() < this.fillRate;

    if (!shouldFill) {
      return {
        order_id: orderId,
        status: 'rejected',
        error: 'Simulated rejection: insufficient liquidity',
      };
    }

    // Generate fill price
    const fillPrice = order.limit_price ?? this.generatePrice(order.market_id);

    // Track position
    const posKey = `${this.venue}:${order.market_id}`;
    const existing = this.positions.get(posKey);
    if (existing) {
      // Close or adjust position
      if (this.isClosingTrade(existing.side, order.side, order.action)) {
        this.positions.delete(posKey);
      } else {
        existing.size += order.size;
        existing.current_price = fillPrice;
      }
    } else {
      this.positions.set(posKey, {
        venue: this.venue,
        market_id: order.market_id,
        side: order.side,
        size: order.size,
        entry_price: fillPrice,
        current_price: fillPrice,
      });
    }

    return {
      order_id: orderId,
      venue_order_id: orderId,
      status: 'filled',
      fill_price: fillPrice,
      filled_at: new Date().toISOString(),
    };
  }

  async cancelOrder(_orderId: string): Promise<void> {
    // No-op for simulator
  }

  async cancelAllOrders(): Promise<void> {
    // No-op for simulator
  }

  async getPositions(): Promise<Position[]> {
    return Array.from(this.positions.values());
  }

  async getBalance(): Promise<Balance> {
    return {
      venue: this.venue,
      available: 10000,
      total: 10000,
      currency: 'USD',
    };
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  /** Reset order counter (for testing) */
  resetCounter(): void {
    this.orderCounter = 0;
  }

  private generatePrice(marketId: string): number {
    // Prediction markets: prices between 0.10 and 0.95
    if (marketId.startsWith('K') || marketId.includes('SIM')) {
      return Math.round((0.10 + Math.random() * 0.85) * 100) / 100;
    }
    // Crypto: approximate BTC/ETH prices
    if (marketId.includes('BTC')) {
      return Math.round(90000 + Math.random() * 10000);
    }
    if (marketId.includes('ETH')) {
      return Math.round(2800 + Math.random() * 800);
    }
    return Math.round(Math.random() * 1000 * 100) / 100;
  }

  private isClosingTrade(existingSide: string, newSide: string, newAction: string): boolean {
    const existingDirection = this.getDirection(existingSide);
    const incomingDirection = this.getDirection(newSide, newAction);

    if (!existingDirection || !incomingDirection) {
      return false;
    }

    return existingDirection !== incomingDirection;
  }

  private getDirection(side: string, action?: string): 'long' | 'short' | null {
    const normalizedSide = side.toLowerCase();
    const normalizedAction = action?.toLowerCase();

    // Binary markets: side chooses contract, action chooses open/close direction.
    if (normalizedSide === 'yes' || normalizedSide === 'no') {
      if (normalizedAction === 'sell' || normalizedAction === 'short') {
        return normalizedSide === 'yes' ? 'short' : 'long';
      }
      return normalizedSide === 'yes' ? 'long' : 'short';
    }

    if (normalizedAction === 'buy' || normalizedAction === 'long') {
      return 'long';
    }
    if (normalizedAction === 'sell' || normalizedAction === 'short') {
      return 'short';
    }

    if (normalizedSide === 'buy' || normalizedSide === 'long') {
      return 'long';
    }
    if (normalizedSide === 'sell' || normalizedSide === 'short') {
      return 'short';
    }

    return null;
  }
}

// ============================================================
// SimulatorRelay
// ============================================================

export class SimulatorRelay extends EventEmitter {
  private config: SimulatorConfig;
  private timer: NodeJS.Timeout | null = null;
  private commandCount = 0;
  private fillCount = 0;
  private rejectCount = 0;
  private markets: ScenarioMarket[];
  private marketIndex = 0;
  private startTime = 0;

  constructor(config: Partial<SimulatorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_SIMULATOR_CONFIG, ...config };
    this.markets = getScenarioMarkets(this.config.scenario, this.config.venues);
  }

  /**
   * Start generating synthetic trade commands.
   * Emits 'command' with a BotUserCommand on each tick.
   */
  start(): void {
    this.startTime = Date.now();

    console.log(`[SIM] Gateway simulation started`);
    console.log(`[SIM] Venues: ${this.config.venues.map((v) => `${v} (sim)`).join(', ')}`);
    console.log(
      `[SIM] Interval: ${this.config.interval}s | Fill rate: ${Math.round(this.config.fillRate * 100)}% | Scenario: ${this.config.scenario}`
    );
    console.log('-------------------------------------------------------');

    // Generate first command immediately
    this.generateCommand();

    // Continue at interval
    this.timer = setInterval(() => {
      this.generateCommand();
    }, this.config.interval * 1000);
  }

  /**
   * Stop command generation and print summary.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    console.log('');
    console.log(
      `[SIM] Simulation complete. ${this.commandCount} commands, ${this.fillCount} fills, ${this.rejectCount} rejects.`
    );
    this.emit('stopped');
  }

  /**
   * Record an order fill (called by the simulate command handler).
   */
  recordFill(): void {
    this.fillCount++;
  }

  /**
   * Record an order rejection (called by the simulate command handler).
   */
  recordReject(): void {
    this.rejectCount++;
  }

  /** Get stats for testing */
  getStats(): { commands: number; fills: number; rejects: number } {
    return {
      commands: this.commandCount,
      fills: this.fillCount,
      rejects: this.rejectCount,
    };
  }

  private generateCommand(): void {
    if (this.config.count > 0 && this.commandCount >= this.config.count) {
      this.stop();
      return;
    }

    const market = this.markets[this.marketIndex % this.markets.length];
    this.marketIndex++;
    this.commandCount++;

    const command: TradeCommand = {
      type: 'trade',
      id: `sim-cmd-${String(this.commandCount).padStart(3, '0')}`,
      market_id: market.marketId,
      venue: market.venue,
      side: market.side,
      action: market.action,
      size: market.size,
      order_type: market.orderType,
      limit_price: market.limitPrice,
    };

    // Log the command
    const elapsed = this.formatElapsed();
    const priceStr = market.limitPrice ? `limit $${market.limitPrice}` : 'market';
    console.log(
      `[${elapsed}] CMD  trade  ${market.marketId.padEnd(30)}  ${market.side}/${market.action}  ${market.size}  ${priceStr}`
    );

    this.emit('command', command);
  }

  private formatElapsed(): string {
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    return `${mins}:${secs}`;
  }
}

// ============================================================
// Console formatting helpers (used by CLI simulate command)
// ============================================================

export function formatFill(
  marketId: string,
  fillPrice: number,
  orderId: string,
  elapsed: string
): string {
  return `[${elapsed}] FILL ${marketId.padEnd(30)}  filled @ $${fillPrice}  order=${orderId}`;
}

export function formatReject(marketId: string, reason: string, elapsed: string): string {
  return `[${elapsed}] REJ  ${marketId.padEnd(30)}  ${reason}`;
}

export function formatPosition(
  marketId: string,
  side: string,
  size: number,
  entryPrice: number,
  elapsed: string
): string {
  return `[${elapsed}] POS  ${marketId.padEnd(30)}  ${side}  ${size}  entry=$${entryPrice}`;
}

export function formatSettlement(
  marketId: string,
  pnl: number,
  elapsed: string
): string {
  const sign = pnl >= 0 ? '+' : '-';
  return `[${elapsed}] SETTLE ${marketId.padEnd(28)}  P&L: ${sign}$${Math.abs(pnl).toFixed(2)}`;
}
