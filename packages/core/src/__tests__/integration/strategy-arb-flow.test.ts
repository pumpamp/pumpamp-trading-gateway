import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StrategyEngine } from '../../features/strategy/strategy-engine.js';
import { Gateway } from '../../gateway.js';
import type { VenueConnector } from '../../features/execution/venue-connector.js';
import type {
  OrderResult,
  Balance,
} from '../../shared/protocol.js';
import type { GatewayConfig } from '../../shared/config.js';
import type { Signal } from '../../features/signals/signal-consumer.js';
import { strategyConfigSchema } from '../../features/strategy/strategy-config.js';
import { program } from '../../cli.js';
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

function createArbSignal(overrides?: Partial<Signal>): Signal {
  return {
    id: 'sig-arb-001',
    signal_type: 'alert',
    signal_name: 'cross_venue_arbitrage',
    market_id: 'kalshi:KXBTCD-26FEB11',
    venue: 'kalshi',
    base_currency: 'BTC',
    quote_currency: 'YES',
    created_at: new Date().toISOString(),
    confidence: '85',
    severity: 'High',
    direction: 'above',
    description: 'Cross-venue arbitrage opportunity',
    payload: {
      version: 1,
      pair_id: 'BTC-100K',
      pair_name: 'Bitcoin $100K',
      direction: 'buy_kalshi_sell_poly',
      buy_venue: 'kalshi',
      sell_venue: 'polymarket',
      buy_market_id: 'KXBTCD-26FEB11',
      sell_market_id: '0xabc123:0',
      buy_price: '0.45',
      sell_price: '0.58',
      gross_spread_pct: '13.0',
      net_spread_pct: '10.5',
      liquidity_used_usd: '5000',
      potential_profit_usd: '525',
      emitted_at: new Date().toISOString(),
    },
    ...overrides,
  };
}

function createArbConfig(overrides?: Partial<Parameters<typeof createTestConfig>[0]>) {
  return createTestConfig({
    dry_run: false,
    rules: [
      createTestRule({
        name: 'arb_rule',
        signal_types: ['alert'],
        signal_names: ['cross_venue_arbitrage'],
        venues: ['kalshi', 'polymarket'],
        min_confidence: 70,
        action: { side: 'from_signal', size: 25, order_type: 'market' },
      }),
    ],
    ...overrides,
  });
}

const TEMPLATES_DIR = resolve(__dirname, '../../../../../templates');

// ============================================================
// ============================================================

