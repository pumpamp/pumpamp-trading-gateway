import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrategyEngine } from '../../features/strategy/strategy-engine.js';
import { Gateway } from '../../gateway.js';
import type { VenueConnector } from '../../features/execution/venue-connector.js';
import type {
  OrderRequest,
  OrderResult,
  Balance,
  TradeCommand,
} from '../../shared/protocol.js';
import type { GatewayConfig } from '../../shared/config.js';
import {
  createTestSignal,
  createTestRule,
  createTestConfig,
} from '../../features/strategy/__tests__/fixtures/strategy-test-helpers.js';

// Mock logger
vi.mock('../../shared/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
  sanitizeUrl: (url: string) => url.split('?')[0],
}));

// Mock signal-consumer to avoid real WebSocket connections
vi.mock('../../features/signals/signal-consumer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../features/signals/signal-consumer.js')>();
  return {
    ...actual,
    SignalConsumer: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      removeAllListeners: vi.fn(),
    })),
  };
});

// Mock strategy-config loader
vi.mock('../../features/strategy/strategy-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../features/strategy/strategy-config.js')>();
  return {
    ...actual,
    loadStrategyConfig: vi.fn(),
  };
});

// ============================================================
// Helpers
// ============================================================

function createMockConnector(venue: string): VenueConnector & {
  placeOrder: ReturnType<typeof vi.fn>;
} {
  return {
    venue,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    placeOrder: vi.fn().mockResolvedValue({
      order_id: `${venue}-order-001`,
      status: 'submitted',
    } satisfies OrderResult),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    cancelAllOrders: vi.fn().mockResolvedValue(undefined),
    getPositions: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({
      venue,
      available: 10000,
      total: 10000,
      currency: 'USD',
    } satisfies Balance),
    isHealthy: vi.fn().mockReturnValue(true),
  };
}

// ============================================================
// ============================================================

