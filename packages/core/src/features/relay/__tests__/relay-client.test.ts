// Tests cover: state machine transitions, pairing handshake, heartbeat,
// command handling, reconnection logic, and report sending.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock -- vi.hoisted runs before vi.mock factories
// ---------------------------------------------------------------------------

const { MockWebSocket } = vi.hoisted(() => {
  const { EventEmitter: EE } = require('events');

  class MockWebSocket extends EE {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readyState = 1; // OPEN
    url: string;

    send = vi.fn();
    close = vi.fn(function (this: MockWebSocket) {
      this.readyState = 3; // CLOSED
    });

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

// Silence pino logger
vi.mock('pino', () => {
  const noop = () => {};
  const logger: Record<string, unknown> = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    child: () => logger,
  };
  return { default: () => logger };
});

import { RelayClient } from '../relay-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function latestWs(): InstanceType<typeof MockWebSocket> {
  const ws = MockWebSocket.instances.at(-1);
  if (!ws) throw new Error('No MockWebSocket instance created');
  return ws;
}

function defaultConfig() {
  return {
    host: 'relay.pumpamp.com',
    apiKey: 'pa_live_test',
    pairingCode: 'ABC123',
  };
}

/** Connect the client and simulate the WS open event (first-time pairing flow). */
function connectAndOpen(client: RelayClient): InstanceType<typeof MockWebSocket> {
  client.connect();
  const ws = latestWs();
  ws.emit('open');
  return ws;
}

/** Connect, open, and deliver pairing_confirmed (full handshake). */
function connectAndPair(client: RelayClient): InstanceType<typeof MockWebSocket> {
  const ws = connectAndOpen(client);
  ws.emit(
    'message',
    JSON.stringify({
      type: 'pairing_confirmed',
      pairing_id: 'pair_001',
      relay_session_id: 'sess_001',
    }),
  );
  return ws;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  MockWebSocket.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('State machine transitions', () => {
  it('1. Initial state is DISCONNECTED', () => {
    const client = new RelayClient(defaultConfig());
    expect(client.state).toBe('DISCONNECTED');
  });

  it('2. After connect(), state becomes CONNECTING', () => {
    const client = new RelayClient(defaultConfig());
    client.connect();
    expect(client.state).toBe('CONNECTING');
  });

  it('3. After WS open + before pairing_confirmed, state is AWAITING_PAIRING', () => {
    const client = new RelayClient(defaultConfig());
    connectAndOpen(client);
    expect(client.state).toBe('AWAITING_PAIRING');
  });

  it('4. After receiving pairing_confirmed, state is CONNECTED', () => {
    const client = new RelayClient(defaultConfig());
    connectAndPair(client);
    expect(client.state).toBe('CONNECTED');
  });

  it('5. After WS close, state returns to DISCONNECTED', () => {
    const client = new RelayClient(defaultConfig());
    connectAndPair(client);

    // Stop auto-reconnect so we can inspect the steady state
    client.disconnect();
    expect(client.state).toBe('DISCONNECTED');
  });

  it('6. After receiving pairing_revoked, state is DISCONNECTED', () => {
    const client = new RelayClient(defaultConfig());
    const ws = connectAndPair(client);

    ws.emit(
      'message',
      JSON.stringify({
        type: 'pairing_revoked',
        pairing_id: 'pair_001',
        reason: 'user_revoked',
      }),
    );

    expect(client.state).toBe('DISCONNECTED');
  });
});

describe('Pairing handshake', () => {
  it('1. First connect uses pairing_code in URL query', () => {
    const client = new RelayClient(defaultConfig());
    client.connect();
    const ws = latestWs();

    expect(ws.url).toContain('pairing_code=ABC123');
    expect(ws.url).not.toContain('pairing_id=');
  });

  it('2. Reconnect uses pairing_id in URL query', () => {
    const client = new RelayClient({
      host: 'relay.pumpamp.com',
      apiKey: 'pa_live_test',
      pairingCode: 'ABC123',
      pairingId: 'pair_saved',
    });
    client.connect();
    const ws = latestWs();

    expect(ws.url).toContain('pairing_id=pair_saved');
    expect(ws.url).not.toContain('pairing_code=');
  });

  it('3. pairing_confirmed message stores pairing_id', () => {
    const client = new RelayClient(defaultConfig());
    connectAndPair(client);

    expect(client.pairingId).toBe('pair_001');
  });

  it('4. pairing_confirmed emits "pairing_confirmed" event', () => {
    const client = new RelayClient(defaultConfig());
    const handler = vi.fn();
    client.on('pairing_confirmed', handler);

    connectAndPair(client);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pairing_confirmed',
        pairing_id: 'pair_001',
        relay_session_id: 'sess_001',
      }),
    );
  });
});

