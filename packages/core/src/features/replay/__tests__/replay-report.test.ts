import { describe, it, expect, vi } from 'vitest';
import { generateReport, formatReportTable, type ReplayReport } from '../replay-report.js';
import type { ReplayPosition, ReplayProgress, ReplayConfig } from '../replay-engine.js';

// Silence pino logger
vi.mock('pino', () => {
  const noop = () => {};
  const logger: Record<string, unknown> = {
    info: noop, warn: noop, error: noop, debug: noop, trace: noop,
    child: () => logger,
  };
  return { default: () => logger };
});

function makeConfig(): ReplayConfig {
  return {
    strategy: { name: 'test-strategy', enabled: true, dry_run: true, rules: [], market_mappings: {}, risk_limits: { max_trades_per_minute: 5, market_cooldown_seconds: 30, signal_dedup_window_seconds: 300 } },
    consumer: {
      apiUrl: 'https://api.pumpamp.com',
      apiKey: 'test',
      start: new Date('2026-01-01T00:00:00Z'),
      end: new Date('2026-02-01T00:00:00Z'),
    },
    feeRate: 0.02,
    assumedFillPrice: 0.50,
    assumedWinRate: 0.50,
  };
}

function makeProgress(overrides: Partial<ReplayProgress> = {}): ReplayProgress {
  return {
    signalsProcessed: 100,
    signalsMatched: 50,
    tradesGenerated: 30,
    currentDate: '2026-01-31T00:00:00Z',
    pagesCompleted: 5,
    ...overrides,
  };
}

function makePosition(overrides: Partial<ReplayPosition> = {}): ReplayPosition {
  return {
    id: 'pos-0',
    ruleName: 'test-rule',
    signalId: 'sig-001',
    signalName: 'test_signal',
    venue: 'kalshi',
    marketId: 'kalshi:TEST',
    side: 'buy',
    entryPrice: 0.50,
    size: 10,
    enteredAt: new Date('2026-01-15T10:00:00Z'),
    priceSource: 'payload',
    settled: true,
    exitPrice: 0.70,
    exitedAt: new Date('2026-01-15T12:00:00Z'),
    pnl: 2.00,
    fees: 0.10,
    ...overrides,
  };
}

describe('Win rate calculation', () => {
  it('calculates 60% win rate from 6 wins and 4 losses', () => {
    const positions: ReplayPosition[] = [];
    // 6 winning trades
    for (let i = 0; i < 6; i++) {
      positions.push(makePosition({ id: `win-${i}`, pnl: 10, exitedAt: new Date(`2026-01-${15 + i}T12:00:00Z`) }));
    }
    // 4 losing trades
    for (let i = 0; i < 4; i++) {
      positions.push(makePosition({ id: `loss-${i}`, pnl: -5, exitedAt: new Date(`2026-01-${22 + i}T12:00:00Z`) }));
    }

    const report = generateReport(positions, makeProgress(), 0, makeConfig());

    expect(report.winRate.winRate).toBeCloseTo(0.60);
    expect(report.winRate.wins).toBe(6);
    expect(report.winRate.losses).toBe(4);
    expect(report.winRate.totalSettled).toBe(10);
  });
});

describe('Max drawdown calculation', () => {
  it('calculates correct max drawdown from P&L sequence', () => {
    // P&L sequence: [+100, +50, -200, +30, -10]
    // Cumulative:   [100, 150, -50, -20, -30]
    // Peak = 150, lowest after peak = -50, drawdown = 200
    const positions = [
      makePosition({ id: 'p1', pnl: 100, exitedAt: new Date('2026-01-10T10:00:00Z') }),
      makePosition({ id: 'p2', pnl: 50, exitedAt: new Date('2026-01-11T10:00:00Z') }),
      makePosition({ id: 'p3', pnl: -200, exitedAt: new Date('2026-01-12T10:00:00Z') }),
      makePosition({ id: 'p4', pnl: 30, exitedAt: new Date('2026-01-13T10:00:00Z') }),
      makePosition({ id: 'p5', pnl: -10, exitedAt: new Date('2026-01-14T10:00:00Z') }),
    ];

    const report = generateReport(positions, makeProgress(), 0, makeConfig());

    expect(report.risk.maxDrawdown).toBe(200);
  });
});