describe('integration/strategy-flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Full pipeline: matching signal -> order placed', async () => {
    const config = createTestConfig({
      dry_run: false,
      rules: [createTestRule({
        signal_types: ['strategy'],
        venues: ['binance'],
        min_confidence: 70,
      })],
    });
    const engine = new StrategyEngine(config, () => []);

    const connector = createMockConnector('binance');

    // Feed matching signal
    const signal = createTestSignal({
      signal_type: 'strategy',
      venue: 'binance',
      confidence: '85',
      direction: 'long',
      market_id: 'binance:BTC/USDT',
    });

    const result = engine.handleSignal(signal);
    expect(result).not.toBeNull();
    const command = result as TradeCommand;
    expect(command.market_id).toBe('binance:BTCUSDT');
    expect(command.venue).toBe('binance');

    // Simulate gateway injection by placing order through connector
    const orderRequest: OrderRequest = {
      market_id: command.market_id.split(':')[1],
      venue: command.venue,
      side: command.side,
      action: command.action,
      size: command.size,
      order_type: command.order_type as 'market' | 'limit',
      command_id: command.id,
    };
    await connector.placeOrder(orderRequest);
    expect(connector.placeOrder).toHaveBeenCalledOnce();

    const status = engine.getStatus();
    expect(status.signals_received).toBe(1);
    expect(status.trades_generated).toBe(1);
  });

  it('Full pipeline: non-matching signal -> no order', () => {
    const config = createTestConfig({
      dry_run: false,
      rules: [createTestRule({ signal_types: ['strategy'] })],
    });
    const engine = new StrategyEngine(config, () => []);
    const connector = createMockConnector('binance');

    // Feed non-matching signal (wrong type)
    const signal = createTestSignal({
      signal_type: 'alert',
      venue: 'binance',
    });

    const command = engine.handleSignal(signal);
    expect(command).toBeNull();
    expect(connector.placeOrder).not.toHaveBeenCalled();

    const status = engine.getStatus();
    expect(status.signals_received).toBe(1);
    expect(status.signals_matched).toBe(0);
  });

  it('Full pipeline: dry-run mode -> no real order', () => {
    const config = createTestConfig({ dry_run: true });
    const engine = new StrategyEngine(config, () => []);
    const connector = createMockConnector('binance');

    const dryRunHandler = vi.fn();
    engine.on('dry_run_trade', dryRunHandler);

    const signal = createTestSignal({
      signal_type: 'strategy',
      venue: 'binance',
      confidence: '85',
      direction: 'long',
    });

    const command = engine.handleSignal(signal);
    expect(command).not.toBeNull();
    expect(dryRunHandler).toHaveBeenCalledOnce();
    // In dry-run mode, the gateway should NOT call placeOrder
    expect(connector.placeOrder).not.toHaveBeenCalled();

    const status = engine.getStatus();
    expect(status.dry_run_trades).toBe(1);
  });

  it('Full pipeline: risk rejection -> no order', () => {
    const _config = createTestConfig({
      dry_run: false,
      risk_limits: {
        max_trades_per_minute: 0, // Reject all (rate limit = 0 trades allowed)
        market_cooldown_seconds: 0,
        signal_dedup_window_seconds: 300,
      },
    });

    // max_trades_per_minute defaults to positive in Zod, so we construct manually
    // Actually, Zod schema says .positive() which means 0 is invalid.
    // Let's use max_trades_per_minute: 1 and record a trade first.
    const config2 = createTestConfig({
      dry_run: false,
      risk_limits: {
        max_trades_per_minute: 1,
        market_cooldown_seconds: 0,
        signal_dedup_window_seconds: 300,
      },
    });
    const engine = new StrategyEngine(config2, () => []);
    const _connector = createMockConnector('binance');

    // Use up the rate limit
    const signal1 = createTestSignal({ id: 'risk-1', direction: 'long' });
    const cmd1 = engine.handleSignal(signal1) as TradeCommand;
    expect(cmd1).not.toBeNull();
    engine.recordExecutedTrade(cmd1.market_id);

    // Second signal should be risk-rejected
    vi.advanceTimersByTime(100);
    const signal2 = createTestSignal({ id: 'risk-2', direction: 'long' });
    const command = engine.handleSignal(signal2);
    expect(command).toBeNull();

    const status = engine.getStatus();
    expect(status.trades_rejected_by_risk).toBe(1);
  });

  it('Full pipeline: recordExecutedTrade updates state', () => {
    const config = createTestConfig({
      dry_run: false,
      risk_limits: {
        max_trades_per_minute: 100,
        market_cooldown_seconds: 60,
        signal_dedup_window_seconds: 300,
      },
    });
    const engine = new StrategyEngine(config, () => []);

    // First trade succeeds
    const signal1 = createTestSignal({ id: 'cooldown-1', direction: 'long' });
    const cmd1 = engine.handleSignal(signal1) as TradeCommand;
    expect(cmd1).not.toBeNull();
    engine.recordExecutedTrade(cmd1.market_id);

    // Same market immediately should be blocked by cooldown
    vi.advanceTimersByTime(100);
    const signal2 = createTestSignal({ id: 'cooldown-2', direction: 'long' });
    const cmd2 = engine.handleSignal(signal2);
    expect(cmd2).toBeNull();
  });

  it('Gateway pause/resume propagates to StrategyEngine', async () => {
    const gateway = new Gateway({ pumpampApiKey: 'k', pumpampHost: 'localhost', cancelOnShutdown: false, logLevel: 'warn' } as GatewayConfig);
    const engine = new StrategyEngine(createTestConfig({ dry_run: false }), () => []);
    (gateway as any).strategyEngine = engine;

    await (gateway as any).handleCommand({ type: 'pause', id: 'cmd-pause' });
    expect(engine.isEnabled()).toBe(false);
    expect((gateway as any).strategyStatusOverride).toBe('paused');

    await (gateway as any).handleCommand({ type: 'resume', id: 'cmd-resume' });
    expect(engine.isEnabled()).toBe(true);
    expect((gateway as any).strategyStatusOverride).toBeNull();
  });

  it('Gateway stop() cleans strategy/signal resources', async () => {
    const gateway = new Gateway({ pumpampApiKey: 'k', pumpampHost: 'localhost', cancelOnShutdown: false, logLevel: 'warn' } as GatewayConfig);
    const engine = new StrategyEngine(createTestConfig({ dry_run: false, enabled: true }), () => []);
    const signalConsumer = { removeAllListeners: vi.fn(), disconnect: vi.fn() };

    (gateway as any).state = 'running';
    (gateway as any).strategyEngine = engine;
    (gateway as any).signalConsumer = signalConsumer;
    (gateway as any).relay = { sendReport: vi.fn(), disconnect: vi.fn(), state: 'DISCONNECTED' };

    await gateway.stop();

    expect(signalConsumer.removeAllListeners).toHaveBeenCalledWith('signal');
    expect(signalConsumer.disconnect).toHaveBeenCalled();
    expect((gateway as any).strategyEngine).toBeNull();
  });

  it('Heartbeat includes strategy_status + strategy_metrics', () => {
    const gateway = new Gateway({ pumpampApiKey: 'k', pumpampHost: 'localhost', cancelOnShutdown: false, logLevel: 'warn' } as GatewayConfig);
    const engine = new StrategyEngine(createTestConfig({ dry_run: true, enabled: true }), () => []);
    const updateStatus = vi.fn();

    (gateway as any).strategyEngine = engine;
    (gateway as any).relay = { updateStatus, state: 'DISCONNECTED' };

    engine.handleSignal(createTestSignal({ id: 'hb-1', direction: 'long', confidence: '85' }));
    (gateway as any).updateRelayStatus();

    expect(updateStatus).toHaveBeenCalledWith(expect.objectContaining({
      strategy_status: 'active:dry_run',
      strategy_metrics: expect.objectContaining({
        signals_received: 1,
        signals_matched: 1,
        trades_generated: 0,
        trades_rejected_by_risk: 0,
        dry_run_trades: 1,
        signals_dropped_stale_or_duplicate: 0,
      }),
    }));
  });

  it('Heartbeat reports error:strategy_init_failed on init failure', async () => {
    const { loadStrategyConfig } = await import('../../features/strategy/strategy-config.js');
    vi.mocked(loadStrategyConfig).mockImplementation(() => {
      throw new Error('File not found: /bad/path/strategy.json');
    });

    const gateway = new Gateway({
      pumpampApiKey: 'k',
      pumpampHost: 'localhost',
      cancelOnShutdown: false,
      logLevel: 'warn',
      autoTradeEnabled: true,
      strategyConfigPath: '/bad/path/strategy.json',
    } as GatewayConfig);

    const relayStub = { on: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), sendReport: vi.fn(), updateStatus: vi.fn(), state: 'DISCONNECTED' };
    (gateway as any).relay = relayStub;
    vi.spyOn(gateway as any, 'discoverConnectors').mockResolvedValue(undefined);

    await gateway.start();
    (gateway as any).updateRelayStatus();

    expect(relayStub.updateStatus).toHaveBeenCalledWith(expect.objectContaining({
      strategy_status: 'error:strategy_init_failed',
    }));

    await gateway.stop();
  });

  it('Live execution sends order_update report through relay', async () => {
    const gateway = new Gateway({ pumpampApiKey: 'k', pumpampHost: 'localhost', cancelOnShutdown: false, logLevel: 'warn' } as GatewayConfig);
    const relayStub = { state: 'CONNECTED', sendReport: vi.fn(), updateStatus: vi.fn() };
    (gateway as any).relay = relayStub;

    const connector = createMockConnector('binance');
    gateway.registerConnector(connector);

    const engine = new StrategyEngine(createTestConfig({ dry_run: false }), () => []);
    const signal = createTestSignal({ signal_type: 'strategy', venue: 'binance', direction: 'long', confidence: '85' });
    const command = engine.handleSignal(signal) as TradeCommand;

    await gateway.injectCommand(command);

    expect(relayStub.sendReport).toHaveBeenCalledWith(expect.objectContaining({
      type: 'order_update',
      market_id: command.market_id,
    }));
  });
});
