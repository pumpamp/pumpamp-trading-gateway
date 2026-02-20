import { EventEmitter } from 'events';
import type { TradeCommand, Position, ArbitragePayloadV1 } from '../../shared/protocol.js';
import type { Signal } from '../signals/signal-consumer.js';
import type { StrategyConfig, StrategyRule } from './strategy-config.js';
import { MarketIdMapper } from './market-id-mapper.js';
import { RiskManager } from './risk-manager.js';
import { createLogger } from '../../shared/logger.js';

const logger = createLogger('StrategyEngine');

// Severity ranking for min_severity comparison
const SEVERITY_RANK: Record<string, number> = {
  Low: 1,
  Medium: 2,
  High: 3,
  Critical: 4,
};

// Prediction market venues
const PREDICTION_VENUES = new Set(['kalshi', 'polymarket']);

function isPredictionVenue(venue: string): boolean {
  return PREDICTION_VENUES.has(venue.toLowerCase());
}

function randomId(): string {
  return Math.random().toString(36).substring(2, 9);
}

export interface StrategyStatus {
  state: string;
  rules_count: number;
  rules_enabled: number;
  signals_received: number;
  signals_matched: number;
  trades_generated: number;
  trades_rejected_by_risk: number;
  dry_run_trades: number;
  signals_dropped_stale_or_duplicate: number;
}

export class StrategyEngine extends EventEmitter {
  private config: StrategyConfig;
  private mapper: MarketIdMapper;
  private riskManager: RiskManager;
  private enabled: boolean;
  private positionsFn: () => Position[];

  // Dedup state
  private processedSignalIds: Map<string, number> = new Map();

  // Metrics
  private signalsReceived = 0;
  private signalsMatched = 0;
  private tradesGenerated = 0;
  private tradesRejectedByRisk = 0;
  private dryRunTrades = 0;
  private signalsDroppedStaleOrDuplicate = 0;

  constructor(
    config: StrategyConfig,
    positionsFn: () => Position[],
  ) {
    super();
    this.config = config;
    this.mapper = new MarketIdMapper(config.market_mappings);
    this.riskManager = new RiskManager(config.risk_limits);
    this.enabled = config.enabled;
    this.positionsFn = positionsFn;
  }

  /**
   * Process an incoming signal. Returns the generated TradeCommand(s) (or null).
   * For arbitrage signals, returns an array of two commands (buy + sell legs).
   */
  handleSignal(signal: Signal): TradeCommand | TradeCommand[] | null {
    // 1. If disabled, drop
    if (!this.enabled) return null;

    // 2. Count
    this.signalsReceived++;

    // 3. Check expiry
    if (signal.expires_at) {
      const expiresAt = new Date(signal.expires_at).getTime();
      if (expiresAt <= Date.now()) {
        this.signalsDroppedStaleOrDuplicate++;
        logger.debug({ signal_id: signal.id }, 'Expired signal dropped');
        return null;
      }
    }

    // 4. Dedup check
    const dedupWindowMs = this.config.risk_limits.signal_dedup_window_seconds * 1000;
    const previousTimestamp = this.processedSignalIds.get(signal.id);
    if (previousTimestamp !== undefined) {
      if (Date.now() - previousTimestamp < dedupWindowMs) {
        this.signalsDroppedStaleOrDuplicate++;
        logger.debug({ signal_id: signal.id }, 'Duplicate signal dropped');
        return null;
      }
    }
    this.processedSignalIds.set(signal.id, Date.now());

    // Prune old dedup entries
    this.pruneProcessedSignals();

    // 5. Match rules
    const matchedRules = this.matchRules(signal);
    if (matchedRules.length === 0) return null;

    // 6. First match wins
    this.signalsMatched++;
    const rule = matchedRules[0];

    // 7. Check if this is an arbitrage signal with ArbitragePayloadV1
    if (this.isArbSignal(signal)) {
      return this.handleArbSignal(signal, rule);
    }

    // 8a. Resolve market_id
    const venueNativeId = this.mapper.resolve(signal.market_id);
    if (!venueNativeId) {
      logger.warn({ market_id: signal.market_id }, 'No market mapping found');
      return null;
    }

    // 8b. Build command
    const command = this.buildCommand(signal, rule, venueNativeId);
    if (!command) return null;

    // 8c. Risk check
    const positions = this.positionsFn();
    const riskResult = this.riskManager.evaluate(command, positions);
    if (!riskResult.allowed) {
      this.tradesRejectedByRisk++;
      logger.info({ reason: riskResult.reason, market_id: command.market_id }, 'Risk check failed');
      return null;
    }

    // 8d. Dry-run mode
    if (this.config.dry_run) {
      this.dryRunTrades++;
      logger.info(
        { venue: command.venue, side: command.side, size: command.size, market_id: command.market_id },
        '[DRY RUN] Would execute trade',
      );
      this.emit('dry_run_trade', command);
      return command;
    }

    // 8e. Live mode
    this.tradesGenerated++;
    this.emit('trade_generated', command);
    return command;
  }