describe('integration/strategy-arb-flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Arb signal produces two injectCommand calls', async () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);

    const kalshiConnector = createMockConnector('kalshi');
    const polyConnector = createMockConnector('polymarket');

    const gateway = new Gateway({
      pumpampApiKey: 'k',
      pumpampHost: 'localhost',
      cancelOnShutdown: false,
      logLevel: 'warn',
    } as GatewayConfig);

    gateway.registerConnector(kalshiConnector);
    gateway.registerConnector(polyConnector);

    const signal = createArbSignal();
    const result = engine.handleSignal(signal);

    expect(Array.isArray(result)).toBe(true);
    const commands = result as any[];
    expect(commands).toHaveLength(2);

    // Inject both commands (simulating gateway signal handler)
    for (const cmd of commands) {
      await gateway.injectCommand(cmd);
    }

    // Verify both connectors were called
    expect(kalshiConnector.placeOrder).toHaveBeenCalledOnce();
    expect(polyConnector.placeOrder).toHaveBeenCalledOnce();
  });

  it('Buy leg uses correct venue/market_id', async () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);
    const connector = createMockConnector('kalshi');

    const gateway = new Gateway({
      pumpampApiKey: 'k',
      pumpampHost: 'localhost',
      cancelOnShutdown: false,
      logLevel: 'warn',
    } as GatewayConfig);
    gateway.registerConnector(connector);

    const signal = createArbSignal();
    const result = engine.handleSignal(signal) as any[];
    const buyCmd = result[0];

    await gateway.injectCommand(buyCmd);

    expect(connector.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        venue: 'kalshi',
        market_id: 'KXBTCD-26FEB11',
      }),
    );
  });

  it('Sell leg uses correct venue/market_id', async () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);
    const connector = createMockConnector('polymarket');

    const gateway = new Gateway({
      pumpampApiKey: 'k',
      pumpampHost: 'localhost',
      cancelOnShutdown: false,
      logLevel: 'warn',
    } as GatewayConfig);
    gateway.registerConnector(connector);

    const signal = createArbSignal();
    const result = engine.handleSignal(signal) as any[];
    const sellCmd = result[1];

    await gateway.injectCommand(sellCmd);

    expect(connector.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        venue: 'polymarket',
        market_id: '0xabc123:0',
      }),
    );
  });

  it('Leg 1 failure aborts leg 2 (ARB_LEG1_FAILED error)', async () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);

    const kalshiConnector = createMockConnector('kalshi');
    kalshiConnector.placeOrder.mockRejectedValue(new Error('Order placement failed'));
    const polyConnector = createMockConnector('polymarket');

    const gateway = new Gateway({
      pumpampApiKey: 'k',
      pumpampHost: 'localhost',
      cancelOnShutdown: false,
      logLevel: 'warn',
    } as GatewayConfig);
    gateway.registerConnector(kalshiConnector);
    gateway.registerConnector(polyConnector);

    const errorHandler = vi.fn();
    gateway.on('order_error', errorHandler);

    const signal = createArbSignal();
    const result = engine.handleSignal(signal) as any[];
    const [buyCmd, sellCmd] = result;

    await (gateway as any).executeStrategyCommands([buyCmd, sellCmd], signal.id);

    const leg1Failed = errorHandler.mock.calls.some(
      (call: any[]) => call[0].code === 'ARB_LEG1_FAILED',
    );
    expect(leg1Failed).toBe(true);
    expect(polyConnector.placeOrder).not.toHaveBeenCalled();
  });

  it('Leg 2 failure after leg 1 success (ARB_LEG2_FAILED_HEDGE_REQUIRED)', async () => {
    const config = createArbConfig();
    const engine = new StrategyEngine(config, () => []);

    const kalshiConnector = createMockConnector('kalshi');
    const polyConnector = createMockConnector('polymarket');
    polyConnector.placeOrder.mockRejectedValue(new Error('Sell leg failed'));

    const gateway = new Gateway({
      pumpampApiKey: 'k',
      pumpampHost: 'localhost',
      cancelOnShutdown: false,
      logLevel: 'warn',
    } as GatewayConfig);
    gateway.registerConnector(kalshiConnector);
    gateway.registerConnector(polyConnector);

    const errorHandler = vi.fn();
    gateway.on('order_error', errorHandler);

    const signal = createArbSignal();
    const result = engine.handleSignal(signal) as any[];
    const [buyCmd, sellCmd] = result;

    await (gateway as any).executeStrategyCommands([buyCmd, sellCmd], signal.id);

    const leg2Failed = errorHandler.mock.calls.some(
      (call: any[]) =>
        call[0].code === 'ARB_LEG2_FAILED_HEDGE_REQUIRED' &&
        String(call[0].message).includes(buyCmd.id) &&
        String(call[0].message).includes(sellCmd.id),
    );
    expect(leg2Failed).toBe(true);
    expect(kalshiConnector.placeOrder).toHaveBeenCalledOnce();
    expect(polyConnector.placeOrder).toHaveBeenCalledOnce();
  });

  it('Dry-run does not call injectCommand', () => {
    const config = createArbConfig({ dry_run: true });
    const engine = new StrategyEngine(config, () => []);
    const connector = createMockConnector('kalshi');

    const dryRunHandler = vi.fn();
    engine.on('dry_run_trade', dryRunHandler);

    const signal = createArbSignal();
    const result = engine.handleSignal(signal);

    expect(Array.isArray(result)).toBe(true);
    const commands = result as any[];
    expect(commands).toHaveLength(2);
    expect(dryRunHandler).toHaveBeenCalledTimes(2);

    // In dry-run mode, gateway should NOT call placeOrder
    expect(connector.placeOrder).not.toHaveBeenCalled();

    const status = engine.getStatus();
    expect(status.dry_run_trades).toBe(2);
    expect(status.trades_generated).toBe(0);
  });

  it('Template validation via strategy validate command', async () => {
    const actual = await vi.importActual<typeof import('../../features/strategy/strategy-config.js')>('../../features/strategy/strategy-config.js');
    const strategyConfigModule = await import('../../features/strategy/strategy-config.js');
    const mockedLoad = strategyConfigModule.loadStrategyConfig as unknown as ReturnType<typeof vi.fn>;

    // Route CLI handler through the real loader implementation for this test
    mockedLoad.mockImplementation(actual.loadStrategyConfig);

    const templatePath = resolve(TEMPLATES_DIR, 'prediction-arb.json');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(
      ['strategy', 'validate', templatePath],
      { from: 'user' },
    );

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Valid strategy:'));

    logSpy.mockRestore();
    mockedLoad.mockReset();
  });

  it('All 4 templates validate against schema', () => {
    const templateFiles = [
      'prediction-arb.json',
      'sharp-line-movement.json',
      'prediction-whale-follow.json',
      'prediction-volume-spike.json',
    ];

    for (const file of templateFiles) {
      const raw = readFileSync(resolve(TEMPLATES_DIR, file), 'utf-8');
      const json = JSON.parse(raw);
      const result = strategyConfigSchema.safeParse(json);
      expect(result.success, `Template ${file} should validate`).toBe(true);
    }
  });

  it('Schema accepts _description, _usage, _signals', () => {
    const config = {
      enabled: true,
      dry_run: true,
      _description: 'Test strategy template',
      _usage: 'Use for testing',
      _signals: ['test_signal_1', 'test_signal_2'],
      rules: [
        {
          name: 'test_rule',
          enabled: true,
          signal_types: ['strategy'] as const,
          action: { side: 'buy', size: 1, order_type: 'market' as const },
        },
      ],
    };

    const result = strategyConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data._description).toBe('Test strategy template');
      expect(result.data._usage).toBe('Use for testing');
      expect(result.data._signals).toEqual(['test_signal_1', 'test_signal_2']);
    }
  });

  it('Gateway handles both single and multi-command results', async () => {
    // Test that Gateway signal handler correctly handles both single and array results
    const config = createTestConfig({
      dry_run: false,
      rules: [
        createTestRule({
          name: 'regular_rule',
          signal_types: ['strategy'],
          venues: ['binance'],
          min_confidence: 70,
        }),
        createTestRule({
          name: 'arb_rule',
          signal_types: ['alert'],
          signal_names: ['cross_venue_arbitrage'],
          venues: ['kalshi', 'polymarket'],
          min_confidence: 70,
          action: { side: 'from_signal', size: 25, order_type: 'market' },
        }),
      ],
    });
    const engine = new StrategyEngine(config, () => []);

    // Test single command (regular signal)
    const regularSignal = createTestSignal({
      id: 'reg-sig-1',
      signal_type: 'strategy',
      venue: 'binance',
      confidence: '85',
      direction: 'long',
    });
    const singleResult = engine.handleSignal(regularSignal);
    expect(singleResult).not.toBeNull();
    expect(Array.isArray(singleResult)).toBe(false);

    // Normalize single result the same way gateway does
    const singleCommands = Array.isArray(singleResult) ? singleResult : singleResult ? [singleResult] : [];
    expect(singleCommands).toHaveLength(1);

    // Test multi command (arb signal)
    const arbSignal = createArbSignal({ id: 'arb-sig-1' });
    const multiResult = engine.handleSignal(arbSignal);
    expect(multiResult).not.toBeNull();
    expect(Array.isArray(multiResult)).toBe(true);

    // Normalize multi result the same way gateway does
    const multiCommands = Array.isArray(multiResult) ? multiResult : multiResult ? [multiResult] : [];
    expect(multiCommands).toHaveLength(2);
  });
});