describe('Sharpe ratio calculation', () => {
  it('calculates Sharpe ratio from daily P&L values', () => {
    // 5 positions settled across 5 different days
    const positions = [
      makePosition({ id: 'p1', pnl: 10, exitedAt: new Date('2026-01-10T10:00:00Z') }),
      makePosition({ id: 'p2', pnl: 15, exitedAt: new Date('2026-01-11T10:00:00Z') }),
      makePosition({ id: 'p3', pnl: -5, exitedAt: new Date('2026-01-12T10:00:00Z') }),
      makePosition({ id: 'p4', pnl: 20, exitedAt: new Date('2026-01-13T10:00:00Z') }),
      makePosition({ id: 'p5', pnl: 8, exitedAt: new Date('2026-01-14T10:00:00Z') }),
    ];

    const report = generateReport(positions, makeProgress(), 0, makeConfig());

    // Daily returns: [10, 15, -5, 20, 8]
    // Mean = (10+15-5+20+8)/5 = 9.6
    // Variance = ((10-9.6)^2 + (15-9.6)^2 + (-5-9.6)^2 + (20-9.6)^2 + (8-9.6)^2) / 4
    // = (0.16 + 29.16 + 213.16 + 108.16 + 2.56) / 4 = 353.2 / 4 = 88.3
    // Stddev = sqrt(88.3) = 9.397
    // Sharpe = (9.6 / 9.397) * sqrt(365) = 1.0216 * 19.105 = 19.52
    expect(report.risk.sharpeRatio).not.toBeNull();
    expect(report.risk.sharpeRatio!).toBeCloseTo(19.52, 0);
  });
});

describe('By-venue breakdown correct', () => {
  it('groups positions by venue with correct P&L and win rates', () => {
    const positions = [
      makePosition({ id: 'k1', venue: 'kalshi', pnl: 10, exitedAt: new Date('2026-01-10T10:00:00Z') }),
      makePosition({ id: 'k2', venue: 'kalshi', pnl: 20, exitedAt: new Date('2026-01-11T10:00:00Z') }),
      makePosition({ id: 'k3', venue: 'kalshi', pnl: -5, exitedAt: new Date('2026-01-12T10:00:00Z') }),
      makePosition({ id: 'p1', venue: 'polymarket', pnl: 15, exitedAt: new Date('2026-01-13T10:00:00Z') }),
      makePosition({ id: 'p2', venue: 'polymarket', pnl: -8, exitedAt: new Date('2026-01-14T10:00:00Z') }),
    ];

    const report = generateReport(positions, makeProgress(), 0, makeConfig());

    expect(report.byVenue.kalshi).toEqual({
      trades: 3,
      realizedPnl: 25,
      winRate: expect.closeTo(0.667, 2),
    });
    expect(report.byVenue.polymarket).toEqual({
      trades: 2,
      realizedPnl: 7,
      winRate: 0.5,
    });
  });
});

describe('By-rule breakdown correct', () => {
  it('groups positions by rule with correct stats', () => {
    const positions = [
      makePosition({ id: 'a1', ruleName: 'cross_venue_arb', pnl: 30, signalId: 's1', exitedAt: new Date('2026-01-10T10:00:00Z') }),
      makePosition({ id: 'a2', ruleName: 'cross_venue_arb', pnl: 20, signalId: 's2', exitedAt: new Date('2026-01-11T10:00:00Z') }),
      makePosition({ id: 'a3', ruleName: 'cross_venue_arb', pnl: -10, signalId: 's3', exitedAt: new Date('2026-01-12T10:00:00Z') }),
      makePosition({ id: 'a4', ruleName: 'cross_venue_arb', pnl: 10, signalId: 's4', exitedAt: new Date('2026-01-13T10:00:00Z') }),
      makePosition({ id: 'b1', ruleName: 'sharp_line', pnl: 8, signalId: 's5', exitedAt: new Date('2026-01-14T10:00:00Z') }),
      makePosition({ id: 'b2', ruleName: 'sharp_line', pnl: 2, signalId: 's6', exitedAt: new Date('2026-01-15T10:00:00Z') }),
    ];

    const report = generateReport(positions, makeProgress(), 0, makeConfig());

    expect(report.byRule.cross_venue_arb.trades).toBe(4);
    expect(report.byRule.cross_venue_arb.realizedPnl).toBe(50);
    expect(report.byRule.cross_venue_arb.winRate).toBe(0.75);
    expect(report.byRule.sharp_line.trades).toBe(2);
    expect(report.byRule.sharp_line.realizedPnl).toBe(10);
    expect(report.byRule.sharp_line.winRate).toBe(1.0);
  });
});

