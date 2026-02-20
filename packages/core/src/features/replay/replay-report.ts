// ============================================================
// ReplayReport - Performance metrics and formatting
// ============================================================

import type { ReplayPosition, ReplayProgress, ReplayConfig } from './replay-engine.js';

export interface ReplayReport {
  config: {
    strategy: string;
    start: string;
    end: string;
    feeRate: number;
    assumedFillPrice: number;
    assumedWinRate: number;
  };
  summary: {
    totalSignals: number;
    signalsMatched: number;
    tradesGenerated: number;
    tradesRejectedByRisk: number;
  };
  pnl: {
    totalRealizedPnl: number;
    totalUnrealizedPnl: number;
    netPnl: number;
    totalFees: number;
  };
  winRate: {
    totalSettled: number;
    wins: number;
    losses: number;
    winRate: number;
  };
  risk: {
    maxDrawdown: number;
    maxSingleTradeLoss: number;
    largestWinningTrade: number;
    sharpeRatio: number | null;
  };
  timing: {
    avgHoldDurationMs: number;
    shortestHoldMs: number;
    longestHoldMs: number;
  };
  byVenue: Record<string, {
    trades: number;
    realizedPnl: number;
    winRate: number;
  }>;
  byRule: Record<string, {
    trades: number;
    realizedPnl: number;
    winRate: number;
    signalsMatched: number;
  }>;
  dataQuality: {
    payloadPricedTrades: number;
    assumedPricedTrades: number;
    exactPriceRate: number;
  };
}

export function generateReport(
  positions: ReplayPosition[],
  progress: ReplayProgress,
  rejectedByRisk: number,
  config: ReplayConfig,
): ReplayReport {
  const settled = positions.filter(p => p.settled && p.pnl != null);
  const unsettled = positions.filter(p => !p.settled);

  const totalRealizedPnl = settled.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
  const totalUnrealizedPnl = unsettled.reduce((sum, p) => {
    if (p.exitPrice != null) return sum + ((p.exitPrice - p.entryPrice) * p.size);
    return sum;
  }, 0);
  const totalFees = settled.reduce((sum, p) => sum + (p.fees ?? 0), 0);

  const wins = settled.filter(p => (p.pnl ?? 0) > 0).length;
  const losses = settled.filter(p => (p.pnl ?? 0) <= 0).length;

  const maxDrawdown = calculateMaxDrawdown(settled);

  const settledPnls = settled.map(p => p.pnl ?? 0);
  const maxSingleTradeLoss = settledPnls.length > 0 ? Math.min(...settledPnls, 0) : 0;
  const largestWinningTrade = settledPnls.length > 0 ? Math.max(...settledPnls, 0) : 0;

  const holdDurations = settled
    .filter(p => p.enteredAt && p.exitedAt)
    .map(p => p.exitedAt!.getTime() - p.enteredAt.getTime());

  const avgHoldDurationMs = holdDurations.length > 0
    ? holdDurations.reduce((a, b) => a + b, 0) / holdDurations.length
    : 0;
  const shortestHoldMs = holdDurations.length > 0 ? Math.min(...holdDurations) : 0;
  const longestHoldMs = holdDurations.length > 0 ? Math.max(...holdDurations) : 0;

  const byVenue = groupByVenue(settled);
  const byRule = groupByRule(settled, progress);

  const payloadPricedTrades = positions.filter(p => p.priceSource === 'payload').length;
  const assumedPricedTrades = positions.filter(p => p.priceSource === 'assumed').length;
  const totalTrades = payloadPricedTrades + assumedPricedTrades;

  return {
    config: {
      strategy: config.strategy.name ?? 'unnamed',
      start: config.consumer.start.toISOString(),
      end: config.consumer.end.toISOString(),
      feeRate: config.feeRate ?? 0.02,
      assumedFillPrice: config.assumedFillPrice ?? 0.50,
      assumedWinRate: config.assumedWinRate ?? 0.50,
    },
    summary: {
      totalSignals: progress.signalsProcessed,
      signalsMatched: progress.signalsMatched,
      tradesGenerated: progress.tradesGenerated,
      tradesRejectedByRisk: rejectedByRisk,
    },
    pnl: {
      totalRealizedPnl,
      totalUnrealizedPnl,
      netPnl: totalRealizedPnl + totalUnrealizedPnl,
      totalFees,
    },
    winRate: {
      totalSettled: settled.length,
      wins,
      losses,
      winRate: settled.length > 0 ? wins / settled.length : 0,
    },
    risk: {
      maxDrawdown,
      maxSingleTradeLoss,
      largestWinningTrade,
      sharpeRatio: calculateSharpeRatio(settled),
    },
    timing: {
      avgHoldDurationMs,
      shortestHoldMs,
      longestHoldMs,
    },
    byVenue,
    byRule,
    dataQuality: {
      payloadPricedTrades,
      assumedPricedTrades,
      exactPriceRate: totalTrades > 0 ? payloadPricedTrades / totalTrades : 0,
    },
  };
}

