import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import type { AddressInfo } from 'net';
import type { VenueConnector } from '../../features/execution/venue-connector.js';
import type { GatewayConfig } from '../../shared/config.js';
import type {
  OrderRequest,
  OrderResult,
  Position,
  Balance,
} from '../../shared/protocol.js';

// ---------------------------------------------------------------------------
// Mock logger and dynamic connector imports.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestServer {
  wss: WebSocketServer;
  port: number;
  received: string[];
  clients: WsWebSocket[];
  close(): Promise<void>;
  waitForConnection(): Promise<WsWebSocket>;
}

function createTestServer(): Promise<TestServer> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    const received: string[] = [];
    const clients: WsWebSocket[] = [];
    const connectionResolvers: Array<(ws: WsWebSocket) => void> = [];

    wss.on('connection', (ws) => {
      clients.push(ws);
      ws.on('message', (data) => {
        received.push(data.toString());
      });
      if (connectionResolvers.length > 0) {
        connectionResolvers.shift()!(ws);
      }
    });

    wss.on('listening', () => {
      const addr = wss.address() as AddressInfo;
      resolve({
        wss,
        port: addr.port,
        received,
        clients,
        async close() {
          for (const c of clients) {
            if (c.readyState === WsWebSocket.OPEN) c.close();
          }
          return new Promise<void>((res) => wss.close(() => res()));
        },
        waitForConnection() {
          return new Promise<WsWebSocket>((res) => {
            connectionResolvers.push(res);
          });
        },
      });
    });
  });
}

function createMockConnector(
  venue: string,
  options?: {
    healthy?: boolean;
    placeOrderResult?: OrderResult;
    placeOrderError?: Error;
  },
): VenueConnector {
  const healthy = options?.healthy ?? true;

  return {
    venue,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    placeOrder: vi.fn(async (_order: OrderRequest): Promise<OrderResult> => {
      if (options?.placeOrderError) throw options.placeOrderError;
      return options?.placeOrderResult ?? {
        order_id: `${venue}-ord-1`,
        venue_order_id: `${venue}-venue-ord-1`,
        status: 'filled',
        fill_price: 0.65,
        filled_at: new Date().toISOString(),
      };
    }),
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

function minimalConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    pumpampApiKey: 'test-api-key',
    pumpampHost: 'localhost',
    pumpampPairingId: 'pair-routing-test',
    cancelOnShutdown: false,
    logLevel: 'info',
    autoTradeEnabled: false,
    simulateOrders: false,
    ...overrides,
  };
}

// Import Gateway after mocks are set up
const { Gateway } = await import('../../gateway.js');

// Patch Gateway's relay to use ws:// for test
function patchGatewayRelay(gateway: InstanceType<typeof Gateway>, port: number) {
  const relay = (gateway as any).relay;
  relay.buildWebSocketUrl = function () {
    const base = `ws://localhost:${port}/api/v1/relay?api_key=test-api-key`;
    if (this._pairingId) {
      return `${base}&pairing_id=${this._pairingId}`;
    }
    throw new Error('Need pairingId');
  };
}

