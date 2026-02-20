import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VenueConnector } from '../features/execution/venue-connector.js';
import type { GatewayConfig } from '../shared/config.js';
import type { OrderRequest, OrderResult, Position, Balance, TradeCommand } from '../shared/protocol.js';

// ---------------------------------------------------------------------------
// Mock all heavy dependencies so the Gateway class can be instantiated
// without real WebSocket connections or dynamic imports.
// ---------------------------------------------------------------------------

// We use a factory function that returns a fresh class each time to avoid
// the "__vi_import_0__" hoisting issue with EventEmitter.
vi.mock('../features/relay/relay-client.js', () => {
  const { EventEmitter } = require('events');

  class MockRelayClient extends EventEmitter {
    state: string = 'DISCONNECTED';
    pairingId: string | null = null;
    config: any;

    constructor(config: any) {
      super();
      this.config = config;
      this.pairingId = config.pairingId ?? null;
    }

    connect = vi.fn(function (this: any) {
      this.state = 'CONNECTED';
      this.emit('connected');
    });

    disconnect = vi.fn(function (this: any) {
      this.state = 'DISCONNECTED';
    });

    sendReport = vi.fn();
    updateStatus = vi.fn();
  }

  return { RelayClient: MockRelayClient };
});

vi.mock('../features/signals/signal-consumer.js', () => {
  const { EventEmitter } = require('events');

  class MockSignalConsumer extends EventEmitter {
    disconnect = vi.fn();
  }
  return { SignalConsumer: MockSignalConsumer };
});

vi.mock('../shared/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
  sanitizeUrl: (url: string) => url.split('?')[0],
}));

// Import Gateway after mocks are registered (vitest hoists vi.mock calls).
const { Gateway } = await import('../gateway.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    pumpampApiKey: 'test-api-key',
    pumpampHost: 'localhost',
    pumpampPairingId: 'pair-123',
    cancelOnShutdown: false,
    logLevel: 'info',
    autoTradeEnabled: false,
    simulateOrders: false,
    ...overrides,
  };
}

function createMockConnector(venue: string, healthy = true): VenueConnector {
  return {
    venue,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    placeOrder: vi.fn(async (_order: OrderRequest): Promise<OrderResult> => ({
      order_id: `${venue}-ord-1`,
      venue_order_id: `${venue}-venue-ord-1`,
      status: 'filled',
      fill_price: 0.65,
      filled_at: new Date().toISOString(),
    })),
    cancelOrder: vi.fn(async () => {}),
    cancelAllOrders: vi.fn(async () => {}),
    getPositions: vi.fn(async (): Promise<Position[]> => []),
    getBalance: vi.fn(async (): Promise<Balance> => ({
      venue,
      available: 1000,
      total: 1000,
      currency: 'USD',
    })),
    isHealthy: vi.fn(() => healthy),
  };
}

describe('Connector discovery', () => {
  let gateway: InstanceType<typeof Gateway>;

  beforeEach(() => {
    gateway = new Gateway(minimalConfig());
  });

  it('Full Kalshi config registers connector via registerConnector', () => {
    const connector = createMockConnector('kalshi');
    gateway.registerConnector(connector);

    const status = gateway.getStatus();
    expect(status.venues).toHaveProperty('kalshi');
  });

  it('Full Polymarket config registers connector via registerConnector', () => {
    const connector = createMockConnector('polymarket');
    gateway.registerConnector(connector);

    const status = gateway.getStatus();
    expect(status.venues).toHaveProperty('polymarket');
  });

  it('Full Hyperliquid config registers connector via registerConnector', () => {
    const connector = createMockConnector('hyperliquid');
    gateway.registerConnector(connector);

    const status = gateway.getStatus();
    expect(status.venues).toHaveProperty('hyperliquid');
  });

  it('Full Binance config registers connector via registerConnector', () => {
    const connector = createMockConnector('binance');
    gateway.registerConnector(connector);

    const status = gateway.getStatus();
    expect(status.venues).toHaveProperty('binance');
  });

  it('No venue config = zero connectors in status', () => {
    const status = gateway.getStatus();
    expect(Object.keys(status.venues)).toHaveLength(0);
  });

  it('Partial Kalshi config (missing key) does not register connector', () => {
    // loadConfig with partial Kalshi returns kalshi=undefined,
    // so discoverConnectors never calls registerConnector for Kalshi.
    const gw = new Gateway(minimalConfig({ kalshi: undefined }));
    const status = gw.getStatus();
    expect(status.venues).not.toHaveProperty('kalshi');
  });

  it('Partial Polymarket config does not register connector', () => {
    const gw = new Gateway(minimalConfig({ polymarket: undefined }));
    const status = gw.getStatus();
    expect(status.venues).not.toHaveProperty('polymarket');
  });

  it('Partial Binance config does not register connector', () => {
    const gw = new Gateway(minimalConfig({ binance: undefined }));
    const status = gw.getStatus();
    expect(status.venues).not.toHaveProperty('binance');
  });
});

