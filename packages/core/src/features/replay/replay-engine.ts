// ============================================================
// ReplayEngine - Core replay orchestrator
//
// Feeds historical signals through a StrategyEngine, tracks
// hypothetical positions, and generates performance reports.
// ============================================================

import { StrategyEngine } from '../strategy/strategy-engine.js';
import type { StrategyConfig } from '../strategy/strategy-config.js';
import { ReplayConsumer, type ReplayConsumerConfig } from './replay-consumer.js';
import type { Signal } from '../signals/signal-consumer.js';
import type { TradeCommand } from '../../shared/protocol.js';
import { generateReport, type ReplayReport } from './replay-report.js';

export interface ReplayConfig {
  strategy: StrategyConfig;
  consumer: ReplayConsumerConfig;
  feeRate?: number;
  assumedFillPrice?: number;
  assumedWinRate?: number;
  speed?: 'fast' | 'normal' | 'verbose';
  onProgress?: (progress: ReplayProgress) => void;
}

export interface ReplayProgress {
  signalsProcessed: number;
  signalsMatched: number;
  tradesGenerated: number;
  currentDate: string;
  pagesCompleted: number;
}

export interface ReplayPosition {
  id: string;
  ruleName: string;
  signalId: string;
  signalName: string;
  venue: string;
  marketId: string;
  side: 'buy' | 'sell';
  entryPrice: number;
  size: number;
  enteredAt: Date;
  linkedPositionId?: string;
  priceSource: 'payload' | 'assumed';
  exitPrice?: number;
  exitedAt?: Date;
  settled: boolean;
  pnl?: number;
  fees?: number;
  expiresAt?: Date;
}

export class ReplayEngine {
  private config: ReplayConfig;
  private positions: ReplayPosition[] = [];
  private rejectedByRisk = 0;
  private progress: ReplayProgress = {
    signalsProcessed: 0,
    signalsMatched: 0,
    tradesGenerated: 0,
    currentDate: '',
    pagesCompleted: 0,
  };

  constructor(config: ReplayConfig) {
    this.config = config;
  }

  private createStrategyEngine(): StrategyEngine {
    // Override risk limits for replay: disable dedup and rate limiting
    // since we're processing historical signals, not live ones.
    const replayConfig: StrategyConfig = {
      ...this.config.strategy,
      enabled: true,
      dry_run: false,
      risk_limits: {
        ...this.config.strategy.risk_limits,
        signal_dedup_window_seconds: 0,
        market_cooldown_seconds: 0,
        max_trades_per_minute: 999999,
      },
    };
    return new StrategyEngine(replayConfig, () => []);
  }

  async run(): Promise<ReplayReport> {
    const engine = this.createStrategyEngine();
    const consumer = new ReplayConsumer(this.config.consumer);
    const feeRate = this.config.feeRate ?? 0.02;

    for await (const page of consumer.fetchSignals()) {
      for (const signal of page) {
        this.processSignal(engine, signal, feeRate);
      }

      this.progress.pagesCompleted++;
      if (this.config.onProgress && this.config.speed !== 'fast') {
        this.config.onProgress({ ...this.progress });
      }
    }

    this.settleExpiredPositions();

    return generateReport(
      this.positions,
      this.progress,
      this.rejectedByRisk,
      this.config,
    );
  }

  async runWithCachedSignals(signals: Signal[]): Promise<ReplayReport> {
    const engine = this.createStrategyEngine();
    const feeRate = this.config.feeRate ?? 0.02;

    for (const signal of signals) {
      this.processSignal(engine, signal, feeRate);
    }
    this.progress.pagesCompleted = 1;

    this.settleExpiredPositions();

    return generateReport(
      this.positions,
      this.progress,
      this.rejectedByRisk,
      this.config,
    );
  }