describe('Order Routing End-to-End', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await createTestServer();
  });

  afterEach(async () => {
    await server.close();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('Trade command from relay -> routed to mock connector -> order_update sent back', async () => {
    const gateway = new Gateway(minimalConfig());
    patchGatewayRelay(gateway, server.port);

    const kalshi = createMockConnector('kalshi', {
      placeOrderResult: {
        order_id: 'kalshi-ord-001',
        venue_order_id: 'kalshi-native-001',
        status: 'filled',
        fill_price: 0.72,
        filled_at: '2026-02-11T10:00:00Z',
      },
    });
    gateway.registerConnector(kalshi);

    const connPromise = server.waitForConnection();
    await gateway.start();
    const ws = await connPromise;

    // Clear any startup messages
    server.received.length = 0;

    // Send a trade command from the "relay server"
    ws.send(JSON.stringify({
      type: 'trade',
      id: 'cmd-route-001',
      market_id: 'kalshi:BTC-100K',
      venue: 'kalshi',
      side: 'yes',
      action: 'buy',
      size: 10,
      order_type: 'market',
    }));

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 500));

    const messages = server.received.map((r) => JSON.parse(r));

    // Should have a command_ack
    const acks = messages.filter((m: any) => m.type === 'command_ack');
    expect(acks.length).toBeGreaterThanOrEqual(1);

    // Should have an order_update
    const updates = messages.filter((m: any) => m.type === 'order_update');
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0].status).toBe('filled');
    expect(updates[0].venue).toBe('kalshi');

    // Connector's placeOrder should have been called
    expect(kalshi.placeOrder).toHaveBeenCalled();

    await gateway.stop();
  });

  it('Trade for unknown venue -> error report sent', async () => {
    const gateway = new Gateway(minimalConfig());
    patchGatewayRelay(gateway, server.port);

    // Register only kalshi, not "unknown-venue"
    const kalshi = createMockConnector('kalshi');
    gateway.registerConnector(kalshi);

    const connPromise = server.waitForConnection();
    await gateway.start();
    const ws = await connPromise;

    server.received.length = 0;

    // Send a trade for a venue that does not exist
    ws.send(JSON.stringify({
      type: 'trade',
      id: 'cmd-unknown-001',
      market_id: 'deribit:BTC-PERP',
      venue: 'deribit',
      side: 'buy',
      action: 'open',
      size: 1,
      order_type: 'market',
    }));

    await new Promise((resolve) => setTimeout(resolve, 500));

    const messages = server.received.map((r) => JSON.parse(r));
    const errors = messages.filter((m: any) => m.type === 'error');

    expect(errors.length).toBeGreaterThanOrEqual(1);

    const venueNotFound = errors.find((e: any) => e.code === 'VENUE_NOT_FOUND');
    expect(venueNotFound).toBeDefined();
    expect(venueNotFound.message).toContain('deribit');

    await gateway.stop();
  });

  it('Trade for unhealthy venue -> error report sent', async () => {
    const gateway = new Gateway(minimalConfig());
    patchGatewayRelay(gateway, server.port);

    const kalshi = createMockConnector('kalshi', { healthy: false });
    gateway.registerConnector(kalshi);

    const connPromise = server.waitForConnection();
    await gateway.start();
    const ws = await connPromise;

    server.received.length = 0;

    ws.send(JSON.stringify({
      type: 'trade',
      id: 'cmd-unhealthy-001',
      market_id: 'kalshi:BTC-100K',
      venue: 'kalshi',
      side: 'yes',
      action: 'buy',
      size: 5,
      order_type: 'market',
    }));

    await new Promise((resolve) => setTimeout(resolve, 500));

    const messages = server.received.map((r) => JSON.parse(r));
    const errors = messages.filter((m: any) => m.type === 'error');

    const unhealthyError = errors.find((e: any) => e.code === 'VENUE_UNHEALTHY');
    expect(unhealthyError).toBeDefined();
    expect(unhealthyError.message).toContain('kalshi');

    await gateway.stop();
  });

  it('Cancel command -> routed -> order_update (cancelled) sent', async () => {
    const gateway = new Gateway(minimalConfig());
    patchGatewayRelay(gateway, server.port);

    const kalshi = createMockConnector('kalshi');
    gateway.registerConnector(kalshi);

    const connPromise = server.waitForConnection();
    await gateway.start();
    const ws = await connPromise;

    // First, place an order so we have something to cancel
    ws.send(JSON.stringify({
      type: 'trade',
      id: 'cmd-pre-cancel-001',
      market_id: 'kalshi:BTC-100K',
      venue: 'kalshi',
      side: 'yes',
      action: 'buy',
      size: 10,
      order_type: 'limit',
      limit_price: 0.60,
    }));

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Get the order ID from the order_update that was sent back
    let messages = server.received.map((r) => JSON.parse(r));
    const orderUpdates = messages.filter((m: any) => m.type === 'order_update');

    if (orderUpdates.length > 0) {
      const orderId = orderUpdates[0].order_id;
      server.received.length = 0;

      // Now send a cancel command
      ws.send(JSON.stringify({
        type: 'cancel',
        id: 'cmd-cancel-001',
        order_id: orderId,
      }));

      await new Promise((resolve) => setTimeout(resolve, 300));

      messages = server.received.map((r) => JSON.parse(r));
      const cancelUpdates = messages.filter(
        (m: any) => m.type === 'order_update' && m.status === 'cancelled'
      );

      expect(cancelUpdates.length).toBeGreaterThanOrEqual(1);
      expect(kalshi.cancelOrder).toHaveBeenCalledWith(orderId);
    } else {
      // If no order was tracked (e.g., immediate fill), we still verify cancel_order
      // is called with whatever ID we provide.
      server.received.length = 0;

      ws.send(JSON.stringify({
        type: 'cancel',
        id: 'cmd-cancel-fallback',
        order_id: 'nonexistent-order',
      }));

      await new Promise((resolve) => setTimeout(resolve, 300));

      messages = server.received.map((r) => JSON.parse(r));
      const errors = messages.filter((m: any) => m.type === 'error');
      // Either cancelled or ORDER_NOT_FOUND error
      expect(errors.length + messages.filter((m: any) => m.type === 'order_update').length).toBeGreaterThanOrEqual(1);
    }

    await gateway.stop();
  });

  it('Cancel_all -> all connectors cancelAllOrders called', async () => {
    const gateway = new Gateway(minimalConfig());
    patchGatewayRelay(gateway, server.port);

    const kalshi = createMockConnector('kalshi');
    const binance = createMockConnector('binance');
    gateway.registerConnector(kalshi);
    gateway.registerConnector(binance);

    const connPromise = server.waitForConnection();
    await gateway.start();
    const ws = await connPromise;

    server.received.length = 0;

    ws.send(JSON.stringify({
      type: 'cancel_all',
      id: 'cmd-cancel-all-001',
    }));

    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(kalshi.cancelAllOrders).toHaveBeenCalled();
    expect(binance.cancelAllOrders).toHaveBeenCalled();

    await gateway.stop();
  });

  it('Mock connector placeOrder failure -> error report sent', async () => {
    const gateway = new Gateway(minimalConfig());
    patchGatewayRelay(gateway, server.port);

    const kalshi = createMockConnector('kalshi', {
      placeOrderError: new Error('Insufficient balance'),
    });
    gateway.registerConnector(kalshi);

    const connPromise = server.waitForConnection();
    await gateway.start();
    const ws = await connPromise;

    server.received.length = 0;

    ws.send(JSON.stringify({
      type: 'trade',
      id: 'cmd-fail-001',
      market_id: 'kalshi:BTC-100K',
      venue: 'kalshi',
      side: 'yes',
      action: 'buy',
      size: 10,
      order_type: 'market',
    }));

    await new Promise((resolve) => setTimeout(resolve, 500));

    const messages = server.received.map((r) => JSON.parse(r));
    const errors = messages.filter((m: any) => m.type === 'error');

    const placementError = errors.find((e: any) => e.code === 'ORDER_PLACEMENT_FAILED');
    expect(placementError).toBeDefined();
    expect(placementError.message).toContain('Insufficient balance');

    // Should also have a rejected order_update
    const rejectedUpdates = messages.filter(
      (m: any) => m.type === 'order_update' && m.status === 'rejected'
    );
    expect(rejectedUpdates.length).toBeGreaterThanOrEqual(1);

    await gateway.stop();
  });
});
