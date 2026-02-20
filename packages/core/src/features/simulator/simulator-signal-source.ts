import { EventEmitter } from 'events';
import type { Signal, SignalType, SignalDirection, AlertSeverity } from '../signals/signal-consumer.js';
import type { StrategyConfig, StrategyRule } from '../strategy/strategy-config.js';

export interface SimulatorSignalSourceConfig {
  intervalSec: number;
  count: number; // 0 = infinite
  strategy: StrategyConfig;
}

export class SimulatorSignalSource extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private emitted = 0;
  private ruleIndex = 0;

  constructor(private readonly cfg: SimulatorSignalSourceConfig) {
    super();
  }

  start(): void {
    const intervalMs = Math.max(1, this.cfg.intervalSec) * 1000;
    this.timer = setInterval(() => {
      if (this.cfg.count > 0 && this.emitted >= this.cfg.count) {
        this.stop();
        this.emit('stopped');
        return;
      }
      const signal = this.generateSignal();
      this.emitted += 1;
      this.emit('signal', signal);
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private generateSignal(): Signal {
    const enabledRules = this.cfg.strategy.rules.filter((r) => r.enabled);
    const rule = enabledRules[this.ruleIndex % enabledRules.length] ?? this.cfg.strategy.rules[0];
    this.ruleIndex += 1;

    const venue = this.pickVenue(rule);
    const { base, quote, marketId } = this.pickMarket(rule, venue);
    const direction = this.pickDirection(rule);

    return {
      id: `sim-${Date.now()}-${this.emitted}`,
      signal_type: (rule?.signal_types?.[0] ?? 'strategy') as SignalType,
      signal_name: rule?.signal_names?.[0] ?? `Simulated-${rule?.name ?? 'Rule'}`,
      market_id: marketId,
      venue,
      base_currency: base,
      quote_currency: quote,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      direction,
      confidence: String(Math.max(rule?.min_confidence ?? 0, 85)),
      severity: (rule?.min_severity ?? 'High') as AlertSeverity,
      description: `Synthetic strategy simulation signal for rule ${rule?.name ?? 'unknown'}`,
      payload: {
        simulator: {
          rule_name: rule?.name ?? 'unknown',
        },
      },
    };
  }

  private pickVenue(rule: StrategyRule | undefined): string {
    return rule?.venues?.[0] ?? 'binance';
  }

  private pickDirection(rule: StrategyRule | undefined): SignalDirection {
    const allowed = (rule?.directions ?? ['long', 'short']).filter((d) =>
      d === 'long' || d === 'short' || d === 'above' || d === 'below'
    ) as SignalDirection[];

    if (allowed.length === 0) return 'long';
    return allowed[Math.floor(Math.random() * allowed.length)];
  }

  private pickMarket(
    rule: StrategyRule | undefined,
    venue: string,
  ): { base: string; quote: string; marketId: string } {
    const symbol = rule?.symbols?.[0];
    if (symbol && symbol.includes('/')) {
      const [base, quote] = symbol.split('/');
      if (venue === 'kalshi') {
        return { base, quote: 'YES', marketId: `${venue}:${base}-${quote}/YES` };
      }
      return { base, quote, marketId: `${venue}:${base}/${quote}` };
    }

    if (venue === 'kalshi') {
      return { base: 'BTC', quote: 'YES', marketId: 'kalshi:BTC-100K/YES' };
    }

    return { base: 'BTC', quote: 'USDT', marketId: `${venue}:BTC/USDT` };
  }
}