function calculateMaxDrawdown(settled: ReplayPosition[]): number {
  const sorted = [...settled]
    .filter(p => p.exitedAt != null)
    .sort((a, b) => (a.exitedAt?.getTime() ?? 0) - (b.exitedAt?.getTime() ?? 0));

  let cumPnl = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (const pos of sorted) {
    cumPnl += pos.pnl ?? 0;
    if (cumPnl > peak) peak = cumPnl;
    const drawdown = peak - cumPnl;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return maxDrawdown;
}

function calculateSharpeRatio(settled: ReplayPosition[]): number | null {
  if (settled.length < 2) return null;

  // Group by day
  const dailyPnl = new Map<string, number>();
  for (const pos of settled) {
    if (!pos.exitedAt) continue;
    const day = pos.exitedAt.toISOString().slice(0, 10);
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + (pos.pnl ?? 0));
  }

  const returns = Array.from(dailyPnl.values());
  if (returns.length < 2) return null;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  const stddev = Math.sqrt(variance);

  if (stddev === 0) return null;

  return (mean / stddev) * Math.sqrt(365);
}

function groupByVenue(
  settled: ReplayPosition[],
): Record<string, { trades: number; realizedPnl: number; winRate: number }> {
  const groups = new Map<string, ReplayPosition[]>();
  for (const p of settled) {
    const group = groups.get(p.venue) ?? [];
    group.push(p);
    groups.set(p.venue, group);
  }

  const result: Record<string, { trades: number; realizedPnl: number; winRate: number }> = {};
  for (const [venue, positions] of groups) {
    const wins = positions.filter(p => (p.pnl ?? 0) > 0).length;
    result[venue] = {
      trades: positions.length,
      realizedPnl: positions.reduce((sum, p) => sum + (p.pnl ?? 0), 0),
      winRate: positions.length > 0 ? wins / positions.length : 0,
    };
  }
  return result;
}

function groupByRule(
  settled: ReplayPosition[],
  _progress: ReplayProgress,
): Record<string, { trades: number; realizedPnl: number; winRate: number; signalsMatched: number }> {
  const groups = new Map<string, ReplayPosition[]>();
  for (const p of settled) {
    const group = groups.get(p.ruleName) ?? [];
    group.push(p);
    groups.set(p.ruleName, group);
  }

  const result: Record<string, { trades: number; realizedPnl: number; winRate: number; signalsMatched: number }> = {};
  for (const [rule, positions] of groups) {
    const wins = positions.filter(p => (p.pnl ?? 0) > 0).length;
    const uniqueSignals = new Set(positions.map(p => p.signalId)).size;
    result[rule] = {
      trades: positions.length,
      realizedPnl: positions.reduce((sum, p) => sum + (p.pnl ?? 0), 0),
      winRate: positions.length > 0 ? wins / positions.length : 0,
      signalsMatched: uniqueSignals,
    };
  }
  return result;
}