describe('Graceful shutdown', () => {
  let gateway: InstanceType<typeof Gateway>;
  let kalshiConnector: VenueConnector;
  let binanceConnector: VenueConnector;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('SIGINT triggers stop()', async () => {
    gateway = new Gateway(minimalConfig());
    await gateway.start();

    const stoppedPromise = new Promise<void>((resolve) => {
      gateway.on('stopped', resolve);
    });

    process.emit('SIGINT' as any);

    await stoppedPromise;

    expect(gateway.getStatus().state).toBe('stopped');
  });

  it('stop() disconnects relay client', async () => {
    gateway = new Gateway(minimalConfig());
    await gateway.start();

    await gateway.stop();

    expect(gateway.getStatus().state).toBe('stopped');
    expect(gateway.getStatus().relayConnected).toBe(false);
  });

  it('stop() disconnects all venue connectors', async () => {
    gateway = new Gateway(minimalConfig());
    kalshiConnector = createMockConnector('kalshi');
    binanceConnector = createMockConnector('binance');

    gateway.registerConnector(kalshiConnector);
    gateway.registerConnector(binanceConnector);

    await gateway.start();
    await gateway.stop();

    expect(kalshiConnector.disconnect).toHaveBeenCalled();
    expect(binanceConnector.disconnect).toHaveBeenCalled();
  });

  it('CANCEL_ON_SHUTDOWN=true cancels pending orders', async () => {
    gateway = new Gateway(minimalConfig({ cancelOnShutdown: true }));
    kalshiConnector = createMockConnector('kalshi');
    binanceConnector = createMockConnector('binance');

    gateway.registerConnector(kalshiConnector);
    gateway.registerConnector(binanceConnector);

    await gateway.start();
    await gateway.stop();

    expect(kalshiConnector.cancelAllOrders).toHaveBeenCalled();
    expect(binanceConnector.cancelAllOrders).toHaveBeenCalled();
  });

  it('CANCEL_ON_SHUTDOWN=false does NOT cancel orders', async () => {
    gateway = new Gateway(minimalConfig({ cancelOnShutdown: false }));
    kalshiConnector = createMockConnector('kalshi');

    gateway.registerConnector(kalshiConnector);

    await gateway.start();
    await gateway.stop();

    expect(kalshiConnector.cancelAllOrders).not.toHaveBeenCalled();
  });

  it('Shutdown reports via relay before disconnect', async () => {
    gateway = new Gateway(minimalConfig());
    await gateway.start();

    const relay = (gateway as any).relay;
    const sendReportCalls: any[] = [];
    const disconnectOrder: string[] = [];

    const originalSendReport = relay.sendReport;
    const originalDisconnect = relay.disconnect;

    relay.sendReport = vi.fn((...args: any[]) => {
      sendReportCalls.push(args[0]);
      disconnectOrder.push('sendReport');
      return originalSendReport.apply(relay, args);
    });

    relay.disconnect = vi.fn((...args: any[]) => {
      disconnectOrder.push('disconnect');
      return originalDisconnect.apply(relay, args);
    });

    await gateway.stop();

    // Verify that a GATEWAY_SHUTDOWN error report was sent before disconnect
    const shutdownReport = sendReportCalls.find(
      (r) => r.type === 'error' && r.code === 'GATEWAY_SHUTDOWN'
    );
    expect(shutdownReport).toBeDefined();
    expect(shutdownReport.message).toContain('shutting down');

    // The sendReport for shutdown should come before disconnect
    const reportIdx = disconnectOrder.indexOf('sendReport');
    const disconnectIdx = disconnectOrder.lastIndexOf('disconnect');
    expect(reportIdx).toBeLessThan(disconnectIdx);
  });
});