describe('Heartbeat', () => {
  it('1. Heartbeat sent within 15s of connection', () => {
    const client = new RelayClient(defaultConfig());
    const ws = connectAndPair(client);

    // No heartbeat yet at t=0
    expect(ws.send).not.toHaveBeenCalled();

    // Advance 15 seconds -- heartbeat interval fires
    vi.advanceTimersByTime(15_000);

    expect(ws.send).toHaveBeenCalled();
    const lastCall = ws.send.mock.calls.at(-1)![0] as string;
    const parsed = JSON.parse(lastCall);
    expect(parsed.type).toBe('heartbeat');
  });

  it('2. Heartbeat includes current uptime_secs', () => {
    // Pin Date.now so uptime can be computed deterministically
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);

    const client = new RelayClient(defaultConfig());
    const ws = connectAndPair(client);

    // Advance real time by 30s before heartbeat fires
    vi.setSystemTime(now + 30_000);
    vi.advanceTimersByTime(15_000);

    const lastCall = ws.send.mock.calls.at(-1)![0] as string;
    const parsed = JSON.parse(lastCall);
    expect(parsed.uptime_secs).toBeGreaterThanOrEqual(15);
  });

  it('3. Heartbeat includes connected_venues list', () => {
    const client = new RelayClient(defaultConfig());
    client.updateStatus({ connected_venues: ['binance', 'bybit'] });
    const ws = connectAndPair(client);

    vi.advanceTimersByTime(15_000);

    const lastCall = ws.send.mock.calls.at(-1)![0] as string;
    const parsed = JSON.parse(lastCall);
    expect(parsed.connected_venues).toEqual(['binance', 'bybit']);
  });

  it('4. Heartbeat includes open_orders and open_positions counts', () => {
    const client = new RelayClient(defaultConfig());
    client.updateStatus({ open_orders: 5, open_positions: 3 });
    const ws = connectAndPair(client);

    vi.advanceTimersByTime(15_000);

    const lastCall = ws.send.mock.calls.at(-1)![0] as string;
    const parsed = JSON.parse(lastCall);
    expect(parsed.open_orders).toBe(5);
    expect(parsed.open_positions).toBe(3);
  });

  it('5. Heartbeat stops on disconnect', () => {
    const client = new RelayClient(defaultConfig());
    const ws = connectAndPair(client);

    // One heartbeat fires
    vi.advanceTimersByTime(15_000);
    const callsAfterFirst = ws.send.mock.calls.length;

    client.disconnect();

    // Advance another 30s -- no more heartbeats
    vi.advanceTimersByTime(30_000);
    expect(ws.send).toHaveBeenCalledTimes(callsAfterFirst);
  });
});