describe('Data quality tracks price sources', () => {
  it('counts payload-priced and assumed-priced trades correctly', () => {
    const positions = [
      makePosition({ id: 'p1', priceSource: 'payload' }),
      makePosition({ id: 'p2', priceSource: 'payload' }),
      makePosition({ id: 'p3', priceSource: 'payload' }),
      makePosition({ id: 'p4', priceSource: 'payload' }),
      makePosition({ id: 'p5', priceSource: 'payload' }),
      makePosition({ id: 'p6', priceSource: 'assumed' }),
      makePosition({ id: 'p7', priceSource: 'assumed' }),
    ];

    const report = generateReport(positions, makeProgress(), 0, makeConfig());

    expect(report.dataQuality.payloadPricedTrades).toBe(5);
    expect(report.dataQuality.assumedPricedTrades).toBe(2);
    expect(report.dataQuality.exactPriceRate).toBeCloseTo(5 / 7, 3);
  });
});

describe('formatReportTable produces valid output', () => {
  it('output contains all required sections with proper formatting', () => {
    const positions = [
      makePosition({ id: 'p1', pnl: 100, fees: 5, venue: 'kalshi', ruleName: 'arb' }),
    ];

    const report = generateReport(positions, makeProgress(), 2, makeConfig());
    const output = formatReportTable(report);

    expect(output).toContain('Summary');
    expect(output).toContain('P&L');
    expect(output).toContain('Performance');
    expect(output).toContain('Timing');
    expect(output).toContain('By Venue');
    expect(output).toContain('By Rule');
    expect(output).toContain('Data Quality');
    expect(output).toContain('$');
    expect(output).toContain('%');
  });
});

describe('JSON output matches ReplayReport interface', () => {
  it('all top-level fields present and numeric fields are numbers', () => {
    const positions = [makePosition()];
    const report = generateReport(positions, makeProgress(), 0, makeConfig());

    const json = JSON.stringify(report);
    const parsed = JSON.parse(json) as ReplayReport;

    expect(parsed.config).toBeDefined();
    expect(parsed.summary).toBeDefined();
    expect(parsed.pnl).toBeDefined();
    expect(parsed.winRate).toBeDefined();
    expect(parsed.risk).toBeDefined();
    expect(parsed.timing).toBeDefined();
    expect(parsed.byVenue).toBeDefined();
    expect(parsed.byRule).toBeDefined();
    expect(parsed.dataQuality).toBeDefined();

    expect(typeof parsed.pnl.netPnl).toBe('number');
    expect(typeof parsed.winRate.winRate).toBe('number');
    expect(typeof parsed.risk.maxDrawdown).toBe('number');
  });
});

describe('Empty replay produces valid report', () => {
  it('generates valid report with zeros for empty replay', () => {
    const report = generateReport(
      [],
      { signalsProcessed: 0, signalsMatched: 0, tradesGenerated: 0, currentDate: '', pagesCompleted: 0 },
      0,
      makeConfig(),
    );

    expect(report.summary.totalSignals).toBe(0);
    expect(report.pnl.netPnl).toBe(0);
    expect(report.winRate.winRate).toBe(0);
    expect(report.risk.sharpeRatio).toBeNull();
    expect(report.byVenue).toEqual({});
    expect(report.byRule).toEqual({});
    expect(report.dataQuality.payloadPricedTrades).toBe(0);
    expect(report.dataQuality.assumedPricedTrades).toBe(0);
  });
});
