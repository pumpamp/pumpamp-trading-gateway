#!/usr/bin/env node
// ============================================================
// CLI: Commander-based CLI for the PumpAmp Trading Gateway
// Commands: start, pair, status, venues
// ============================================================

import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './shared/config.js';
import { Gateway } from './gateway.js';
import { loadStrategyConfig, type StrategyConfig } from './features/strategy/strategy-config.js';
import { StrategyEngine } from './features/strategy/strategy-engine.js';
import { SimulatorSignalSource } from './features/simulator/simulator-signal-source.js';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { strategyConfigSchema } from './features/strategy/strategy-config.js';
import { ReplayEngine, type ReplayConfig } from './features/replay/replay-engine.js';
import { formatReportTable } from './features/replay/replay-report.js';
import {
  SimulatorVenueConnector,
  SimulatorRelay,
  formatFill,
  formatReject,
} from './features/simulator/simulator.js';

const program = new Command();

program
  .name('pumpamp-gateway')
  .description('PumpAmp Trading Gateway - Execute trades on your exchange accounts from PumpAmp signals')
  .version('0.1.0');

// --- start command ---
program
  .command('start')
  .description('Start the gateway with configured venues')
  .option('--cancel-on-shutdown', 'Cancel pending orders on shutdown', false)
  .option('--simulate-orders', 'Simulate order execution (no real orders sent to venues)', false)
  .action(async (options) => {
    try {
      const config = loadConfig();

      if (!config.pumpampPairingId) {
        console.error('Error: No pairing ID configured. Run "pumpamp-gateway pair <code>" first.');
        process.exit(1);
      }

      if (options.cancelOnShutdown) {
        (config as any).cancelOnShutdown = true;
      }

      if (options.simulateOrders) {
        config.simulateOrders = true;
      }

      const gateway = new Gateway(config);

      gateway.on('stopped', () => {
        process.exit(0);
      });

      // Log simulated order fills/rejects to console
      if (config.simulateOrders) {
        gateway.on('order_update', (report) => {
          if (report.status === 'filled') {
            console.log(`[SIMULATE] FILL  ${report.market_id}  ${report.side}/${report.action}  ${report.size}  @ $${report.fill_price ?? '?'}  order=${report.order_id}`);
          } else if (report.status === 'rejected') {
            console.log(`[SIMULATE] REJ   ${report.market_id}  ${report.side}/${report.action}  ${report.size}`);
          } else {
            console.log(`[SIMULATE] ${report.status.toUpperCase()}  ${report.market_id}  order=${report.order_id}`);
          }
        });

        gateway.on('order_error', (report) => {
          console.log(`[SIMULATE] ERR   ${report.code}: ${report.message}`);
        });
      }

      await gateway.start();

      const status = gateway.getStatus();
      if (config.simulateOrders) {
        console.log('[SIMULATE] Order simulation mode active - no real orders will be sent');
        console.log(`[SIMULATE] Simulated venues: ${Object.keys(status.venues).join(', ')}`);
      }
      console.log(`Gateway started. Connected venues: ${Object.keys(status.venues).join(', ') || 'none'}`);
      console.log(`Relay: ${status.relayConnected ? 'connected' : 'connecting...'}`);
      console.log('Press Ctrl+C to stop.');
    } catch (error) {
      console.error(`Failed to start gateway: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// --- pair command ---
program
  .command('pair <code>')
  .description('Pair with PumpAmp using a 6-character pairing code')
  .action(async (code: string) => {
    try {
      // Validate code format
      if (!/^[A-Z0-9]{6}$/.test(code.toUpperCase())) {
        console.error('Error: Pairing code must be 6 alphanumeric characters (e.g., X7K9M2)');
        process.exit(1);
      }

      const config = loadConfig();
      const gateway = new Gateway(config);

      console.log(`Pairing with code: ${code.toUpperCase()}...`);

      const pairingId = await gateway.pair(code.toUpperCase());

      console.log(`Pairing successful! Pairing ID: ${pairingId}`);

      // Write pairing ID to .env file
      const envPath = resolve(process.cwd(), '.env');
      try {
        if (existsSync(envPath)) {
          let envContent = readFileSync(envPath, 'utf8');
          if (envContent.includes('PUMPAMP_PAIRING_ID=')) {
            envContent = envContent.replace(
              /^PUMPAMP_PAIRING_ID=.*$/m,
              `PUMPAMP_PAIRING_ID=${pairingId}`
            );
          } else {
            envContent += `\nPUMPAMP_PAIRING_ID=${pairingId}\n`;
          }
          writeFileSync(envPath, envContent);
        } else {
          writeFileSync(envPath, `PUMPAMP_PAIRING_ID=${pairingId}\n`);
        }
        console.log(`Saved pairing ID to ${envPath}`);
      } catch (writeError) {
        console.warn(`Could not write to .env: ${(writeError as Error).message}`);
        console.log('Add this to your .env file manually:');
        console.log(`  PUMPAMP_PAIRING_ID=${pairingId}`);
      }
    } catch (error) {
      console.error(`Pairing failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// --- api-key command ---
program
  .command('api-key <key>')
  .description('Save your PumpAmp API key to .env (get one from the PumpAmp dashboard)')
  .action((key: string) => {
    // Validate format
    if (!key.startsWith('pa_live_') || key.length < 16) {
      console.error('Error: API key must start with "pa_live_" (get one from your PumpAmp dashboard > Settings > API Keys)');
      process.exit(1);
    }

    const envPath = resolve(process.cwd(), '.env');
    try {
      if (existsSync(envPath)) {
        let envContent = readFileSync(envPath, 'utf8');
        if (envContent.includes('PUMPAMP_API_KEY=')) {
          envContent = envContent.replace(
            /^PUMPAMP_API_KEY=.*$/m,
            `PUMPAMP_API_KEY=${key}`
          );
        } else {
          envContent += `\nPUMPAMP_API_KEY=${key}\n`;
        }
        writeFileSync(envPath, envContent);
      } else {
        writeFileSync(envPath, `PUMPAMP_API_KEY=${key}\n`);
      }
      console.log(`API key saved to ${envPath}`);
      console.log(`Key: ${key.slice(0, 12)}...${key.slice(-4)}`);
    } catch (err) {
      console.error(`Could not write to .env: ${(err as Error).message}`);
      console.log('Add this to your .env file manually:');
      console.log(`  PUMPAMP_API_KEY=${key}`);
      process.exit(1);
    }
  });

// --- status command ---
program
  .command('status')
  .description('Show gateway configuration and connection status')
  .action(() => {
    try {
      const config = loadConfig();

      console.log('PumpAmp Trading Gateway - Status');
      console.log('================================');
      console.log(`Host: ${config.pumpampHost}`);
      console.log(`API Key: ${config.pumpampApiKey.slice(0, 12)}...${config.pumpampApiKey.slice(-4)}`);
      console.log(`Pairing ID: ${config.pumpampPairingId || 'Not configured (run "pair" first)'}`);
      console.log('');
      console.log('Configured Venues:');

      if (config.kalshi) {
        console.log(`  - Kalshi: API key ${config.kalshi.apiKey.slice(0, 8)}...`);
      }
      if (config.polymarket) {
        console.log(`  - Polymarket: wallet configured`);
      }
      if (config.hyperliquid) {
        console.log(`  - Hyperliquid: wallet configured`);
      }
      if (config.binance) {
        console.log(`  - Binance: API key ${config.binance.apiKey.slice(0, 8)}... (${config.binance.futures ? 'futures' : 'spot'})`);
      }

      if (!config.kalshi && !config.polymarket && !config.hyperliquid && !config.binance) {
        console.log('  No venues configured. Add credentials to .env file.');
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// --- venues command ---
program
  .command('venues')
  .description('List all supported venues and their configuration status')
  .action(() => {
    try {
      const config = loadConfig();

      console.log('Supported Venues:');
      console.log('=================');

      const venues = [
        {
          name: 'Kalshi',
          configured: !!config.kalshi,
          envVars: ['KALSHI_API_KEY', 'KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_PATH'],
        },
        {
          name: 'Polymarket',
          configured: !!config.polymarket,
          envVars: ['POLYMARKET_PRIVATE_KEY', 'POLYMARKET_API_KEY', 'POLYMARKET_API_SECRET', 'POLYMARKET_API_PASSPHRASE'],
        },
        {
          name: 'Hyperliquid',
          configured: !!config.hyperliquid,
          envVars: ['HYPERLIQUID_PRIVATE_KEY'],
        },
        {
          name: 'Binance',
          configured: !!config.binance,
          envVars: ['BINANCE_API_KEY', 'BINANCE_API_SECRET'],
        },
      ];

      for (const venue of venues) {
        const status = venue.configured ? '[CONFIGURED]' : '[NOT CONFIGURED]';
        console.log(`\n  ${venue.name} ${status}`);
        if (!venue.configured) {
          console.log(`    Required env vars: ${venue.envVars.join(', ')}`);
        }
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// --- simulate command ---
program
  .command('simulate')
  .description('Run gateway in simulation mode (no real connections needed)')
  .option('--interval <seconds>', 'Command generation interval in seconds', '5')
  .option('--venues <list>', 'Comma-separated simulated venues', 'kalshi,binance')
  .option('--fill-rate <rate>', 'Order fill rate 0-1', '0.9')
  .option('--fill-delay <ms>', 'Simulated fill delay in milliseconds', '200')
  .option('--count <n>', 'Commands to generate (0 = infinite)', '0')
  .option('--scenario <name>', 'Scenario: basic, mixed, stress', 'basic')
  .option('--strategy <path>', 'Path to strategy.json for strategy simulation')
  .action(async (options) => {
    const venues = options.venues.split(',').map((v: string) => v.trim());
    const fillRate = parseFloat(options.fillRate);
    const fillDelay = parseInt(options.fillDelay, 10);
    const interval = parseFloat(options.interval);
    const count = parseInt(options.count, 10);
    const scenario = options.scenario as 'basic' | 'mixed' | 'stress';

    // Create a gateway with a dummy config (no real API key needed)
    const gateway = new Gateway({
      pumpampApiKey: 'sim_dummy_key',
      pumpampHost: 'localhost',
      cancelOnShutdown: false,
      logLevel: 'warn',
    } as any);

    // Register simulator connectors for each venue
    for (const venue of venues) {
      const connector = new SimulatorVenueConnector(venue, fillRate, fillDelay);
      gateway.registerConnector(connector);
    }

    // ---- Strategy-based simulation mode ----
    if (options.strategy) {
      const strategyConfig = loadStrategyConfig(options.strategy);
      const engine = new StrategyEngine(strategyConfig, () => []);
      const source = new SimulatorSignalSource({
        intervalSec: interval,
        count,
        strategy: strategyConfig,
      });

      const simStartTime = Date.now();
      const formatElapsed = (): string => {
        const elapsed = Math.floor((Date.now() - simStartTime) / 1000);
        const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const secs = String(elapsed % 60).padStart(2, '0');
        return `${mins}:${secs}`;
      };

      console.log(`Strategy simulation: ${strategyConfig.rules.length} rules, dry_run=${strategyConfig.dry_run}`);

      source.on('signal', async (signal) => {
        const elapsed = formatElapsed();
        const ruleName = (signal.payload as any)?.simulator?.rule_name ?? 'unknown';
        const before = engine.getStatus();

        console.log(`[${elapsed}] SIG  ${signal.signal_type}:${signal.signal_name} ${signal.direction} ${signal.market_id}`);

        const result = engine.handleSignal(signal);
        const after = engine.getStatus();

        const matched = after.signals_matched > before.signals_matched;
        const riskRejected = after.trades_rejected_by_risk > before.trades_rejected_by_risk;

        if (matched) {
          console.log(`[${elapsed}] MATCH rule=${ruleName}`);
        }

        if (riskRejected) {
          console.log(`[${elapsed}] RISK  FAIL`);
          return;
        }

        if (!result) {
          console.log(`[${elapsed}] MATCH none`);
          return;
        }

        const commands = Array.isArray(result) ? result : [result];

        console.log(`[${elapsed}] RISK  PASS`);

        if (strategyConfig.dry_run) {
          for (const cmd of commands) {
            console.log(`[${elapsed}] ORDER DRY_RUN ${cmd.side} ${cmd.size} ${cmd.market_id}`);
          }
          return;
        }

        for (const cmd of commands) {
          try {
            await gateway.injectCommand(cmd);
            engine.recordExecutedTrade(cmd.market_id);
            console.log(`[${elapsed}] ORDER PLACED ${cmd.side} ${cmd.size} ${cmd.market_id}`);
          } catch (error) {
            console.log(`[${elapsed}] ORDER REJECTED ${(error as Error).message}`);
          }
        }
      });

      gateway.on('order_update', (report) => {
        const elapsed = formatElapsed();
        if (report.status === 'filled') {
          console.log(formatFill(report.market_id, report.fill_price ?? 0, report.venue_order_id ?? report.order_id, elapsed));
        } else if (report.status === 'rejected') {
          console.log(formatReject(report.market_id, 'order rejected', elapsed));
        }
      });

      const shutdown = () => {
        source.stop();
        const status = engine.getStatus();
        console.log(`\nStrategy simulation summary:`);
        console.log(`  Signals received: ${status.signals_received}`);
        console.log(`  Signals matched: ${status.signals_matched}`);
        console.log(`  Trades generated: ${status.trades_generated}`);
        console.log(`  Dry-run trades: ${status.dry_run_trades}`);
        console.log(`  Risk rejected: ${status.trades_rejected_by_risk}`);
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      source.on('stopped', shutdown);
      source.start();
      return;
    }

    // ---- Command-based simulation mode (original) ----
    const relay = new SimulatorRelay({ interval, venues, fillRate, fillDelay, count, scenario });

    const simStartTime = Date.now();
    const formatElapsed = (): string => {
      const elapsed = Math.floor((Date.now() - simStartTime) / 1000);
      const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const secs = String(elapsed % 60).padStart(2, '0');
      return `${mins}:${secs}`;
    };

    // Wire order outcomes so simulator stats reflect actual routed results.
    gateway.on('order_update', (report) => {
      const elapsed = formatElapsed();

      if (report.status === 'filled') {
        relay.recordFill();
        console.log(
          formatFill(
            report.market_id,
            report.fill_price ?? 0,
            report.venue_order_id ?? report.order_id,
            elapsed
          )
        );
      } else if (report.status === 'rejected') {
        relay.recordReject();
        console.log(formatReject(report.market_id, 'order rejected', elapsed));
      }

      const status = gateway.getStatus();
      console.log(`[${elapsed}] -->  ${status.openOrders} orders, ${status.openPositions} positions`);
    });

    gateway.on('order_error', (report) => {
      const elapsed = formatElapsed();
      console.log(`[${elapsed}] ERR  ${report.code}: ${report.message}`);
    });

    // Wire: relay emits command -> inject into gateway.
    relay.on('command', async (command) => {
      try {
        await gateway.injectCommand(command);
      } catch (error) {
        const elapsed = formatElapsed();
        console.log(`[${elapsed}] ERR  Unexpected simulation failure: ${(error as Error).message}`);
      }
    });

    // Handle graceful shutdown
    const shutdown = () => {
      relay.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Handle simulation complete (finite count)
    relay.on('stopped', () => {
      process.exit(0);
    });

    // Start simulation
    relay.start();
  });

// --- strategy command group ---
const strategy = program.command('strategy').description('Manage auto-trade strategy configuration');

strategy
  .command('validate <path>')
  .description('Validate a strategy.json configuration file')
  .action((path: string) => {
    const cfg = loadStrategyConfig(path);
    console.log(`Valid strategy: ${cfg.rules.length} rules, dry_run=${cfg.dry_run}`);
  });

strategy
  .command('show')
  .description('Show current strategy configuration')
  .action(() => {
    const cfgPath = process.env.STRATEGY_CONFIG_PATH || './strategy.json';
    const cfg = loadStrategyConfig(cfgPath);
    console.log(JSON.stringify(cfg, null, 2));
  });

strategy
  .command('list')
  .description('List available strategy templates')
  .option('--templates-dir <path>', 'Path to templates directory', resolve(process.cwd(), 'templates'))
  .action((options) => {
    const templatesDir = resolve(options.templatesDir);

    if (!existsSync(templatesDir)) {
      console.error(`Templates directory not found: ${templatesDir}`);
      process.exit(1);
    }

    const files = readdirSync(templatesDir).filter((f: string) => f.endsWith('.json'));

    if (files.length === 0) {
      console.log('No template files found.');
      return;
    }

    console.log('Available Strategy Templates:');
    console.log('=============================');

    for (const file of files) {
      const filePath = join(templatesDir, file);
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const json = JSON.parse(raw);
        const config = strategyConfigSchema.parse(json);

        const name = basename(file, '.json');
        const description = (json as Record<string, unknown>)._description ?? '(no description)';
        const signals = (json as Record<string, unknown>)._signals ?? [];
        const venues = new Set<string>();
        for (const rule of config.rules) {
          if (rule.venues) {
            for (const v of rule.venues) venues.add(v);
          }
        }

        console.log(`\n  ${name}`);
        console.log(`    Description: ${description}`);
        console.log(`    Signals: ${Array.isArray(signals) ? signals.join(', ') : '(none)'}`);
        console.log(`    Venues: ${[...venues].join(', ') || '(any)'}`);
        console.log(`    Dry Run: ${config.dry_run}`);
      } catch (err) {
        console.warn(`  [WARN] Skipping invalid template: ${file} - ${(err as Error).message}`);
      }
    }
  });

// --- replay command ---
program
  .command('replay')
  .description('Replay historical signals through a strategy for backtesting')
  .requiredOption('--strategy <path>', 'Path to strategy config JSON file')
  .requiredOption('--from <date>', 'Start date (ISO 8601)')
  .requiredOption('--to <date>', 'End date (ISO 8601)')
  .option('--output <path>', 'Save report to JSON file')
  .option('--speed <mode>', 'Output verbosity: fast, normal, verbose', 'normal')
  .option('--fee-rate <rate>', 'Fee rate per leg', '0.02')
  .option('--assumed-fill-price <price>', 'Fill price for signals without price data', '0.50')
  .option('--assumed-win-rate <rate>', 'Win rate for unsettled positions', '0.50')
  .option('--compare <paths...>', 'Compare mode: provide multiple strategy files')
  .action(async (options) => {
    try {
      const config = loadConfig();

      if (options.compare) {
        const strategyPaths = [options.strategy, ...options.compare];
        await runCompare(strategyPaths, options, config);
        return;
      }

      const strategyConfig = loadReplayStrategy(options.strategy);
      const from = new Date(options.from);
      const to = new Date(options.to);

      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        console.error('Error: Invalid date format. Use ISO 8601 (e.g., 2026-01-01)');
        process.exit(1);
      }

      const replayConfig: ReplayConfig = {
        strategy: strategyConfig,
        consumer: {
          apiUrl: `https://${config.pumpampHost}`,
          apiKey: config.pumpampApiKey,
          start: from,
          end: to,
        },
        feeRate: parseFloat(options.feeRate),
        assumedFillPrice: parseFloat(options.assumedFillPrice),
        assumedWinRate: parseFloat(options.assumedWinRate),
        speed: options.speed,
        onProgress: options.speed !== 'fast' ? (progress) => {
          process.stdout.write(`\r  Page ${progress.pagesCompleted} | ${progress.signalsProcessed} signals | ${progress.tradesGenerated} trades`);
        } : undefined,
      };

      const engine = new ReplayEngine(replayConfig);
      const report = await engine.run();

      if (options.speed !== 'fast') {
        process.stdout.write('\n');
      }

      console.log(formatReportTable(report));

      if (options.output) {
        const outputPath = resolve(process.cwd(), options.output);
        writeFileSync(outputPath, JSON.stringify(report, null, 2));
        console.log(`\nReport saved to ${outputPath}`);
      }
    } catch (error) {
      console.error(`Replay failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// --- replay-compare command ---
program
  .command('replay-compare')
  .description('Compare multiple strategies against the same signal dataset')
  .requiredOption('--strategies <paths...>', 'Paths to strategy config JSON files')
  .requiredOption('--from <date>', 'Start date')
  .requiredOption('--to <date>', 'End date')
  .option('--output <path>', 'Save comparison report to JSON file')
  .option('--fee-rate <rate>', 'Fee rate per leg', '0.02')
  .action(async (options) => {
    try {
      const config = loadConfig();
      await runCompare(options.strategies, options, config);
    } catch (error) {
      console.error(`Comparison failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

function loadReplayStrategy(path: string): StrategyConfig {
  const resolved = resolve(process.cwd(), path);
  if (!existsSync(resolved)) {
    console.error(`Error: Strategy file not found: ${resolved}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(resolved, 'utf8')) as StrategyConfig;
}

async function runCompare(
  strategyPaths: string[],
  options: { from: string; to: string; output?: string; feeRate?: string },
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const from = new Date(options.from);
  const to = new Date(options.to);

  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    console.error('Error: Invalid date format. Use ISO 8601 (e.g., 2026-01-01)');
    process.exit(1);
  }

  const strategies = strategyPaths.map(p => {
    const cfg = loadReplayStrategy(p);
    return { name: (cfg as Record<string, unknown>)._description as string ?? basename(p, '.json'), config: cfg };
  });

  const results = await ReplayEngine.compare(
    strategies,
    {
      apiUrl: `https://${config.pumpampHost}`,
      apiKey: config.pumpampApiKey,
      start: from,
      end: to,
    },
    { feeRate: parseFloat(options.feeRate ?? '0.02') },
  );

  console.log(`Strategy Comparison (${options.from} to ${options.to})`);
  console.log('==============================================================================');
  const header = ''.padEnd(24) + results.map(r => r.name.padEnd(22)).join('');
  console.log(header);
  const rows = [
    { label: 'Signals matched', fn: (r: typeof results[0]) => String(r.report.summary.signalsMatched) },
    { label: 'Trades generated', fn: (r: typeof results[0]) => String(r.report.summary.tradesGenerated) },
    { label: 'Win rate', fn: (r: typeof results[0]) => `${(r.report.winRate.winRate * 100).toFixed(0)}%` },
    { label: 'Net P&L', fn: (r: typeof results[0]) => `${r.report.pnl.netPnl >= 0 ? '+' : ''}$${Math.abs(r.report.pnl.netPnl).toFixed(2)}` },
    { label: 'Max drawdown', fn: (r: typeof results[0]) => `-$${r.report.risk.maxDrawdown.toFixed(2)}` },
    { label: 'Sharpe ratio', fn: (r: typeof results[0]) => r.report.risk.sharpeRatio?.toFixed(2) ?? 'N/A' },
    { label: 'Payload-priced %', fn: (r: typeof results[0]) => `${(r.report.dataQuality.exactPriceRate * 100).toFixed(0)}%` },
  ];
  for (const row of rows) {
    console.log(row.label.padEnd(24) + results.map(r => row.fn(r).padEnd(22)).join(''));
  }
  console.log('==============================================================================');

  if (options.output) {
    const outputPath = resolve(process.cwd(), options.output);
    writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`\nComparison saved to ${outputPath}`);
  }
}

export { program };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  program.parse();
}