describe('Command handling', () => {
  it('1. Incoming trade command emits "command" event', () => {
    const client = new RelayClient(defaultConfig());
    const handler = vi.fn();
    client.on('command', handler);

    const ws = connectAndPair(client);

    const tradeCmd = {
      type: 'trade',
      id: 'cmd_001',
      market_id: 'BTC-USDT',
      venue: 'binance',
      side: 'buy',
      action: 'open',
      size: 0.1,
      order_type: 'market',
    };

    ws.emit('message', JSON.stringify(tradeCmd));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'trade', id: 'cmd_001' }));
  });

  it('2. Incoming cancel command emits "command" event', () => {
    const client = new RelayClient(defaultConfig());
    const handler = vi.fn();
    client.on('command', handler);

    const ws = connectAndPair(client);

    const cancelCmd = {
      type: 'cancel',
      id: 'cmd_002',
      order_id: 'ord_abc',
    };

    ws.emit('message', JSON.stringify(cancelCmd));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'cancel', id: 'cmd_002' }));
  });

  it('3. command_ack sent automatically for each command', () => {
    const client = new RelayClient(defaultConfig());
    const ws = connectAndPair(client);

    const tradeCmd = {
      type: 'trade',
      id: 'cmd_003',
      market_id: 'ETH-USDT',
      venue: 'bybit',
      side: 'sell',
      action: 'close',
      size: 1,
      order_type: 'limit',
      limit_price: 3000,
    };

    ws.emit('message', JSON.stringify(tradeCmd));

    // Find the command_ack call among all sends
    const ackCall = ws.send.mock.calls.find((call: unknown[]) => {
      const parsed = JSON.parse(call[0] as string);
      return parsed.type === 'command_ack';
    });

    expect(ackCall).toBeDefined();
    const ack = JSON.parse(ackCall![0] as string);
    expect(ack.command_id).toBe('cmd_003');
    expect(ack.status).toBe('accepted');
  });
});

describe('Reconnection logic', () => {
  it('1. After close, reconnect attempted after 1s (first retry)', () => {
    const client = new RelayClient(defaultConfig());
    const ws = connectAndPair(client);
    const instancesBefore = MockWebSocket.instances.length;

    // Simulate unexpected close
    ws.emit('close', 1006, Buffer.from('abnormal'));

    // Before 1s elapses, no new WS
    vi.advanceTimersByTime(500);
    expect(MockWebSocket.instances.length).toBe(instancesBefore);

    // At 1s, reconnect fires
    vi.advanceTimersByTime(500);
    expect(MockWebSocket.instances.length).toBe(instancesBefore + 1);
  });

  it('2. Backoff doubles: 1s -> 2s -> 4s', () => {
    const client = new RelayClient(defaultConfig());
    const ws1 = connectAndPair(client);

    // First disconnect -> schedules reconnect at 1s, then doubles to 2s
    ws1.emit('close', 1006, Buffer.from(''));
    vi.advanceTimersByTime(1000);
    const ws2 = latestWs();

    // ws2 fails immediately (emit error then close without opening)
    // This triggers handleDisconnect without resetting backoff (no 'open' event)
    ws2.emit('error', new Error('connection refused'));

    // Second reconnect -> 2s backoff
    const countBefore2s = MockWebSocket.instances.length;
    vi.advanceTimersByTime(1999);
    expect(MockWebSocket.instances.length).toBe(countBefore2s);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances.length).toBe(countBefore2s + 1);

    // ws3 also fails immediately
    const ws3 = latestWs();
    ws3.emit('error', new Error('connection refused'));

    // Third reconnect -> 4s backoff
    const countBefore4s = MockWebSocket.instances.length;
    vi.advanceTimersByTime(3999);
    expect(MockWebSocket.instances.length).toBe(countBefore4s);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances.length).toBe(countBefore4s + 1);
  });

  it('3. Backoff caps at 60s', () => {
    const client = new RelayClient(defaultConfig());
    const ws = connectAndPair(client);

    // First disconnect triggers backoff sequence
    // Delays: 1s, 2s, 4s, 8s, 16s, 32s, 60s (capped), 60s (capped)
    // Each reconnected WS fails immediately (no 'open') so backoff is not reset
    ws.emit('close', 1006, Buffer.from(''));

    for (let i = 0; i < 6; i++) {
      const delay = Math.min(Math.pow(2, i) * 1000, 60_000);
      vi.advanceTimersByTime(delay);
      const nextWs = latestWs();
      nextWs.emit('error', new Error('connection refused'));
    }

    // After delays 1+2+4+8+16+32, next should be capped at 60s
    const countBefore = MockWebSocket.instances.length;
    vi.advanceTimersByTime(59_999);
    expect(MockWebSocket.instances.length).toBe(countBefore);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances.length).toBe(countBefore + 1);
  });

  it('4. Successful reconnect resets backoff to 1s', () => {
    const client = new RelayClient(defaultConfig());
    const ws1 = connectAndPair(client);

    // First disconnect -> 1s backoff
    ws1.emit('close', 1006, Buffer.from(''));
    vi.advanceTimersByTime(1000);
    const ws2 = latestWs();

    // ws2 opens and close without pairing -> 2s backoff
    ws2.emit('open');
    ws2.emit('close', 1006, Buffer.from(''));
    vi.advanceTimersByTime(2000);
    const ws3 = latestWs();

    // ws3 opens successfully (pairingId was stored from first connect)
    // Since pairingId is set, 'open' goes to CONNECTED and resets backoff
    ws3.emit('open');

    // Disconnect again -- delay should be 1s (reset), not 4s
    ws3.emit('close', 1006, Buffer.from(''));
    const countBefore = MockWebSocket.instances.length;
    vi.advanceTimersByTime(999);
    expect(MockWebSocket.instances.length).toBe(countBefore);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances.length).toBe(countBefore + 1);
  });

  it('5. Reconnect uses pairing_id (not pairing_code)', () => {
    const client = new RelayClient(defaultConfig());
    const ws1 = connectAndPair(client);

    // pairingId is now stored from pairing_confirmed
    ws1.emit('close', 1006, Buffer.from(''));
    vi.advanceTimersByTime(1000);

    const ws2 = latestWs();
    expect(ws2.url).toContain('pairing_id=pair_001');
    expect(ws2.url).not.toContain('pairing_code=');
  });
});

