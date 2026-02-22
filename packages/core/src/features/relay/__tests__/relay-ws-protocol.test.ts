// RelayClient WebSocket protocol auto-detection (ws:// vs wss://)
// Tests the isPlainWsHost() logic indirectly via buildWebSocketUrl()

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { MockWebSocket } = vi.hoisted(() => {
  const { EventEmitter: EE } = require('events');

  class MockWebSocket extends EE {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readyState = 1;
    url: string;

    send = vi.fn();
    close = vi.fn();

    constructor(url: string) {
      super();
      this.url = url;
      MockWebSocket.instances.push(this);
    }

    static reset(): void {
      MockWebSocket.instances = [];
    }
  }

  return { MockWebSocket };
});

vi.mock('ws', () => {
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

vi.mock('pino', () => {
  const noop = () => {};
  const logger: Record<string, unknown> = {
    info: noop, warn: noop, error: noop, debug: noop, trace: noop,
    child: () => logger,
  };
  return { default: () => logger };
});

import { RelayClient } from '../relay-client.js';

function latestWs(): InstanceType<typeof MockWebSocket> {
  const ws = MockWebSocket.instances.at(-1);
  if (!ws) throw new Error('No MockWebSocket instance created');
  return ws;
}

beforeEach(() => {
  MockWebSocket.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WebSocket protocol auto-detection', () => {
  it('uses wss:// for external domain (relay.pumpamp.com)', () => {
    const client = new RelayClient({
      host: 'relay.pumpamp.com',
      apiKey: 'pa_live_test',
      pairingCode: 'ABC123',
    });
    client.connect();
    expect(latestWs().url).toMatch(/^wss:\/\/relay\.pumpamp\.com\//);
    client.disconnect();
  });

  it('uses ws:// for localhost', () => {
    const client = new RelayClient({
      host: 'localhost',
      apiKey: 'pa_live_test',
      pairingCode: 'ABC123',
    });
    client.connect();
    expect(latestWs().url).toMatch(/^ws:\/\/localhost\//);
    client.disconnect();
  });

  it('uses ws:// for localhost with port', () => {
    const client = new RelayClient({
      host: 'localhost:3000',
      apiKey: 'pa_live_test',
      pairingCode: 'ABC123',
    });
    client.connect();
    expect(latestWs().url).toMatch(/^ws:\/\/localhost:3000\//);
    client.disconnect();
  });

  it('uses ws:// for 127.0.0.1 loopback', () => {
    const client = new RelayClient({
      host: '127.0.0.1:8080',
      apiKey: 'pa_live_test',
      pairingCode: 'ABC123',
    });
    client.connect();
    expect(latestWs().url).toMatch(/^ws:\/\/127\.0\.0\.1:8080\//);
    client.disconnect();
  });

  it('uses ws:// for 10.x.x.x private range', () => {
    const client = new RelayClient({
      host: '10.0.0.1',
      apiKey: 'pa_live_test',
      pairingCode: 'ABC123',
    });
    client.connect();
    expect(latestWs().url).toMatch(/^ws:\/\/10\.0\.0\.1\//);
    client.disconnect();
  });

  it('uses ws:// for 192.168.x.x private range', () => {
    const client = new RelayClient({
      host: '192.168.1.100:9000',
      apiKey: 'pa_live_test',
      pairingCode: 'ABC123',
    });
    client.connect();
    expect(latestWs().url).toMatch(/^ws:\/\/192\.168\.1\.100:9000\//);
    client.disconnect();
  });

  it('uses ws:// for 100.x.x.x Tailscale CGNAT range', () => {
    const client = new RelayClient({
      host: '100.64.0.1',
      apiKey: 'pa_live_test',
      pairingCode: 'ABC123',
    });
    client.connect();
    expect(latestWs().url).toMatch(/^ws:\/\/100\.64\.0\.1\//);
    client.disconnect();
  });

  it('uses ws:// for 172.16-31.x.x private range', () => {
    const client = new RelayClient({
      host: '172.16.0.5',
      apiKey: 'pa_live_test',
      pairingCode: 'ABC123',
    });
    client.connect();
    expect(latestWs().url).toMatch(/^ws:\/\/172\.16\.0\.5\//);
    client.disconnect();
  });

  it('uses wss:// for 172.32.x.x (outside private range)', () => {
    const client = new RelayClient({
      host: '172.32.0.1',
      apiKey: 'pa_live_test',
      pairingCode: 'ABC123',
    });
    client.connect();
    expect(latestWs().url).toMatch(/^wss:\/\/172\.32\.0\.1\//);
    client.disconnect();
  });

  it('preserves explicit ws:// scheme', () => {
    const client = new RelayClient({
      host: 'ws://custom.host.com',
      apiKey: 'pa_live_test',
      pairingCode: 'ABC123',
    });
    client.connect();
    expect(latestWs().url).toMatch(/^ws:\/\/custom\.host\.com\//);
    client.disconnect();
  });

  it('preserves explicit wss:// scheme', () => {
    const client = new RelayClient({
      host: 'wss://secure.host.com',
      apiKey: 'pa_live_test',
      pairingCode: 'ABC123',
    });
    client.connect();
    expect(latestWs().url).toMatch(/^wss:\/\/secure\.host\.com\//);
    client.disconnect();
  });

  it('throws when neither pairingId nor pairingCode provided', () => {
    const client = new RelayClient({
      host: 'relay.pumpamp.com',
      apiKey: 'pa_live_test',
    });
    expect(() => client.connect()).toThrow('requires either pairingId or pairingCode');
  });
});
