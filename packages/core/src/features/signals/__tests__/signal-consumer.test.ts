//
// Tests cover: connection and subscription, signal event emission,
// and reconnection with backoff.

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

import { SignalConsumer } from '../signal-consumer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function latestWs(): InstanceType<typeof MockWebSocket> {
  const ws = MockWebSocket.instances.at(-1);
  if (!ws) throw new Error('No MockWebSocket instance created');
  return ws;
}

function defaultOptions() {
  return {
    host: 'api.pumpamp.com',
    apiKey: 'pa_live_test',
    signalTypes: ['alert', 'strategy'] as string[],
    symbols: ['BTC/USDT', 'ETH/USDT'] as string[],
    minConfidence: 0.7,
  };
}

function makeSignal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sig_001',
    signal_type: 'alert',
    signal_name: 'Volume Spike',
    market_id: 'BTC-USDT',
    venue: 'binance',
    base_currency: 'BTC',
    quote_currency: 'USDT',
    created_at: '2026-02-11T00:00:00Z',
    description: 'Unusual volume detected',
    payload: {},
    ...overrides,
  };
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

// ===========================================================================
// ===========================================================================

describe('Connection and subscription', () => {
  it('1. Connects to correct URL with api_key', () => {
    const consumer = new SignalConsumer(defaultOptions());
    consumer.connect();

    const ws = latestWs();
    expect(ws.url).toBe('wss://api.pumpamp.com/api/v1/public/ws/signals?api_key=pa_live_test');
  });

  it('2. Sends subscribe message on open', () => {
    const consumer = new SignalConsumer(defaultOptions());
    consumer.connect();
    const ws = latestWs();

    // Before open, nothing sent
    expect(ws.send).not.toHaveBeenCalled();

    ws.emit('open');

    expect(ws.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(ws.send.mock.calls[0][0] as string);
    expect(sent.type).toBe('subscribe');
  });

  it('3. Subscribe includes configured signal_types', () => {
    const consumer = new SignalConsumer(defaultOptions());
    consumer.connect();
    const ws = latestWs();
    ws.emit('open');

    const sent = JSON.parse(ws.send.mock.calls[0][0] as string);
    expect(sent.signal_types).toEqual(['alert', 'strategy']);
  });

  it('4. Subscribe includes configured symbols filter', () => {
    const consumer = new SignalConsumer(defaultOptions());
    consumer.connect();
    const ws = latestWs();
    ws.emit('open');

    const sent = JSON.parse(ws.send.mock.calls[0][0] as string);
    expect(sent.symbols).toEqual(['BTC/USDT', 'ETH/USDT']);
  });

  it('5. Subscribe includes min_confidence', () => {
    const consumer = new SignalConsumer(defaultOptions());
    consumer.connect();
    const ws = latestWs();
    ws.emit('open');

    const sent = JSON.parse(ws.send.mock.calls[0][0] as string);
    expect(sent.min_confidence).toBe(0.7);
  });
});

// ===========================================================================
// ===========================================================================

describe('Signal event emission', () => {
  it('1. Incoming signal JSON emits "signal" event', () => {
    const consumer = new SignalConsumer(defaultOptions());
    const handler = vi.fn();
    consumer.on('signal', handler);

    consumer.connect();
    const ws = latestWs();
    ws.emit('open');

    const signal = makeSignal();
    ws.emit('message', JSON.stringify(signal));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sig_001',
        signal_type: 'alert',
        signal_name: 'Volume Spike',
      }),
    );
  });

  it('2. Invalid JSON message does not crash', () => {
    const consumer = new SignalConsumer(defaultOptions());
    const signalHandler = vi.fn();
    consumer.on('signal', signalHandler);

    consumer.connect();
    const ws = latestWs();
    ws.emit('open');

    // Send garbage -- should not throw or emit signal
    expect(() => {
      ws.emit('message', 'not valid json {{{');
    }).not.toThrow();

    expect(signalHandler).not.toHaveBeenCalled();
  });

  it('3. Multiple signals each emit separate events', () => {
    const consumer = new SignalConsumer(defaultOptions());
    const handler = vi.fn();
    consumer.on('signal', handler);

    consumer.connect();
    const ws = latestWs();
    ws.emit('open');

    const sig1 = makeSignal({ id: 'sig_a', signal_name: 'Alpha' });
    const sig2 = makeSignal({ id: 'sig_b', signal_name: 'Beta' });
    const sig3 = makeSignal({ id: 'sig_c', signal_name: 'Gamma' });

    ws.emit('message', JSON.stringify(sig1));
    ws.emit('message', JSON.stringify(sig2));
    ws.emit('message', JSON.stringify(sig3));

    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[0][0]).toMatchObject({ id: 'sig_a', signal_name: 'Alpha' });
    expect(handler.mock.calls[1][0]).toMatchObject({ id: 'sig_b', signal_name: 'Beta' });
    expect(handler.mock.calls[2][0]).toMatchObject({ id: 'sig_c', signal_name: 'Gamma' });
  });
});

// ===========================================================================
// ===========================================================================

describe('Reconnection', () => {
  it('1. Auto-reconnect on close with backoff', () => {
    const consumer = new SignalConsumer(defaultOptions());
    consumer.connect();
    const ws1 = latestWs();
    ws1.emit('open');

    const instancesBefore = MockWebSocket.instances.length;

    // Simulate close -- reconnectAttempt is 0, delay = 2^0 * 1000 = 1s
    ws1.emit('close');

    // First reconnect delay is 1s (2^0 * 1000)
    vi.advanceTimersByTime(999);
    expect(MockWebSocket.instances.length).toBe(instancesBefore);

    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances.length).toBe(instancesBefore + 1);

    // ws2 does NOT open (fails) and closes -- reconnectAttempt is 1, delay = 2^1 * 1000 = 2s
    const ws2 = latestWs();
    ws2.emit('close');

    const instancesAfter2 = MockWebSocket.instances.length;
    vi.advanceTimersByTime(1999);
    expect(MockWebSocket.instances.length).toBe(instancesAfter2);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances.length).toBe(instancesAfter2 + 1);
  });

  it('2. Resends subscribe message after reconnect', () => {
    const consumer = new SignalConsumer(defaultOptions());
    consumer.connect();
    const ws1 = latestWs();
    ws1.emit('open');

    // First subscribe sent
    expect(ws1.send).toHaveBeenCalledOnce();
    const firstSubscribe = JSON.parse(ws1.send.mock.calls[0][0] as string);
    expect(firstSubscribe.type).toBe('subscribe');

    // Disconnect and reconnect
    ws1.emit('close');
    vi.advanceTimersByTime(1000);

    const ws2 = latestWs();
    ws2.emit('open');

    // Second subscribe sent on ws2
    expect(ws2.send).toHaveBeenCalledOnce();
    const secondSubscribe = JSON.parse(ws2.send.mock.calls[0][0] as string);
    expect(secondSubscribe.type).toBe('subscribe');
    expect(secondSubscribe.signal_types).toEqual(['alert', 'strategy']);
    expect(secondSubscribe.symbols).toEqual(['BTC/USDT', 'ETH/USDT']);
    expect(secondSubscribe.min_confidence).toBe(0.7);
  });
});