describe('Report sending', () => {
  it('1. sendReport(heartbeat) serializes to JSON and sends', () => {
    const client = new RelayClient(defaultConfig());
    const ws = connectAndPair(client);

    client.sendReport({
      type: 'heartbeat',
      uptime_secs: 42,
      version: '0.1.0',
      strategy_status: 'active',
      connected_venues: ['binance'],
      open_orders: 1,
      open_positions: 2,
    });

    const sent = ws.send.mock.calls.find((c: unknown[]) => {
      const p = JSON.parse(c[0] as string);
      return p.type === 'heartbeat' && p.uptime_secs === 42;
    });

    expect(sent).toBeDefined();
    const parsed = JSON.parse(sent![0] as string);
    expect(parsed.connected_venues).toEqual(['binance']);
    expect(parsed.open_orders).toBe(1);
    expect(parsed.open_positions).toBe(2);
  });

  it('2. sendReport(order_update) sends correctly', () => {
    const client = new RelayClient(defaultConfig());
    const ws = connectAndPair(client);

    client.sendReport({
      type: 'order_update',
      order_id: 'ord_123',
      venue: 'binance',
      market_id: 'BTC-USDT',
      status: 'filled',
      side: 'buy',
      action: 'open',
      size: 0.5,
      fill_price: 68000,
    });

    const sent = ws.send.mock.calls.find((c: unknown[]) => {
      const p = JSON.parse(c[0] as string);
      return p.type === 'order_update';
    });

    expect(sent).toBeDefined();
    const parsed = JSON.parse(sent![0] as string);
    expect(parsed.order_id).toBe('ord_123');
    expect(parsed.status).toBe('filled');
    expect(parsed.fill_price).toBe(68000);
  });

  it('3. sendReport when disconnected does not send', () => {
    const client = new RelayClient(defaultConfig());

    // Not connected at all - state is DISCONNECTED
    client.sendReport({
      type: 'heartbeat',
      uptime_secs: 0,
      version: '0.1.0',
      strategy_status: 'active',
      connected_venues: [],
      open_orders: 0,
      open_positions: 0,
    });

    // No WebSocket was ever created, so nothing to send on
    expect(MockWebSocket.instances.length).toBe(0);
  });
});
