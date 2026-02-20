import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReplayConsumer, type ReplayConsumerConfig } from '../replay-consumer.js';

// Silence pino logger
vi.mock('pino', () => {
  const noop = () => {};
  const logger: Record<string, unknown> = {
    info: noop, warn: noop, error: noop, debug: noop, trace: noop,
    child: () => logger,
  };
  return { default: () => logger };
});

function makeConfig(overrides: Partial<ReplayConsumerConfig> = {}): ReplayConsumerConfig {
  return {
    apiUrl: 'https://api.pumpamp.com',
    apiKey: 'pa_live_test',
    start: new Date('2026-01-01T00:00:00Z'),
    end: new Date('2026-01-31T00:00:00Z'),
    ...overrides,
  };
}

function makeSignal(id: string) {
  return {
    id,
    signal_type: 'alert',
    signal_name: 'volume_spike',
    market_id: 'binance:BTC:USDT',
    venue: 'binance',
    base_currency: 'BTC',
    quote_currency: 'USDT',
    created_at: '2026-01-15T00:00:00Z',
    description: 'Volume spike detected',
    payload: {},
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Fetches single page of signals', () => {
  it('yields one page with 5 signals when has_more is false', async () => {
    const signals = Array.from({ length: 5 }, (_, i) => makeSignal(`sig-${i}`));

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ signals, next_cursor: null, has_more: false, count: 5 }),
    });

    const consumer = new ReplayConsumer(makeConfig());
    const pages: unknown[][] = [];

    for await (const page of consumer.fetchSignals()) {
      pages.push(page);
    }

    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('Handles cursor pagination across multiple pages', () => {
  it('yields 3 pages totaling 2500 signals with correct cursor passing', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeSignal(`p1-${i}`));
    const page2 = Array.from({ length: 1000 }, (_, i) => makeSignal(`p2-${i}`));
    const page3 = Array.from({ length: 500 }, (_, i) => makeSignal(`p3-${i}`));

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ signals: page1, next_cursor: 'cursorA', has_more: true, count: 1000 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ signals: page2, next_cursor: 'cursorB', has_more: true, count: 1000 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ signals: page3, next_cursor: null, has_more: false, count: 500 }),
      });

    const consumer = new ReplayConsumer(makeConfig());
    const pages: unknown[][] = [];

    for await (const page of consumer.fetchSignals()) {
      pages.push(page);
    }

    expect(pages).toHaveLength(3);
    expect(pages[0]).toHaveLength(1000);
    expect(pages[1]).toHaveLength(1000);
    expect(pages[2]).toHaveLength(500);
    expect(consumer.signalsFetched).toBe(2500);

    // Verify cursor passed in second request
    const url2 = fetchMock.mock.calls[1][0] as string;
    expect(url2).toContain('cursor=cursorA');

    // Verify cursor passed in third request
    const url3 = fetchMock.mock.calls[2][0] as string;
    expect(url3).toContain('cursor=cursorB');
  });
});

describe('Stops on has_more false', () => {
  it('makes exactly 1 HTTP request when has_more is false', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ signals: [makeSignal('s1')], next_cursor: null, has_more: false, count: 1 }),
    });

    const consumer = new ReplayConsumer(makeConfig());
    const pages: unknown[][] = [];

    for await (const page of consumer.fetchSignals()) {
      pages.push(page);
    }

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(pages).toHaveLength(1);
  });
});

describe('Passes query parameters correctly', () => {
  it('includes all config params in URL and headers', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ signals: [], next_cursor: null, has_more: false, count: 0 }),
    });

    const consumer = new ReplayConsumer(makeConfig({
      signalNames: ['cross_venue_arbitrage'],
      signalType: 'alert',
      minConfidence: 80,
      severities: ['High', 'Critical'],
      venues: ['kalshi'],
      pageSize: 500,
    }));

    for await (const _page of consumer.fetchSignals()) {
      // consume
    }

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];

    expect(url).toContain('signal_names=cross_venue_arbitrage');
    expect(url).toContain('signal_type=alert');
    expect(url).toContain('min_confidence=80');
    expect(url).toContain('severities=High%2CCritical');
    expect(url).toContain('venues=kalshi');
    expect(url).toContain('limit=500');
    expect(options.headers['X-API-Key']).toBe('pa_live_test');
  });
});

describe('Throws on API error', () => {
  it('throws Error with status code and body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => '{"error": "Internal server error"}',
    });

    const consumer = new ReplayConsumer(makeConfig());

    await expect(async () => {
      for await (const _page of consumer.fetchSignals()) {
        // should throw before yielding
      }
    }).rejects.toThrow('Replay API error 500');
  });
});

describe('Handles empty result set', () => {
  it('yields one page with empty array and signalsFetched returns 0', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ signals: [], next_cursor: null, has_more: false, count: 0 }),
    });

    const consumer = new ReplayConsumer(makeConfig());
    const pages: unknown[][] = [];

    for await (const page of consumer.fetchSignals()) {
      pages.push(page);
    }

    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(0);
    expect(consumer.signalsFetched).toBe(0);
  });
});