  private processSignal(engine: StrategyEngine, signal: Signal, feeRate: number): void {
    this.progress.signalsProcessed++;
    this.progress.currentDate = signal.triggered_at || signal.created_at;

    const raw = engine.handleSignal(signal);
    const commands: TradeCommand[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (commands.length === 0) return;

    this.progress.signalsMatched++;

    for (const cmd of commands) {
      this.processCommand(cmd, signal, feeRate);
    }
  }

  private processCommand(cmd: TradeCommand, signal: Signal, feeRate: number): void {
    const payload = signal.payload as Record<string, unknown> | null;
    const isArb = signal.signal_name === 'cross_venue_arbitrage' && payload;

    if (isArb) {
      this.processArbCommand(cmd, signal, payload as Record<string, unknown>, feeRate);
    } else {
      this.processNonArbCommand(cmd, signal, feeRate);
    }
  }

  private processArbCommand(
    cmd: TradeCommand,
    signal: Signal,
    payload: Record<string, unknown>,
    feeRate: number,
  ): void {
    const buyPrice = parseFloat(String(payload.buy_price ?? '0'));
    const sellPrice = parseFloat(String(payload.sell_price ?? '0'));

    const isBuyLeg = cmd.side === 'buy';
    const entryPrice = isBuyLeg ? buyPrice : sellPrice;
    const exitPrice = isBuyLeg ? sellPrice : buyPrice;

    const grossPnl = isBuyLeg
      ? (exitPrice - entryPrice) * cmd.size
      : (entryPrice - exitPrice) * cmd.size;
    const fees = entryPrice * cmd.size * feeRate + exitPrice * cmd.size * feeRate;
    const netPnl = grossPnl - fees;

    const posId = `pos-${this.positions.length}`;
    const linkedId = isBuyLeg ? `pos-${this.positions.length + 1}` : `pos-${this.positions.length - 1}`;

    this.positions.push({
      id: posId,
      ruleName: cmd.id.split('-').slice(2, -1).join('-') || 'arb',
      signalId: signal.id,
      signalName: signal.signal_name,
      venue: cmd.venue,
      marketId: cmd.market_id,
      side: cmd.side as 'buy' | 'sell',
      entryPrice,
      size: cmd.size,
      enteredAt: new Date(signal.triggered_at || signal.created_at),
      linkedPositionId: linkedId,
      priceSource: 'payload',
      exitPrice,
      exitedAt: new Date(signal.triggered_at || signal.created_at),
      settled: true,
      pnl: netPnl,
      fees,
    });

    this.progress.tradesGenerated++;
  }

  private processNonArbCommand(cmd: TradeCommand, signal: Signal, _feeRate: number): void {
    const { price, source } = this.extractPrice(signal);

    const expiresAt = signal.expires_at ? new Date(signal.expires_at) : undefined;

    this.positions.push({
      id: `pos-${this.positions.length}`,
      ruleName: cmd.id.split('-').slice(2).join('-') || 'default',
      signalId: signal.id,
      signalName: signal.signal_name,
      venue: cmd.venue,
      marketId: cmd.market_id,
      side: cmd.side as 'buy' | 'sell',
      entryPrice: price,
      size: cmd.size,
      enteredAt: new Date(signal.triggered_at || signal.created_at),
      priceSource: source,
      settled: false,
      expiresAt,
    });

    this.progress.tradesGenerated++;
  }

  private extractPrice(signal: Signal): { price: number; source: 'payload' | 'assumed' } {
    const payload = signal.payload as Record<string, unknown> | null;

    if (payload) {
      for (const field of ['current_price', 'trigger_price', 'price', 'yes_price', 'last_price']) {
        if (payload[field] != null) {
          const val = parseFloat(String(payload[field]));
          if (!isNaN(val)) return { price: val, source: 'payload' };
        }
      }
    }

    return { price: this.config.assumedFillPrice ?? 0.50, source: 'assumed' };
  }

  private settleExpiredPositions(): void {
    const assumedWinRate = this.config.assumedWinRate ?? 0.50;
    const replayEnd = this.config.consumer.end;

    for (const pos of this.positions) {
      if (pos.settled) continue;
      if (!pos.expiresAt || pos.expiresAt > replayEnd) continue;

      // Deterministic expected value settlement
      // For binary contracts settling to $0 or $1:
      //   expectedExitPrice = assumedWinRate (for buy side)
      //   expectedExitPrice = 1 - assumedWinRate (for sell side)
      const expectedExitPrice = pos.side === 'buy' ? assumedWinRate : (1 - assumedWinRate);

      const pnl = pos.side === 'buy'
        ? (expectedExitPrice - pos.entryPrice) * pos.size
        : (pos.entryPrice - expectedExitPrice) * pos.size;

      pos.exitPrice = expectedExitPrice;
      pos.exitedAt = pos.expiresAt;
      pos.settled = true;
      pos.pnl = pnl;
    }
  }

  static async compare(
    strategies: { name: string; config: StrategyConfig }[],
    consumerConfig: ReplayConsumerConfig,
    replayDefaults: Partial<ReplayConfig>,
  ): Promise<{ name: string; report: ReplayReport }[]> {
    const consumer = new ReplayConsumer(consumerConfig);
    const allSignals: Signal[] = [];
    for await (const page of consumer.fetchSignals()) {
      allSignals.push(...page);
    }

    const results: { name: string; report: ReplayReport }[] = [];
    for (const { name, config } of strategies) {
      const engine = new ReplayEngine({
        ...replayDefaults as ReplayConfig,
        strategy: config,
        consumer: consumerConfig,
      });
      const report = await engine.runWithCachedSignals(allSignals);
      results.push({ name, report });
    }

    return results;
  }
}
