import type { TradeCommand, Position } from '../../shared/protocol.js';
import type { RiskLimits } from './strategy-config.js';

export type RiskResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export { type RiskLimits } from './strategy-config.js';

export class RiskManager {
  private config: RiskLimits;
  private tradeTimestamps: number[] = [];
  private lastTradeByMarket: Map<string, number> = new Map();

  constructor(config: RiskLimits) {
    this.config = config;
  }

  /**
   * Run all risk checks against a proposed trade.
   * Returns first failing check, or { allowed: true }.
   */
  evaluate(command: TradeCommand, positions: Position[]): RiskResult {
    // 1. Rate limit check
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;
    const recentTrades = this.tradeTimestamps.filter((t) => t > oneMinuteAgo);
    if (recentTrades.length >= this.config.max_trades_per_minute) {
      return { allowed: false, reason: 'rate_limit_exceeded' };
    }

    // 2. Cooldown per market check
    const lastTrade = this.lastTradeByMarket.get(command.market_id);
    if (lastTrade !== undefined) {
      const cooldownMs = this.config.market_cooldown_seconds * 1000;
      if (now - lastTrade < cooldownMs) {
        return { allowed: false, reason: 'cooldown_active' };
      }
    }

    // 3. Max position size per market check
    if (this.config.max_position_size_per_market !== undefined) {
      const existingPosition = positions.find((p) => p.market_id === command.market_id);
      const existingSize = existingPosition?.size ?? 0;
      if (existingSize + command.size > this.config.max_position_size_per_market) {
        return { allowed: false, reason: 'max_position_exceeded' };
      }
    }

    // 4. Max total exposure (USD) check
    if (this.config.max_total_exposure_usd !== undefined) {
      const totalExposure = positions.reduce((sum, p) => {
        return sum + p.size * (p.current_price ?? p.entry_price);
      }, 0);
      const newTradeValue = command.size * (command.limit_price ?? 1);
      if (totalExposure + newTradeValue > this.config.max_total_exposure_usd) {
        return { allowed: false, reason: 'max_exposure_exceeded' };
      }
    }

    return { allowed: true };
  }

  /**
   * Record that a trade was executed (updates rate limit and cooldown state).
   */
  recordTrade(marketId: string): void {
    const now = Date.now();
    this.tradeTimestamps.push(now);
    this.lastTradeByMarket.set(marketId, now);

    // Prune old timestamps (older than 60s)
    const oneMinuteAgo = now - 60_000;
    this.tradeTimestamps = this.tradeTimestamps.filter((t) => t > oneMinuteAgo);
  }

  /**
   * Update config (for reload).
   */
  updateConfig(config: RiskLimits): void {
    this.config = config;
  }
}