export function formatReportTable(report: ReplayReport): string {
  const lines: string[] = [];

  lines.push('Signal Replay Report');
  lines.push('====================================================');
  lines.push(`Strategy:    ${report.config.strategy}`);
  lines.push(`Period:      ${report.config.start.slice(0, 10)} to ${report.config.end.slice(0, 10)}`);
  lines.push(`Fee rate:    ${(report.config.feeRate * 100).toFixed(1)}% per leg`);
  lines.push('');
  lines.push('Summary');
  lines.push('----------------------------------------------------');
  lines.push(`Total signals:      ${report.summary.totalSignals.toLocaleString()}`);
  lines.push(`Signals matched:    ${report.summary.signalsMatched.toLocaleString()}`);
  lines.push(`Trades generated:   ${report.summary.tradesGenerated.toLocaleString()}`);
  lines.push(`Rejected by risk:   ${report.summary.tradesRejectedByRisk.toLocaleString()}`);
  lines.push('');
  lines.push('P&L');
  lines.push('----------------------------------------------------');
  lines.push(`Realized P&L:       ${formatDollar(report.pnl.totalRealizedPnl)}`);
  lines.push(`Unrealized P&L:     ${formatDollar(report.pnl.totalUnrealizedPnl)}`);
  lines.push(`Net P&L:            ${formatDollar(report.pnl.netPnl)}`);
  lines.push(`Total fees:         ${formatDollar(report.pnl.totalFees)}`);
  lines.push('');
  lines.push('Performance');
  lines.push('----------------------------------------------------');
  lines.push(`Win rate:           ${(report.winRate.winRate * 100).toFixed(1)}% (${report.winRate.wins}/${report.winRate.totalSettled})`);
  lines.push(`Max drawdown:       ${formatDollar(-report.risk.maxDrawdown)}`);
  lines.push(`Largest win:        ${formatDollar(report.risk.largestWinningTrade)}`);
  lines.push(`Largest loss:       ${formatDollar(report.risk.maxSingleTradeLoss)}`);
  lines.push(`Sharpe ratio:       ${report.risk.sharpeRatio != null ? report.risk.sharpeRatio.toFixed(2) : 'N/A'}`);
  lines.push('');
  lines.push('Timing');
  lines.push('----------------------------------------------------');
  lines.push(`Avg hold:           ${formatDuration(report.timing.avgHoldDurationMs)}`);
  lines.push(`Shortest:           ${formatDuration(report.timing.shortestHoldMs)}`);
  lines.push(`Longest:            ${formatDuration(report.timing.longestHoldMs)}`);
  lines.push('');
  lines.push('By Venue');
  lines.push('----------------------------------------------------');
  for (const [venue, data] of Object.entries(report.byVenue)) {
    lines.push(`${venue.padEnd(20)} ${data.trades} trades, ${formatDollar(data.realizedPnl)}, ${(data.winRate * 100).toFixed(0)}% win`);
  }
  lines.push('');
  lines.push('By Rule');
  lines.push('----------------------------------------------------');
  for (const [rule, data] of Object.entries(report.byRule)) {
    lines.push(`${rule.padEnd(20)} ${data.trades} trades, ${formatDollar(data.realizedPnl)}, ${(data.winRate * 100).toFixed(0)}% win`);
  }
  lines.push('');
  lines.push('Data Quality');
  lines.push('----------------------------------------------------');
  const total = report.dataQuality.payloadPricedTrades + report.dataQuality.assumedPricedTrades;
  lines.push(`Payload-priced:     ${report.dataQuality.payloadPricedTrades}/${total} (${(report.dataQuality.exactPriceRate * 100).toFixed(1)}%)`);
  lines.push(`Assumed-priced:     ${report.dataQuality.assumedPricedTrades}/${total} (${((1 - report.dataQuality.exactPriceRate) * 100).toFixed(1)}%)`);
  lines.push('====================================================');

  return lines.join('\n');
}

function formatDollar(amount: number): string {
  const sign = amount >= 0 ? '+' : '';
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
}
