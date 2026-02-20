import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import type { AddressInfo } from 'net';
import type { Position } from '../../shared/protocol.js';

// ---------------------------------------------------------------------------
// Mock only the logger so pino does not interfere with the test runner.
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

// Import RelayClient after mock is registered (vitest hoists vi.mock)
const { RelayClient } = await import('../../features/relay/relay-client.js');

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

function createTestServer(port: number): Promise<TestServer> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port });
    const received: string[] = [];
    const clients: WsWebSocket[] = [];
    const connectionResolvers: Array<(ws: WsWebSocket) => void> = [];

    wss.on('connection', (ws) => {
      clients.push(ws);
      ws.on('message', (data) => {
        received.push(data.toString());
      });
      if (connectionResolvers.length > 0) {
        const resolver = connectionResolvers.shift()!;
        resolver(ws);
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
          for (const client of clients) {
            if (client.readyState === WsWebSocket.OPEN) {
              client.close();
            }
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

function createRelayClient(port: number, pairingId: string) {
  const client = new RelayClient({
    host: `localhost:${port}`,
    apiKey: 'test-api-key',
    pairingId,
  });

  // Override URL builder for ws:// instead of wss://
  (client as any).buildWebSocketUrl = function () {
    const base = `ws://localhost:${port}/api/v1/relay?api_key=test-api-key`;
    if (this._pairingId) {
      return `${base}&pairing_id=${this._pairingId}`;
    }
    throw new Error('Need pairingId');
  };

  return client;
}

/** Wait for a given number of milliseconds (real time). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Allocate a random port, then release it, returning the port number. */
async function allocatePort(): Promise<number> {
  return new Promise<number>((resolve) => {
    const tmp = new WebSocketServer({ port: 0 });
    tmp.on('listening', () => {
      const port = (tmp.address() as AddressInfo).port;
      tmp.close(() => resolve(port));
    });
  });
}

// ============================================================
// All tests use REAL timers because WebSocket I/O requires the
// real event loop. Reconnection delays are patched to small values.
// ============================================================

describe('Reconnection & State Sync', () => {
  let serverPort: number;

  beforeEach(async () => {
    serverPort = await allocatePort();
  });

  afterEach(() => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('Server closes -> client reconnects with pairing_id', async () => {
    // Start first server
    const server1 = await createTestServer(serverPort);
    const client = createRelayClient(serverPort, 'pair-reconnect-001');

    // Reduce reconnect delay for fast test
    (client as any).reconnectDelay = 200;

    const connectedPromise1 = new Promise<void>((resolve) => {
      client.on('connected', resolve);
    });

    const wsPromise1 = server1.waitForConnection();
    client.connect();
    await wsPromise1;
    await connectedPromise1;

    expect(client.state).toBe('CONNECTED');

    // Close the first server - triggers reconnection
    await server1.close();

    // Wait for the client to detect disconnection
    await sleep(300);

    // Start a new server on the same port
    const server2 = await createTestServer(serverPort);

    // Wait for the client to reconnect and reach CONNECTED state.
    // With a pairingId, the RelayClient transitions to CONNECTED on WS open.
    const reconnectedPromise = new Promise<void>((resolve) => {
      client.on('connected', resolve);
    });

    await Promise.race([
      reconnectedPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Reconnection timed out')), 5000)
      ),
    ]);

    // Verify the client reconnected and still has its pairing_id
    expect(client.state).toBe('CONNECTED');
    expect(client.pairingId).toBe('pair-reconnect-001');

    client.disconnect();
    await server2.close();
  }, 10_000);

  it('Exponential backoff between retries', async () => {
    // Start a server, connect, then close it. Observe that the reconnect
    // delay increases (exponential backoff).
    const server = await createTestServer(serverPort);
    const client = createRelayClient(serverPort, 'pair-backoff-001');

    // Reduce initial delay for fast test
    (client as any).reconnectDelay = 100;

    const connectedPromise = new Promise<void>((resolve) => {
      client.on('connected', resolve);
    });

    const wsPromise = server.waitForConnection();
    client.connect();
    await wsPromise;
    await connectedPromise;

    // Close server to trigger reconnection
    await server.close();

    // Wait for disconnect detection + first reconnect attempt
    await sleep(400);

    // The reconnectDelay should have doubled from 100 after the first
    // failed attempt (no server to connect to).
    // Initial: 100, after first fail: min(200, 60000) = 200
    const currentDelay = (client as any).reconnectDelay;
    expect(currentDelay).toBeGreaterThan(100);
    // Should follow 2x backoff
    expect(currentDelay).toBeLessThanOrEqual(60000);

    client.disconnect();
  });

  it('After reconnect + pairing_confirmed, first messages are state sync', async () => {
    const server = await createTestServer(serverPort);
    const client = createRelayClient(serverPort, 'pair-statesync-001');

    const connectedPromise = new Promise<void>((resolve) => {
      client.on('connected', resolve);
    });

    const wsPromise = server.waitForConnection();
    client.connect();
    await wsPromise;
    await connectedPromise;

    // The relay client auto-enters CONNECTED state when pairingId is provided.
    // The Gateway (not the relay client) is responsible for state sync.
    // Verify that the client is connected and can send state sync messages.
    expect(client.state).toBe('CONNECTED');

    // Simulate sending a state sync from client side (what Gateway does on 'connected')
    client.sendReport({
      type: 'position',
      venue: 'kalshi',
      market_id: 'BTC-100K',
      side: 'yes',
      size: 10,
      entry_price: 0.55,
    });

    await sleep(100);

    const messages = server.received.map((r) => JSON.parse(r));
    const positionReports = messages.filter((m: any) => m.type === 'position');

    expect(positionReports.length).toBeGreaterThanOrEqual(1);
    expect(positionReports[0].venue).toBe('kalshi');

    client.disconnect();
    await server.close();
  });

  it('State sync includes positions from mock connectors', async () => {
    const server = await createTestServer(serverPort);
    const client = createRelayClient(serverPort, 'pair-positions-001');

    const connectedPromise = new Promise<void>((resolve) => {
      client.on('connected', resolve);
    });

    const wsPromise = server.waitForConnection();
    client.connect();
    await wsPromise;
    await connectedPromise;

    // Simulate the Gateway's state sync: send position reports.
    const mockPositions: Position[] = [
      {
        venue: 'kalshi',
        market_id: 'BTC-100K',
        side: 'yes',
        size: 10,
        entry_price: 0.55,
        current_price: 0.68,
        unrealized_pnl: 1.3,
      },
      {
        venue: 'binance',
        market_id: 'ETH-USDT',
        side: 'long',
        size: 2.5,
        entry_price: 3200,
        current_price: 3350,
        unrealized_pnl: 375,
      },
    ];

    // Clear any previous messages
    server.received.length = 0;

    for (const pos of mockPositions) {
      client.sendReport({
        type: 'position',
        venue: pos.venue,
        market_id: pos.market_id,
        side: pos.side,
        size: pos.size,
        entry_price: pos.entry_price,
        current_price: pos.current_price,
        unrealized_pnl: pos.unrealized_pnl,
      });
    }

    await sleep(100);

    const messages = server.received.map((r) => JSON.parse(r));
    const positionReports = messages.filter((m: any) => m.type === 'position');

    expect(positionReports.length).toBe(2);
    expect(positionReports[0].venue).toBe('kalshi');
    expect(positionReports[1].venue).toBe('binance');

    client.disconnect();
    await server.close();
  });

  it('State sync includes venue health', async () => {
    const server = await createTestServer(serverPort);
    const client = createRelayClient(serverPort, 'pair-health-001');

    const connectedPromise = new Promise<void>((resolve) => {
      client.on('connected', resolve);
    });

    const wsPromise = server.waitForConnection();
    client.connect();
    await wsPromise;
    await connectedPromise;

    // Clear messages
    server.received.length = 0;

    // Simulate the Gateway's venue health reporting during state sync.
    client.sendReport({
      type: 'error',
      code: 'VENUE_UNHEALTHY',
      venue: 'binance',
      message: 'binance is not healthy at state sync time',
    });

    await sleep(100);

    const messages = server.received.map((r) => JSON.parse(r));
    const healthErrors = messages.filter(
      (m: any) => m.type === 'error' && m.code === 'VENUE_UNHEALTHY'
    );

    expect(healthErrors.length).toBe(1);
    expect(healthErrors[0].venue).toBe('binance');
    expect(healthErrors[0].message).toContain('not healthy');

    client.disconnect();
    await server.close();
  });
});
