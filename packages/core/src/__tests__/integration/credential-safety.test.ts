import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import type { AddressInfo } from 'net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { createLogger, sanitizeUrl } from '../../shared/logger.js';

// ---------------------------------------------------------------------------
// __dirname equivalent for ESM
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  return new Promise((resolveServer) => {
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
      resolveServer({
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Sensitive values that should NEVER appear in any outbound WS message.
 */
const SENSITIVE_VALUES = [
  'kalshi-api-key-secret-123',
  '/home/user/.kalshi/key.pem',
  '0xdeadbeef_polymarket_private_key',
  'poly-secret-value',
  'poly-passphrase-value',
  '0xhyperliquid_private_key_secret',
  'binance-api-key-secret-456',
  'binance-api-secret-789',
  'pumpamp-api-key-secret-xxx',
];

/**
 * Capture pino output into a string buffer for inspection.
 */
function createLogCapture(): { stream: Writable; getAll: () => string } {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      callback();
    },
  });
  return {
    stream,
    getAll: () => buffer,
  };
}

describe('Credential Safety', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await createTestServer();
  });

  afterEach(async () => {
    await server.close();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('Relay WS outbound payloads never contain exchange API keys', async () => {
    // Use the RelayClient directly to send various reports and verify
    // that no sensitive data leaks into the wire format.
    const { RelayClient } = await import('../../features/relay/relay-client.js');

    const client = new RelayClient({
      host: `localhost:${server.port}`,
      apiKey: 'pumpamp-api-key-secret-xxx',
      pairingId: 'pair-cred-001',
    });

    // Patch for ws:// instead of wss://
    (client as any).buildWebSocketUrl = function () {
      return `ws://localhost:${server.port}/api/v1/relay?api_key=test-api-key&pairing_id=${this._pairingId}`;
    };

    const connPromise = server.waitForConnection();
    client.connect();
    await connPromise;
    await sleep(100);

    // Send various reports
    client.sendReport({
      type: 'heartbeat',
      uptime_secs: 100,
      version: '0.1.0',
      strategy_status: 'active',
      connected_venues: ['kalshi', 'binance'],
      open_orders: 0,
      open_positions: 0,
    });

    client.sendReport({
      type: 'order_update',
      order_id: 'ord-001',
      venue: 'kalshi',
      market_id: 'BTC-100K',
      status: 'filled',
      side: 'yes',
      action: 'buy',
      size: 10,
      fill_price: 0.72,
    });

    await sleep(200);

    // Check ALL messages sent over the wire
    const allPayloads = server.received.join(' ');
    for (const sensitive of SENSITIVE_VALUES) {
      expect(allPayloads).not.toContain(sensitive);
    }

    client.disconnect();
  });

  it('Relay WS outbound payloads never contain private keys', async () => {
    const { RelayClient } = await import('../../features/relay/relay-client.js');

    const client = new RelayClient({
      host: `localhost:${server.port}`,
      apiKey: 'test-key',
      pairingId: 'pair-privkey-001',
    });

    (client as any).buildWebSocketUrl = function () {
      return `ws://localhost:${server.port}/api/v1/relay?api_key=test&pairing_id=${this._pairingId}`;
    };

    const connPromise = server.waitForConnection();
    client.connect();
    await connPromise;
    await sleep(100);

    // Send a position report and error report
    client.sendReport({
      type: 'position',
      venue: 'polymarket',
      market_id: 'PRES-2026',
      side: 'yes',
      size: 100,
      entry_price: 0.55,
    });

    client.sendReport({
      type: 'error',
      code: 'VENUE_UNHEALTHY',
      venue: 'hyperliquid',
      message: 'Connection timeout',
    });

    await sleep(200);

    const allPayloads = server.received.join(' ');

    // Ensure no private key patterns appear
    expect(allPayloads).not.toContain('0xdeadbeef');
    expect(allPayloads).not.toContain('0xhyperliquid');
    expect(allPayloads).not.toContain('private_key');
    expect(allPayloads).not.toContain('privateKey');

    client.disconnect();
  });

  it('Relay WS outbound payloads never contain signatures', async () => {
    const { RelayClient } = await import('../../features/relay/relay-client.js');

    const client = new RelayClient({
      host: `localhost:${server.port}`,
      apiKey: 'test-key',
      pairingId: 'pair-sig-001',
    });

    (client as any).buildWebSocketUrl = function () {
      return `ws://localhost:${server.port}/api/v1/relay?api_key=test&pairing_id=${this._pairingId}`;
    };

    const connPromise = server.waitForConnection();
    client.connect();
    await connPromise;
    await sleep(100);

    client.sendReport({
      type: 'order_update',
      order_id: 'ord-sig-001',
      venue: 'kalshi',
      market_id: 'BTC-100K',
      status: 'filled',
      side: 'yes',
      action: 'buy',
      size: 5,
    });

    await sleep(200);

    const allPayloads = server.received.join(' ');

    expect(allPayloads).not.toContain('signature');
    expect(allPayloads).not.toContain('kalshi-access-signature');

    client.disconnect();
  });

  it('Signal consumer WS outbound payloads never contain exchange secrets', async () => {
    // The SignalConsumer sends only a subscribe message with signal_types/symbols.
    // Verify no credentials leak.
    const signalServer = await createTestServer();

    const { SignalConsumer } = await import('../../features/signals/signal-consumer.js');

    const consumer = new SignalConsumer({
      host: `localhost:${signalServer.port}`,
      apiKey: 'pumpamp-api-key-secret-xxx',
      signalTypes: ['alert'],
      symbols: ['BTC/USDT'],
      minConfidence: 0.7,
    });

    // Patch the URL to use ws:// instead of wss://.
    // Use the top-level WsWebSocket import directly.
    (consumer as any).attemptConnection = function () {
      const url = `ws://localhost:${signalServer.port}/api/v1/public/ws/signals?api_key=test`;
      this.ws = new WsWebSocket(url);
      this.ws.on('open', () => {
        this.reconnectAttempt = 0;
        this.emit('connected');
        this.sendSubscribe();
      });
      this.ws.on('message', (data: any) => {
        this.handleMessage(data);
      });
      this.ws.on('close', () => {
        this.ws = null;
        this.emit('disconnected');
        this.scheduleReconnect();
      });
      this.ws.on('error', (err: Error) => {
        this.emit('error', err);
      });
    };

    const connPromise = signalServer.waitForConnection();
    consumer.connect();
    await connPromise;
    await sleep(200);

    const allPayloads = signalServer.received.join(' ');

    // The subscribe message should NOT contain any exchange secrets
    for (const sensitive of SENSITIVE_VALUES) {
      expect(allPayloads).not.toContain(sensitive);
    }

    // The subscribe message should contain the filter params, not secrets
    const subscribeMsg = signalServer.received.find((r) => {
      try {
        return JSON.parse(r).type === 'subscribe';
      } catch {
        return false;
      }
    });
    expect(subscribeMsg).toBeDefined();

    consumer.disconnect();
    await signalServer.close();
  });

  it('Logger output with sensitive config does not leak secrets', () => {
    const { stream, getAll } = createLogCapture();
    const logger = createLogger('cred-test', { destination: stream, level: 'info' });

    // Log a config-like object with sensitive fields
    logger.info({
      PUMPAMP_API_KEY: 'super-secret-pumpamp-key',
      apiKey: 'exchange-api-key-secret',
      api_secret: 'exchange-api-secret',
      privateKey: '0xdeadbeef_private_key',
      passphrase: 'my-secret-passphrase',
      signature: 'hmac-sha256-signature',
      authorization: 'Bearer eyJtoken',
      // Non-sensitive
      venue: 'kalshi',
      market_id: 'BTC-100K',
    }, 'Config logged');

    const output = getAll();

    // Sensitive fields should be redacted
    expect(output).not.toContain('super-secret-pumpamp-key');
    expect(output).not.toContain('exchange-api-key-secret');
    expect(output).not.toContain('exchange-api-secret');
    expect(output).not.toContain('0xdeadbeef_private_key');
    expect(output).not.toContain('my-secret-passphrase');
    expect(output).not.toContain('hmac-sha256-signature');
    expect(output).not.toContain('Bearer eyJtoken');

    // Non-sensitive fields should be present
    expect(output).toContain('kalshi');
    expect(output).toContain('BTC-100K');
    expect(output).toContain('[REDACTED]');
  });

  it('Logger output for WS URLs has query strings stripped', () => {
    const urls = [
      'wss://api.pumpamp.com/api/v1/relay?api_key=secret123&pairing_id=pair-abc',
      'wss://api.pumpamp.com/api/v1/relay?api_key=secret123&pairing_code=XYZ789',
      'https://trading-api.kalshi.com/v2/orders?signature=hmac_sig&timestamp=123',
    ];

    for (const url of urls) {
      const sanitized = sanitizeUrl(url);
      expect(sanitized).not.toContain('?');
      expect(sanitized).not.toContain('api_key');
      expect(sanitized).not.toContain('secret');
      expect(sanitized).not.toContain('pairing');
      expect(sanitized).not.toContain('signature');
    }

    // Verify the path is preserved
    expect(sanitizeUrl(urls[0])).toBe('wss://api.pumpamp.com/api/v1/relay');
    expect(sanitizeUrl(urls[2])).toBe('https://trading-api.kalshi.com/v2/orders');
  });

  it('Auth headers for exchange requests not in relay messages', async () => {
    const { RelayClient } = await import('../../features/relay/relay-client.js');

    const client = new RelayClient({
      host: `localhost:${server.port}`,
      apiKey: 'test-key',
      pairingId: 'pair-authheader-001',
    });

    (client as any).buildWebSocketUrl = function () {
      return `ws://localhost:${server.port}/api/v1/relay?api_key=test&pairing_id=${this._pairingId}`;
    };

    const connPromise = server.waitForConnection();
    client.connect();
    await connPromise;
    await sleep(100);

    // Send multiple report types
    client.sendReport({
      type: 'heartbeat',
      uptime_secs: 60,
      version: '0.1.0',
      strategy_status: 'active',
      connected_venues: ['kalshi'],
      open_orders: 1,
      open_positions: 0,
    });

    client.sendReport({
      type: 'order_update',
      order_id: 'ord-auth-001',
      venue: 'binance',
      market_id: 'ETH-USDT',
      status: 'submitted',
      side: 'buy',
      action: 'open',
      size: 1,
    });

    await sleep(200);

    const allPayloads = server.received.join(' ');

    // Auth header patterns that should never appear in relay messages
    expect(allPayloads).not.toContain('Authorization');
    expect(allPayloads).not.toContain('x-mbx-apikey');
    expect(allPayloads).not.toContain('kalshi-access-key');
    expect(allPayloads).not.toContain('kalshi-access-signature');
    expect(allPayloads).not.toContain('Bearer');

    client.disconnect();
  });

  it('.env.example and README satisfy hygiene requirements', () => {
    // Navigate from this test file up to the project root.
    // __tests__/integration/ -> __tests__/ -> src/ -> core/ -> packages/ -> root
    const projectRoot = resolve(__dirname, '..', '..', '..', '..', '..');

    // Read .env.example
    const envExample = readFileSync(resolve(projectRoot, '.env.example'), 'utf8');

    // 1. .env.example exists and contains placeholder values (not real secrets)
    expect(envExample).toBeTruthy();

    // 2. All sensitive env vars are present in the example
    const requiredKeys = [
      'PUMPAMP_API_KEY',
      'KALSHI_API_KEY',
      'POLYMARKET_PRIVATE_KEY',
      'BINANCE_API_KEY',
      'BINANCE_API_SECRET',
    ];

    for (const key of requiredKeys) {
      expect(envExample).toContain(key);
    }

    // 3. Placeholder values should be obvious (contain '...', 'your-', 'xxx', '0x...', or be short)
    const lines = envExample.split('\n');
    for (const line of lines) {
      if (line.startsWith('#') || line.trim() === '') continue;

      const eqIndex = line.indexOf('=');
      if (eqIndex === -1) continue;

      const key = line.substring(0, eqIndex).trim();
      const value = line.substring(eqIndex + 1).trim();

      // If it is a sensitive key, the value should look like a placeholder
      if (['API_KEY', 'SECRET', 'PRIVATE_KEY', 'PASSPHRASE'].some((s) => key.includes(s))) {
        const isPlaceholder =
          value === '' ||
          value.includes('...') ||
          value.includes('xxx') ||
          value.includes('your-') ||
          value.includes('0x...') ||
          value.includes('<') ||
          value.length < 30; // Short values are likely placeholders

        expect(isPlaceholder).toBe(true);
      }
    }

    // 4. README exists and mentions security / credential handling
    const readme = readFileSync(resolve(projectRoot, 'README.md'), 'utf8');
    expect(readme).toBeTruthy();

    const readmeLower = readme.toLowerCase();
    const hasSecurityMention =
      readmeLower.includes('secure') ||
      readmeLower.includes('credential') ||
      readmeLower.includes('api key') ||
      readmeLower.includes('your own infrastructure') ||
      readmeLower.includes('under your control');

    expect(hasSecurityMention).toBe(true);
  });
});
