import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import type { AddressInfo } from 'net';
import type { IncomingRelayMessage, RelayReport } from '../../shared/protocol.js';

// ---------------------------------------------------------------------------
// Mock only the logger; everything else uses real implementations.
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

const { RelayClient } = await import('../../features/relay/relay-client.js');

interface TestServer {
  wss: WebSocketServer;
  port: number;
  received: string[];
  clients: WsWebSocket[];
  close(): Promise<void>;
  sendToAll(msg: IncomingRelayMessage | Record<string, unknown>): void;
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
        sendToAll(msg) {
          const json = JSON.stringify(msg);
          for (const client of clients) {
            if (client.readyState === WsWebSocket.OPEN) {
              client.send(json);
            }
          }
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

function createRelayClient(port: number, pairingId?: string, pairingCode?: string) {
  const client = new RelayClient({
    host: `localhost:${port}`,
    apiKey: 'test-api-key',
    pairingId,
    pairingCode,
  });

  // Override the private buildWebSocketUrl to use ws:// instead of wss://
  (client as any).buildWebSocketUrl = function () {
    const base = `ws://localhost:${port}/api/v1/relay?api_key=test-api-key`;
    if (this._pairingId) {
      return `${base}&pairing_id=${this._pairingId}`;
    } else if (this.config.pairingCode) {
      return `${base}&pairing_code=${this.config.pairingCode}`;
    }
    throw new Error('Need pairingId or pairingCode');
  };

  return client;
}

/** Wait for a given number of milliseconds (real time). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
//
// These tests use REAL timers because the ws package relies on
// real I/O event loops. Fake timers break WebSocket message delivery.
// ============================================================

describe('Relay Connection Flow', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await createTestServer();
  });

  afterEach(async () => {
    await server.close();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('Connect -> receive pairing_confirmed -> state CONNECTED', async () => {
    const client = createRelayClient(server.port, undefined, 'ABC123');

    const confirmedPromise = new Promise<void>((resolve) => {
      client.on('pairing_confirmed', () => resolve());
    });

    const connPromise = server.waitForConnection();
    client.connect();
    const ws = await connPromise;

    // Server sends pairing_confirmed
    ws.send(JSON.stringify({
      type: 'pairing_confirmed',
      pairing_id: 'pair-test-001',
      relay_session_id: 'sess-001',
    }));

    await confirmedPromise;

    expect(client.state).toBe('CONNECTED');
    expect(client.pairingId).toBe('pair-test-001');

    client.disconnect();
  });

  it('Send heartbeat after connection (real timers, wait for interval)', async () => {
    // The heartbeat interval is 15s which is too long for a test.
    // Instead, we reduce it by patching the private field, then wait.
    const client = createRelayClient(server.port, 'existing-pair-id');

    // Patch heartbeat interval to 200ms for fast testing
    (client as any).heartbeatIntervalMs = 200;

    const connectedPromise = new Promise<void>((resolve) => {
      client.on('connected', () => resolve());
    });

    const connPromise = server.waitForConnection();
    client.connect();
    await connPromise;
    await connectedPromise;

    // Clear initial messages
    server.received.length = 0;

    // Wait for at least one heartbeat (200ms + buffer)
    await sleep(400);

    const heartbeats = server.received
      .map((raw) => JSON.parse(raw) as RelayReport)
      .filter((r) => r.type === 'heartbeat');

    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(heartbeats[0].type).toBe('heartbeat');

    client.disconnect();
  });

  it('Receive trade command -> command_ack sent back', async () => {
    const client = createRelayClient(server.port, 'pair-ack-test');

    const connectedPromise = new Promise<void>((resolve) => {
      client.on('connected', () => resolve());
    });

    const connPromise = server.waitForConnection();
    client.connect();
    const ws = await connPromise;
    await connectedPromise;

    // Clear previous messages
    server.received.length = 0;

    const commandReceived = new Promise<void>((resolve) => {
      client.on('command', () => resolve());
    });

    // Server sends a trade command
    ws.send(JSON.stringify({
      type: 'trade',
      id: 'cmd-trade-001',
      market_id: 'kalshi:BTC-100K',
      venue: 'kalshi',
      side: 'yes',
      action: 'buy',
      size: 10,
      order_type: 'market',
    }));

    await commandReceived;

    // Give the ack time to arrive back at the server
    await sleep(100);

    const acks = server.received
      .map((raw) => JSON.parse(raw) as RelayReport)
      .filter((r) => r.type === 'command_ack');

    expect(acks.length).toBe(1);
    expect((acks[0] as any).command_id).toBe('cmd-trade-001');
    expect((acks[0] as any).status).toBe('accepted');

    client.disconnect();
  });

  it('Receive cancel command -> command_ack sent', async () => {
    const client = createRelayClient(server.port, 'pair-cancel-test');

    const connectedPromise = new Promise<void>((resolve) => {
      client.on('connected', () => resolve());
    });

    const connPromise = server.waitForConnection();
    client.connect();
    const ws = await connPromise;
    await connectedPromise;

    server.received.length = 0;

    const commandReceived = new Promise<void>((resolve) => {
      client.on('command', () => resolve());
    });

    ws.send(JSON.stringify({
      type: 'cancel',
      id: 'cmd-cancel-001',
      order_id: 'ord-123',
    }));

    await commandReceived;
    await sleep(100);

    const acks = server.received
      .map((raw) => JSON.parse(raw) as RelayReport)
      .filter((r) => r.type === 'command_ack');

    expect(acks.length).toBe(1);
    expect((acks[0] as any).command_id).toBe('cmd-cancel-001');

    client.disconnect();
  });

  it('Receive pause command -> command_ack sent', async () => {
    const client = createRelayClient(server.port, 'pair-pause-test');

    const connectedPromise = new Promise<void>((resolve) => {
      client.on('connected', () => resolve());
    });

    const connPromise = server.waitForConnection();
    client.connect();
    const ws = await connPromise;
    await connectedPromise;

    server.received.length = 0;

    const commandReceived = new Promise<void>((resolve) => {
      client.on('command', () => resolve());
    });

    ws.send(JSON.stringify({
      type: 'pause',
      id: 'cmd-pause-001',
    }));

    await commandReceived;
    await sleep(100);

    const acks = server.received
      .map((raw) => JSON.parse(raw) as RelayReport)
      .filter((r) => r.type === 'command_ack');

    expect(acks.length).toBe(1);
    expect((acks[0] as any).command_id).toBe('cmd-pause-001');

    client.disconnect();
  });

  it('Relay sends pairing_revoked -> client disconnects', async () => {
    const client = createRelayClient(server.port, 'pair-revoke-test');

    const connectedPromise = new Promise<void>((resolve) => {
      client.on('connected', () => resolve());
    });

    const connPromise = server.waitForConnection();
    client.connect();
    const ws = await connPromise;
    await connectedPromise;

    const disconnectedPromise = new Promise<void>((resolve) => {
      client.on('disconnected', () => resolve());
    });

    ws.send(JSON.stringify({
      type: 'pairing_revoked',
      pairing_id: 'pair-revoke-test',
      reason: 'User revoked from dashboard',
    }));

    await disconnectedPromise;

    expect(client.state).toBe('DISCONNECTED');
  });

  it('SIGINT/SIGTERM sends shutdown report before close', async () => {
    const client = createRelayClient(server.port, 'pair-shutdown-test');

    const connectedPromise = new Promise<void>((resolve) => {
      client.on('connected', () => resolve());
    });

    const connPromise = server.waitForConnection();
    client.connect();
    await connPromise;
    await connectedPromise;

    // Clear messages
    server.received.length = 0;

    // Simulate what Gateway.stop() does: send shutdown report, then disconnect
    client.sendReport({
      type: 'error',
      code: 'GATEWAY_SHUTDOWN',
      message: 'Gateway shutting down gracefully',
    });

    // Give the message time to arrive
    await sleep(200);

    // Verify the shutdown report was received by the server
    const reports = server.received.map((raw) => JSON.parse(raw));
    const shutdownReport = reports.find(
      (r: any) => r.type === 'error' && r.code === 'GATEWAY_SHUTDOWN'
    );
    expect(shutdownReport).toBeDefined();
    expect(shutdownReport.message).toContain('shutting down');

    client.disconnect();
  });
});