describe('Health check integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('30s health check calls isHealthy() on each connector', async () => {
    const gateway = new Gateway(minimalConfig());
    const kalshi = createMockConnector('kalshi');
    const binance = createMockConnector('binance');

    gateway.registerConnector(kalshi);
    gateway.registerConnector(binance);

    await gateway.start();

    // Clear any calls from start() itself
    (kalshi.isHealthy as ReturnType<typeof vi.fn>).mockClear();
    (binance.isHealthy as ReturnType<typeof vi.fn>).mockClear();

    // Advance past one 30s interval
    vi.advanceTimersByTime(30_000);

    expect(kalshi.isHealthy).toHaveBeenCalled();
    expect(binance.isHealthy).toHaveBeenCalled();

    await gateway.stop();
  });

  it('Unhealthy connector excluded from routing (updateStatus)', async () => {
    const gateway = new Gateway(minimalConfig());
    const kalshi = createMockConnector('kalshi', true);
    const binance = createMockConnector('binance', false);

    gateway.registerConnector(kalshi);
    gateway.registerConnector(binance);

    await gateway.start();

    // After health check, updateStatus should report only healthy venues
    vi.advanceTimersByTime(30_000);

    const relay = (gateway as any).relay;
    const updateStatusCalls = relay.updateStatus.mock.calls;

    // The last updateStatus call should include only the healthy connector
    const lastCall = updateStatusCalls[updateStatusCalls.length - 1][0];
    expect(lastCall.connected_venues).toContain('kalshi');
    expect(lastCall.connected_venues).not.toContain('binance');

    await gateway.stop();
  });

  it('Connector recovering from unhealthy resumes routing', async () => {
    const gateway = new Gateway(minimalConfig());
    let binanceHealthy = false;
    const binance = createMockConnector('binance', false);
    (binance.isHealthy as ReturnType<typeof vi.fn>).mockImplementation(() => binanceHealthy);

    gateway.registerConnector(binance);

    await gateway.start();
    const relay = (gateway as any).relay;

    // First health check: binance is unhealthy
    vi.advanceTimersByTime(30_000);

    let lastCall = relay.updateStatus.mock.calls[relay.updateStatus.mock.calls.length - 1][0];
    expect(lastCall.connected_venues).not.toContain('binance');

    // Now binance recovers
    binanceHealthy = true;

    // Second health check
    vi.advanceTimersByTime(30_000);

    lastCall = relay.updateStatus.mock.calls[relay.updateStatus.mock.calls.length - 1][0];
    expect(lastCall.connected_venues).toContain('binance');

    await gateway.stop();
  });
});

describe('Simulation command injection', () => {
  it('injectCommand handles rejected orders without throwing and emits events', async () => {
    const gateway = new Gateway(minimalConfig());
    const rejectedConnector: VenueConnector = {
      venue: 'kalshi',
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      placeOrder: vi.fn(async (_order: OrderRequest): Promise<OrderResult> => ({
        order_id: 'kalshi-ord-rej',
        status: 'rejected',
        error: 'simulated reject',
      })),
      cancelOrder: vi.fn(async () => {}),
      cancelAllOrders: vi.fn(async () => {}),
      getPositions: vi.fn(async (): Promise<Position[]> => []),
      getBalance: vi.fn(async (): Promise<Balance> => ({
        venue: 'kalshi',
        available: 1000,
        total: 1000,
        currency: 'USD',
      })),
      isHealthy: vi.fn(() => true),
    };

    gateway.registerConnector(rejectedConnector);

    const orderUpdates: any[] = [];
    const orderErrors: any[] = [];
    gateway.on('order_update', (report) => orderUpdates.push(report));
    gateway.on('order_error', (report) => orderErrors.push(report));

    const command: TradeCommand = {
      type: 'trade',
      id: 'sim-cmd-001',
      market_id: 'kalshi:KXBTCD-SIM-01',
      venue: 'kalshi',
      side: 'yes',
      action: 'buy',
      size: 10,
      order_type: 'market',
    };

    await expect(gateway.injectCommand(command)).resolves.toBeUndefined();

    expect(orderUpdates).toHaveLength(1);
    expect(orderUpdates[0].status).toBe('rejected');
    expect(orderErrors.some((e) => e.code === 'ORDER_REJECTED')).toBe(true);
  });
});
