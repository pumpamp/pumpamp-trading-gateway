// ============================================================
// Gateway: Main orchestrator that wires all components together
// Manages relay connection, venue connectors, order routing,
// position tracking, and graceful lifecycle management
// ============================================================

import { EventEmitter } from 'events';
import { createRequire } from 'module';
import { RelayClient, type StatusUpdate } from './features/relay/relay-client.js';
import { SignalConsumer } from './features/signals/signal-consumer.js';
import { OrderRouter } from './features/execution/order-router.js';
import { PositionTracker } from './features/execution/position-tracker.js';
import type { GatewayConfig } from './shared/config.js';
import { loadStrategyConfig, type StrategyConfig } from './features/strategy/strategy-config.js';
import { StrategyEngine } from './features/strategy/strategy-engine.js';
import { createLogger } from './shared/logger.js';
import type {
  BotUserCommand,
  TradeCommand,
  PositionReport,
  SettlementReport,
  Settlement,
  ErrorReport,
  Position,
  OrderUpdateReport,
  RelayReport,
} from './shared/protocol.js';
import type { VenueConnector } from './features/execution/venue-connector.js';
import { SimulatorVenueConnector } from './features/simulator/simulator.js';

const logger = createLogger('Gateway');

export interface GatewayStatus {
  state: 'stopped' | 'starting' | 'running' | 'stopping';
  relayConnected: boolean;
  pairingId: string | null;
  venues: Record<string, { connected: boolean; healthy: boolean }>;
  openOrders: number;
  openPositions: number;
  uptimeSeconds: number;
}

export class Gateway extends EventEmitter {
  private config: GatewayConfig;
  private relay: RelayClient;
  private signalConsumer: SignalConsumer | null = null;
  private strategyEngine: StrategyEngine | null = null;
  private strategyStatusOverride: string | null = null;
  private orderRouter: OrderRouter;
  private positionTracker: PositionTracker;
  private connectors: Map<string, VenueConnector> = new Map();

  private state: 'stopped' | 'starting' | 'running' | 'stopping' = 'stopped';
  private startTime = 0;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private cancelOnShutdown: boolean;

  constructor(config: GatewayConfig) {
    super();
    this.config = config;
    this.cancelOnShutdown = config.cancelOnShutdown ?? false;

    // Initialize relay client
    this.relay = new RelayClient({
      host: config.pumpampHost,
      apiKey: config.pumpampApiKey,
      pairingId: config.pumpampPairingId,
    });

    // Initialize order router and position tracker
    this.orderRouter = new OrderRouter();
    this.positionTracker = new PositionTracker();

    this.wirePipelineEvents();
  }

  /**
   * Start the gateway: connect relay, discover and connect venue connectors,
   * begin heartbeat, send initial state sync.
   */
  async start(): Promise<void> {
    if (this.state !== 'stopped') {
      throw new Error(`Cannot start gateway: state is ${this.state}`);
    }

    this.state = 'starting';
    this.startTime = Date.now();
    logger.info('Starting gateway');

    // Wire relay events
    this.relay.on('command', (command: BotUserCommand) => this.handleCommand(command));
    this.relay.on('connected', () => this.onRelayConnected());
    this.relay.on('disconnected', () => this.onRelayDisconnected());
    this.relay.on('pairing_confirmed', (msg) => {
      logger.info({ pairing_id: msg.pairing_id }, 'Pairing confirmed');
      this.emit('pairing_confirmed', msg);
    });

    // Discover and register venue connectors
    if (this.config.simulateOrders) {
      this.registerSimulatorConnectors();
    } else {
      await this.discoverConnectors();
    }

    // Connect relay
    this.relay.connect();

    // Start health checks (30s interval)
    this.healthCheckInterval = setInterval(() => this.runHealthChecks(), 30_000);

    // Initialize auto-trade strategy engine (double-gate: env var + config file)
    if (this.config.autoTradeEnabled && this.config.strategyConfigPath) {
      try {
        const strategyConfig = loadStrategyConfig(this.config.strategyConfigPath);

        this.strategyEngine = new StrategyEngine(
          strategyConfig,
          () => this.positionTracker.getPositions(),
        );

        // Create and wire signal consumer
        this.signalConsumer = new SignalConsumer({
          host: this.config.pumpampHost,
          apiKey: this.config.pumpampApiKey,
          signalTypes: this.getActiveSignalTypes(strategyConfig),
        });

        this.signalConsumer.on('signal', async (signal) => {
          if (!this.strategyEngine?.isEnabled()) return;

          try {
            const result = this.strategyEngine.handleSignal(signal);
            const commands = Array.isArray(result) ? result : result ? [result] : [];

            if (commands.length > 0 && !strategyConfig.dry_run) {
              await this.executeStrategyCommands(commands, signal.id);
            }
          } catch (error) {
            logger.error({ error, signalId: signal.id }, 'Auto-trade signal processing failed');
          }
        });

        this.signalConsumer.connect();
        logger.info(
          { rules: strategyConfig.rules.length, dryRun: strategyConfig.dry_run },
          'Strategy engine initialized',
        );
      } catch (error) {
        this.strategyStatusOverride = 'error:strategy_init_failed';
        logger.error({ error }, 'Failed to initialize strategy engine, continuing without auto-trade');
      }
    }

    // Setup signal handlers for graceful shutdown
    const shutdown = () => this.stop();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    this.state = 'running';
    logger.info({ venues: [...this.connectors.keys()] }, 'Gateway started');
  }