  /**
   * Record that a trade was executed (called by Gateway after successful injectCommand).
   */
  recordExecutedTrade(marketId: string): void {
    this.riskManager.recordTrade(marketId);
  }

  /**
   * Get current strategy status for heartbeat.
   */
  getStatus(): StrategyStatus {
    return {
      state: this.getStatusString(),
      rules_count: this.config.rules.length,
      rules_enabled: this.config.rules.filter((r) => r.enabled).length,
      signals_received: this.signalsReceived,
      signals_matched: this.signalsMatched,
      trades_generated: this.tradesGenerated,
      trades_rejected_by_risk: this.tradesRejectedByRisk,
      dry_run_trades: this.dryRunTrades,
      signals_dropped_stale_or_duplicate: this.signalsDroppedStaleOrDuplicate,
    };
  }

  /**
   * Get status string for heartbeat.
   */
  getStatusString(): string {
    if (!this.enabled) return 'disabled';
    if (this.config.dry_run) return 'active:dry_run';
    return 'active';
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // --- Private methods ---

  /**
   * Check if a signal is an arbitrage signal with ArbitragePayloadV1 payload.
   */
  private isArbSignal(signal: Signal): boolean {
    if (signal.signal_name !== 'cross_venue_arbitrage') return false;
    if (signal.signal_type !== 'alert' && signal.signal_type !== 'cross_venue_arbitrage') return false;

    const payload = signal.payload as Record<string, unknown> | null;
    return !!(
      payload &&
      typeof payload === 'object' &&
      'buy_market_id' in payload &&
      'sell_market_id' in payload &&
      'buy_venue' in payload &&
      'sell_venue' in payload
    );
  }

  /**
   * Handle arbitrage signal: extract buy/sell legs from ArbitragePayloadV1 payload.
   * Returns array of two TradeCommands or null if validation/risk fails.
   */
  private handleArbSignal(signal: Signal, rule: StrategyRule): TradeCommand[] | null {
    const payload = signal.payload as ArbitragePayloadV1 | null;
    if (!payload || !payload.buy_market_id || !payload.sell_market_id || !payload.buy_venue || !payload.sell_venue) {
      logger.warn({ signal_id: signal.id }, 'Arb signal missing required payload fields');
      return null;
    }

    const commands = this.buildArbCommands(signal, rule, payload);
    if (!commands) return null;

    // Risk check both legs - if either fails, reject both
    const positions = this.positionsFn();
    for (const cmd of commands) {
      const riskResult = this.riskManager.evaluate(cmd, positions);
      if (!riskResult.allowed) {
        this.tradesRejectedByRisk++;
        logger.info({ reason: riskResult.reason, market_id: cmd.market_id }, 'Arb risk check failed - both legs rejected');
        return null;
      }
    }

    // Dry-run mode
    if (this.config.dry_run) {
      this.dryRunTrades += commands.length;
      for (const cmd of commands) {
        logger.info(
          { venue: cmd.venue, side: cmd.side, size: cmd.size, market_id: cmd.market_id },
          '[DRY RUN] Would execute arb leg',
        );
        this.emit('dry_run_trade', cmd);
      }
      return commands;
    }

    // Live mode
    this.tradesGenerated += commands.length;
    for (const cmd of commands) {
      this.emit('trade_generated', cmd);
    }
    return commands;
  }

  /**
   * Build two TradeCommands from an ArbitragePayloadV1 payload (buy + sell legs).
   *
   * For super_hedge signals, both legs use action:'open' with
   * side:'Yes' or 'No' to buy complementary outcomes. For directional signals,
   * uses the existing buy/sell pattern.
   *
   * Also checks signal_cutoff_utc — if past cutoff, returns null to skip execution.
   */
  private buildArbCommands(
    signal: Signal,
    rule: StrategyRule,
    payload: ArbitragePayloadV1,
  ): [TradeCommand, TradeCommand] | null {
    // Check cutoff time for 15m ephemeral pairs
    const nowMs = Date.now();
    if (payload.signal_cutoff_utc) {
      const cutoffMs = new Date(payload.signal_cutoff_utc).getTime();
      if (!Number.isNaN(cutoffMs) && nowMs >= cutoffMs) {
        return null;
      }
    } else if (payload.window_end_utc) {
      const windowEndMs = new Date(payload.window_end_utc).getTime();
      const fallbackCutoffMs = windowEndMs - 15 * 1000;
      if (!Number.isNaN(windowEndMs) && nowMs >= fallbackCutoffMs) {
        return null;
      }
    }

    // Super-hedge uses action:'open' with side:'Yes'/'No'
    if (payload.strategy === 'super_hedge' && payload.buy_outcome && payload.sell_outcome) {
      const buyCommand: TradeCommand = {
        type: 'trade',
        id: `auto-${rule.name}-buy-${Date.now()}-${randomId()}`,
        market_id: `${payload.buy_venue}:${payload.buy_market_id}`,
        venue: payload.buy_venue,
        side: payload.buy_outcome,
        action: 'open',
        size: rule.action.size,
        order_type: rule.action.order_type,
      };

      const sellCommand: TradeCommand = {
        type: 'trade',
        id: `auto-${rule.name}-sell-${Date.now()}-${randomId()}`,
        market_id: `${payload.sell_venue}:${payload.sell_market_id}`,
        venue: payload.sell_venue,
        side: payload.sell_outcome,
        action: 'open',
        size: rule.action.size,
        order_type: rule.action.order_type,
      };

      return [buyCommand, sellCommand];
    }

    // Directional: standard buy/sell
    const buyCommand: TradeCommand = {
      type: 'trade',
      id: `auto-${rule.name}-buy-${Date.now()}-${randomId()}`,
      market_id: `${payload.buy_venue}:${payload.buy_market_id}`,
      venue: payload.buy_venue,
      side: 'buy',
      action: 'buy',
      size: rule.action.size,
      order_type: rule.action.order_type,
    };

    const sellCommand: TradeCommand = {
      type: 'trade',
      id: `auto-${rule.name}-sell-${Date.now()}-${randomId()}`,
      market_id: `${payload.sell_venue}:${payload.sell_market_id}`,
      venue: payload.sell_venue,
      side: 'sell',
      action: 'sell',
      size: rule.action.size,
      order_type: rule.action.order_type,
    };

    return [buyCommand, sellCommand];
  }

  private matchRules(signal: Signal): StrategyRule[] {
    return this.config.rules.filter((rule) => {
      if (!rule.enabled) return false;

      // Signal type must match
      if (!rule.signal_types.includes(signal.signal_type)) return false;

      // Signal name filter (optional)
      if (rule.signal_names && !rule.signal_names.includes(signal.signal_name)) return false;

      // Venue filter (optional)
      if (rule.venues && !rule.venues.includes(signal.venue)) return false;

      // Symbol filter (optional)
      if (rule.symbols) {
        const symbol = `${signal.base_currency}/${signal.quote_currency}`;
        if (!rule.symbols.includes(symbol)) return false;
      }

      // Confidence gate (optional)
      if (rule.min_confidence !== undefined) {
        const confidence = signal.confidence ? parseFloat(signal.confidence) : 0;
        if (confidence < rule.min_confidence) return false;
      }

      // Severity gate (optional)
      if (rule.min_severity !== undefined) {
        const signalRank = SEVERITY_RANK[signal.severity ?? 'Low'] ?? 0;
        const ruleRank = SEVERITY_RANK[rule.min_severity] ?? 0;
        if (signalRank < ruleRank) return false;
      }

      // Direction filter (optional)
      if (rule.directions && signal.direction) {
        if (!rule.directions.includes(signal.direction)) return false;
      }

      return true;
    });
  }

  private buildCommand(
    signal: Signal,
    rule: StrategyRule,
    venueNativeId: string,
  ): TradeCommand | null {
    const venue = venueNativeId.substring(0, venueNativeId.indexOf(':'));

    const side = this.deriveSide(rule, signal, venue);
    if (!side) return null;

    const command: TradeCommand = {
      type: 'trade',
      id: `auto-${rule.name}-${Date.now()}-${randomId()}`,
      market_id: venueNativeId,
      venue,
      side,
      action: 'buy',
      size: rule.action.size,
      order_type: rule.action.order_type,
    };

    if (rule.action.limit_price_offset_bps !== undefined && rule.action.order_type === 'limit') {
      const basePrice = this.extractBasePrice(signal);
      if (basePrice !== null) {
        const multiplier = 1 + (rule.action.limit_price_offset_bps / 10000);
        command.limit_price = Math.round(basePrice * multiplier * 100) / 100;
      }
    }

    return command;
  }

  private extractBasePrice(signal: Signal): number | null {
    const payload = signal.payload as Record<string, unknown> | null;
    if (payload) {
      for (const field of ['current_price', 'trigger_price', 'price', 'yes_price', 'last_price']) {
        if (payload[field] != null) {
          const val = parseFloat(String(payload[field]));
          if (!isNaN(val)) return val;
        }
      }
    }
    return null;
  }

  private deriveSide(
    rule: StrategyRule,
    signal: Signal,
    venue: string,
  ): string | null {
    const side = rule.action.side;

    if (side !== 'from_signal') {
      return side;
    }

    // Derive from signal direction
    const direction = signal.direction;
    if (!direction || direction === 'neutral' || direction === 'cross') {
      return null;
    }

    const isPrediction = isPredictionVenue(venue);

    if (direction === 'long' || direction === 'above') {
      return isPrediction ? 'yes' : 'buy';
    }

    if (direction === 'short' || direction === 'below') {
      return isPrediction ? 'no' : 'sell';
    }

    return null;
  }

  private pruneProcessedSignals(): void {
    const dedupWindowMs = this.config.risk_limits.signal_dedup_window_seconds * 1000;
    const cutoff = Date.now() - dedupWindowMs;

    for (const [id, timestamp] of this.processedSignalIds) {
      if (timestamp < cutoff) {
        this.processedSignalIds.delete(id);
      }
    }
  }
}