  /**
   * Stop the gateway: optionally cancel pending orders, disconnect all,
   * report shutdown via relay.
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') {
      return;
    }

    this.state = 'stopping';
    logger.info('Stopping gateway');

    // Clean up strategy engine resources
    this.strategyEngine?.disable();
    if (this.signalConsumer) {
      this.signalConsumer.removeAllListeners('signal');
      this.signalConsumer.disconnect();
    }
    this.strategyEngine = null;
    this.strategyStatusOverride = null;

    // Stop health checks
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Optionally cancel pending orders
    if (this.cancelOnShutdown) {
      logger.info('Cancelling pending orders before shutdown');
      for (const [name, connector] of this.connectors) {
        try {
          await connector.cancelAllOrders();
        } catch (error) {
          logger.error({ venue: name, error }, 'Failed to cancel orders during shutdown');
        }
      }
    }

    // Report shutdown
    const shutdownReport: ErrorReport = {
      type: 'error',
      code: 'GATEWAY_SHUTDOWN',
      message: 'Gateway shutting down gracefully',
    };
    this.relay.sendReport(shutdownReport);

    // Disconnect venue connectors
    for (const [name, connector] of this.connectors) {
      try {
        await connector.disconnect();
      } catch (error) {
        logger.error({ venue: name, error }, 'Error disconnecting venue');
      }
    }

    // Disconnect signal consumer
    if (this.signalConsumer) {
      this.signalConsumer.disconnect();
    }

    // Disconnect relay
    this.relay.disconnect();

    this.state = 'stopped';
    logger.info('Gateway stopped');
    this.emit('stopped');
  }

  /**
   * One-shot pairing flow: connect to relay with a pairing code,
   * wait for confirmation, return the pairing_id.
   */
  async pair(code: string): Promise<string> {
    logger.info('Starting pairing flow');

    const pairRelay = new RelayClient({
      host: this.config.pumpampHost,
      apiKey: this.config.pumpampApiKey,
      pairingCode: code,
    });

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pairRelay.disconnect();
        reject(new Error('Pairing timed out (60s)'));
      }, 60_000);

      pairRelay.on('pairing_confirmed', (msg) => {
        clearTimeout(timeout);
        pairRelay.disconnect();
        resolve(msg.pairing_id);
      });

      pairRelay.on('error', (err: Error) => {
        clearTimeout(timeout);
        pairRelay.disconnect();
        reject(err);
      });

      pairRelay.connect();
    });
  }

  /**
   * Get current gateway status.
   */
  getStatus(): GatewayStatus {
    const venues: Record<string, { connected: boolean; healthy: boolean }> = {};
    for (const [name, connector] of this.connectors) {
      venues[name] = {
        connected: true,
        healthy: connector.isHealthy(),
      };
    }

    return {
      state: this.state,
      relayConnected: this.relay.state === 'CONNECTED',
      pairingId: this.relay.pairingId,
      venues,
      openOrders: this.orderRouter.getOrders().size,
      openPositions: this.positionTracker.getPositions().length,
      uptimeSeconds: this.startTime > 0 ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
    };
  }

  /**
   * Register an externally-created venue connector.
   */
  registerConnector(connector: VenueConnector): void {
    this.connectors.set(connector.venue, connector);
    this.orderRouter.registerConnector(connector);
  }

  /**
   * Inject a command directly into the gateway pipeline (bypasses relay).
   * Used by the simulator and for testing.
   */
  async injectCommand(command: BotUserCommand): Promise<void> {
    return this.handleCommand(command);
  }

  private async executeStrategyCommands(commands: TradeCommand[], signalId: string): Promise<void> {
    for (let i = 0; i < commands.length; i++) {
      const command = commands[i];
      await this.injectCommand(command);

      const routedOrder = [...this.orderRouter.getOrders().values()]
        .find((o) => o.commandId === command.id);

      const failed = !routedOrder || routedOrder.status === 'rejected';
      if (failed) {
        const code = i === 0 ? 'ARB_LEG1_FAILED' : 'ARB_LEG2_FAILED_HEDGE_REQUIRED';
        const message = i === 0
          ? `Arbitrage leg 1 failed; leg 2 aborted (signal_id=${signalId}, command_id=${command.id})`
          : `Arbitrage leg 2 failed after leg 1 success; hedge required (signal_id=${signalId}, leg1=${commands[0].id}, leg2=${commands[1].id})`;

        const report: ErrorReport = {
          type: 'error',
          code,
          message,
          command_id: command.id,
        };
        this.maybeSendReport(report);
        this.emit('order_error', report);

        if (i === 0) break;
        continue;
      }

      this.strategyEngine?.recordExecutedTrade(command.market_id);
    }
  }

  // --- Private methods ---

  private registerSimulatorConnectors(): void {
    const venues = ['kalshi', 'polymarket', 'hyperliquid', 'binance'];
    for (const venue of venues) {
      // 100% fill rate, 100ms latency for predictable smoke testing
      const connector = new SimulatorVenueConnector(venue, 1.0, 100);
      this.registerConnector(connector);
    }
    logger.info({ venues }, 'Simulate mode: registered simulator connectors');
  }

  private async discoverConnectors(): Promise<void> {
    // Resolve connector packages from workspace root to avoid circular
    // dependency issues with pnpm strict isolation. The connectors depend
    // on @pumpamp/core for VenueConnector types, so core can't list them
    // as deps without creating a cycle.
    // From packages/core/dist/gateway.js -> ../../.. = workspace root
    const wsRoot = new URL('../../../package.json', import.meta.url).pathname;
    const require = createRequire(wsRoot);

    // Kalshi: needs KALSHI_API_KEY + KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_PATH
    if (this.config.kalshi) {
      try {
        const { KalshiConnector } = require('@pumpamp/connector-kalshi');
        const connector = new KalshiConnector({
          apiUrl: this.config.kalshi.apiUrl,
          apiKey: this.config.kalshi.apiKey,
          privateKeyPem: this.config.kalshi.privateKeyPem,
        });
        this.registerConnector(connector);
        logger.info('Kalshi connector discovered');
      } catch (error) {
        logger.error({ error }, 'Failed to load Kalshi connector');
      }
    }

    // Polymarket: only needs POLYMARKET_PRIVATE_KEY (API creds auto-derived)
    if (this.config.polymarket) {
      try {
        const { PolymarketConnector } = require('@pumpamp/connector-polymarket');
        const connector = new PolymarketConnector({
          apiUrl: this.config.polymarket.apiUrl,
          privateKey: this.config.polymarket.privateKey,
          apiKey: this.config.polymarket.apiKey,
          apiSecret: this.config.polymarket.apiSecret,
          passphrase: this.config.polymarket.passphrase,
          proxyAddress: this.config.polymarket.proxyAddress,
        });
        this.registerConnector(connector);
        logger.info('Polymarket connector discovered');
      } catch (error) {
        logger.error({ error }, 'Failed to load Polymarket connector');
      }
    }

    // Hyperliquid: needs HYPERLIQUID_PRIVATE_KEY
    if (this.config.hyperliquid) {
      try {
        const { HyperliquidConnector } = require('@pumpamp/connector-hyperliquid');
        const connector = new HyperliquidConnector({
          privateKey: this.config.hyperliquid.privateKey,
        });
        this.registerConnector(connector);
        logger.info('Hyperliquid connector discovered');
      } catch (error) {
        logger.error({ error }, 'Failed to load Hyperliquid connector');
      }
    }

    // Binance: needs BINANCE_API_KEY + BINANCE_API_SECRET
    if (this.config.binance) {
      try {
        const { BinanceConnector } = require('@pumpamp/connector-binance');
        const connector = new BinanceConnector({
          apiUrl: this.config.binance.apiUrl,
          apiKey: this.config.binance.apiKey,
          apiSecret: this.config.binance.apiSecret,
          futures: this.config.binance.futures,
        });
        this.registerConnector(connector);
        logger.info('Binance connector discovered');
      } catch (error) {
        logger.error({ error }, 'Failed to load Binance connector');
      }
    }

    // Connect all discovered connectors
    for (const [name, connector] of this.connectors) {
      try {
        await connector.connect();
        logger.info({ venue: name }, 'Venue connector connected');
      } catch (error) {
        logger.error({ venue: name, err: error }, 'Failed to connect venue connector');
      }
    }
  }

  private async handleCommand(command: BotUserCommand): Promise<void> {
    if (command.type === 'pause' && this.strategyEngine) {
      this.strategyEngine.disable();
      this.strategyStatusOverride = 'paused';
    }
    if (command.type === 'resume' && this.strategyEngine) {
      this.strategyEngine.enable();
      this.strategyStatusOverride = null;
    }
    await this.orderRouter.routeCommand(command);
    this.updateRelayStatus();
  }

  private wirePipelineEvents(): void {
    // Ensure router errors are always handled (including simulation mode before start()).
    this.orderRouter.on('order_update', (report: OrderUpdateReport) => {
      this.maybeSendReport(report);
      this.emit('order_update', report);

      // Bridge filled orders to position tracker
      if (report.status === 'filled') {
        this.positionTracker.updatePosition({
          venue: report.venue,
          market_id: report.market_id,
          side: report.side,
          size: report.size,
          entry_price: report.fill_price ?? 0,
        });
      }
    });

    this.orderRouter.on('error', (report: ErrorReport) => {
      this.maybeSendReport(report);
      this.emit('order_error', report);
    });

    this.positionTracker.on('position_update', (position: Position) => {
      const report: PositionReport = {
        type: 'position',
        venue: position.venue,
        market_id: position.market_id,
        side: position.side,
        size: position.size,
        entry_price: position.entry_price,
        current_price: position.current_price,
        unrealized_pnl: position.unrealized_pnl,
      };
      this.maybeSendReport(report);
      this.emit('position_update', report);
    });

    this.positionTracker.on('settlement', (settlement: Settlement) => {
      const report: SettlementReport = {
        type: 'settlement',
        venue: settlement.venue,
        market_id: settlement.market_id,
        result: settlement.result,
        entry_price: settlement.entry_price,
        settlement_price: settlement.settlement_price,
        realized_pnl: settlement.realized_pnl,
        timestamp: settlement.timestamp ?? new Date().toISOString(),
      };
      this.maybeSendReport(report);
      this.emit('settlement', report);
    });
  }

  private maybeSendReport(report: RelayReport): void {
    if (this.relay.state === 'CONNECTED') {
      this.relay.sendReport(report);
    }
  }

  private async onRelayConnected(): Promise<void> {
    logger.info('Relay connected, sending state sync');

    // Update relay status
    this.updateRelayStatus();

    // Send full state sync: positions, orders, venue health
    await this.sendStateSync();
  }

  private onRelayDisconnected(): void {
    logger.warn('Relay disconnected');
    this.emit('relay_disconnected');
  }

  private async sendStateSync(): Promise<void> {
    // Send all positions
    for (const position of this.positionTracker.getPositions()) {
      const report: PositionReport = {
        type: 'position',
        venue: position.venue,
        market_id: position.market_id,
        side: position.side,
        size: position.size,
        entry_price: position.entry_price,
        current_price: position.current_price,
        unrealized_pnl: position.unrealized_pnl,
      };
      this.relay.sendReport(report);
    }

    // Report venue health
    for (const [name, connector] of this.connectors) {
      if (!connector.isHealthy()) {
        const errorReport: ErrorReport = {
          type: 'error',
          code: 'VENUE_UNHEALTHY',
          venue: name,
          message: `${name} is not healthy at state sync time`,
        };
        this.relay.sendReport(errorReport);
      }
    }
  }

  private updateRelayStatus(): void {
    const update: StatusUpdate = {
      connected_venues: [...this.connectors.keys()].filter(
        (v) => this.connectors.get(v)?.isHealthy() ?? false
      ),
      open_orders: this.orderRouter.getOrders().size,
      open_positions: this.positionTracker.getPositions().length,
      strategy_status: this.strategyStatusOverride ?? this.strategyEngine?.getStatusString() ?? 'disabled',
      strategy_metrics: this.strategyEngine?.getStatus() ?? undefined,
    };
    this.relay.updateStatus(update);
  }

  private getActiveSignalTypes(config: StrategyConfig): string[] {
    const types = new Set<string>();
    for (const rule of config.rules) {
      if (rule.enabled) {
        for (const t of rule.signal_types) {
          types.add(t);
        }
      }
    }
    return [...types];
  }

  private async runHealthChecks(): Promise<void> {
    for (const [name, connector] of this.connectors) {
      const wasHealthy = connector.isHealthy();
      const isHealthy = connector.isHealthy(); // Triggers async health check

      if (wasHealthy && !isHealthy) {
        logger.warn({ venue: name }, 'Venue became unhealthy');
        const report: ErrorReport = {
          type: 'error',
          code: 'VENUE_UNHEALTHY',
          venue: name,
          message: `${name} health check failed`,
        };
        this.relay.sendReport(report);
      }
    }

    this.updateRelayStatus();
  }
}
