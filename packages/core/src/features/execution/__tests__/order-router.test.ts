import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseMarketId, OrderRouter } from '../order-router.js';
import type { VenueConnector } from '../venue-connector.js';
import type {
  TradeCommand,
  CancelCommand,
  CancelAllCommand,
  PauseCommand,
  ResumeCommand,
  ErrorReport,
  OrderUpdateReport,
  OrderResult,
} from '../../../shared/protocol.js';

// ============================================================
// Helpers
// ============================================================

function createMockConnector(venue: string): VenueConnector {
  return {
    venue,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    placeOrder: vi.fn().mockResolvedValue({
      order_id: 'test-123',
      status: 'submitted',
    } satisfies OrderResult),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    cancelAllOrders: vi.fn().mockResolvedValue(undefined),
    getPositions: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({
      venue,
      available: 1000,
      total: 1000,
      currency: 'USD',
    }),
    isHealthy: vi.fn().mockReturnValue(true),
  };
}

function makeTradeCommand(overrides: Partial<TradeCommand> = {}): TradeCommand {
  return {
    type: 'trade',
    id: 'cmd-001',
    market_id: 'kalshi:KXBTCD-26FEB11',
    venue: 'kalshi',
    side: 'yes',
    action: 'buy',
    size: 10,
    order_type: 'market',
    ...overrides,
  };
}

// ============================================================
// ============================================================

describe('Market ID parsing', () => {
  it('"kalshi:KXBTCD-26FEB11" parses to venue=kalshi, nativeId=KXBTCD-26FEB11', () => {
    const result = parseMarketId('kalshi:KXBTCD-26FEB11');

    expect(result).not.toBeNull();
    expect(result!.venue).toBe('kalshi');
    expect(result!.nativeId).toBe('KXBTCD-26FEB11');
  });

  it('"polymarket:0x123abc" parses correctly', () => {
    const result = parseMarketId('polymarket:0x123abc');

    expect(result).not.toBeNull();
    expect(result!.venue).toBe('polymarket');
    expect(result!.nativeId).toBe('0x123abc');
  });

  it('"hyperliquid:BTC" parses correctly', () => {
    const result = parseMarketId('hyperliquid:BTC');

    expect(result).not.toBeNull();
    expect(result!.venue).toBe('hyperliquid');
    expect(result!.nativeId).toBe('BTC');
  });

  it('"binance:BTCUSDT" parses correctly', () => {
    const result = parseMarketId('binance:BTCUSDT');

    expect(result).not.toBeNull();
    expect(result!.venue).toBe('binance');
    expect(result!.nativeId).toBe('BTCUSDT');
  });

  it('invalid format (no colon) returns null', () => {
    const result = parseMarketId('kalshiKXBTCD-26FEB11');

    expect(result).toBeNull();
  });

  it('empty market_id returns null', () => {
    const result = parseMarketId('');

    expect(result).toBeNull();
  });
});

// ============================================================
// ============================================================

describe('Command routing', () => {
  let router: OrderRouter;
  let kalshiConnector: VenueConnector;
  let binanceConnector: VenueConnector;

  beforeEach(() => {
    router = new OrderRouter();
    kalshiConnector = createMockConnector('kalshi');
    binanceConnector = createMockConnector('binance');
    router.registerConnector(kalshiConnector);
    router.registerConnector(binanceConnector);
  });

  it('trade command is routed to the correct connector', async () => {
    const cmd = makeTradeCommand({
      id: 'cmd-route-1',
      market_id: 'kalshi:KXBTCD-26FEB11',
      venue: 'kalshi',
    });

    await router.routeCommand(cmd);

    expect(kalshiConnector.placeOrder).toHaveBeenCalledTimes(1);
    expect(binanceConnector.placeOrder).not.toHaveBeenCalled();

    // Verify the OrderRequest passed to placeOrder has the native_id (colon-stripped)
    const orderReq = (kalshiConnector.placeOrder as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(orderReq.market_id).toBe('KXBTCD-26FEB11');
    expect(orderReq.venue).toBe('kalshi');
  });

  it('cancel command is routed to the correct connector', async () => {
    // First place an order so it exists in tracking
    const tradeCmd = makeTradeCommand({ id: 'cmd-trade-for-cancel' });
    await router.routeCommand(tradeCmd);

    // Get the order ID that was created
    const orders = router.getOrders();
    const [orderId] = orders.keys();

    const cancelCmd: CancelCommand = {
      type: 'cancel',
      id: 'cmd-cancel-1',
      order_id: orderId,
    };

    await router.routeCommand(cancelCmd);

    expect(kalshiConnector.cancelOrder).toHaveBeenCalledTimes(1);
    expect(kalshiConnector.cancelOrder).toHaveBeenCalledWith(orderId);
  });

  it('cancel_all command is routed to all connectors', async () => {
    const cancelAllCmd: CancelAllCommand = {
      type: 'cancel_all',
      id: 'cmd-cancel-all-1',
    };

    await router.routeCommand(cancelAllCmd);

    expect(kalshiConnector.cancelAllOrders).toHaveBeenCalledTimes(1);
    expect(binanceConnector.cancelAllOrders).toHaveBeenCalledTimes(1);
  });

  it('command for unregistered venue returns VENUE_NOT_FOUND error', async () => {
    const errors: ErrorReport[] = [];
    router.on('error', (err: ErrorReport) => errors.push(err));

    const cmd = makeTradeCommand({
      id: 'cmd-unknown-venue',
      market_id: 'kraken:BTCUSD',
      venue: 'kraken',
    });

    await router.routeCommand(cmd);

    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('VENUE_NOT_FOUND');
    expect(errors[0].venue).toBe('kraken');
    expect(errors[0].command_id).toBe('cmd-unknown-venue');
  });

  it('command for unhealthy venue returns VENUE_UNHEALTHY error', async () => {
    // Make kalshi unhealthy
    (kalshiConnector.isHealthy as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const errors: ErrorReport[] = [];
    router.on('error', (err: ErrorReport) => errors.push(err));

    const cmd = makeTradeCommand({
      id: 'cmd-unhealthy',
      market_id: 'kalshi:KXBTCD-26FEB11',
      venue: 'kalshi',
    });

    await router.routeCommand(cmd);

    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('VENUE_UNHEALTHY');
    expect(errors[0].venue).toBe('kalshi');
    expect(errors[0].command_id).toBe('cmd-unhealthy');
    // placeOrder should NOT have been called
    expect(kalshiConnector.placeOrder).not.toHaveBeenCalled();
  });
});

// ============================================================
// ============================================================

describe('Order lifecycle tracking', () => {
  let router: OrderRouter;
  let connector: VenueConnector;

  beforeEach(() => {
    router = new OrderRouter();
    connector = createMockConnector('kalshi');
    router.registerConnector(connector);
  });

  it('trade command creates a pending order entry before placeOrder resolves', async () => {
    // Make placeOrder block until we release it
    let resolvePlaceOrder!: (value: OrderResult) => void;
    (connector.placeOrder as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<OrderResult>((resolve) => {
          resolvePlaceOrder = resolve;
        })
    );

    const cmd = makeTradeCommand({ id: 'cmd-pending' });

    // Start routing but don't await - we want to inspect mid-flight
    const routePromise = router.routeCommand(cmd);

    // The microtask queue should have set the order to pending by now,
    // since pending is set synchronously before the await on placeOrder
    // We need to wait one tick for the async function to reach the await
    await new Promise((r) => setTimeout(r, 0));

    const orders = router.getOrders();
    expect(orders.size).toBe(1);

    const [, orderState] = [...orders.entries()][0];
    expect(orderState.status).toBe('pending');
    expect(orderState.venue).toBe('kalshi');
    expect(orderState.commandId).toBe('cmd-pending');

    // Clean up: resolve the promise
    resolvePlaceOrder({ order_id: 'test-123', status: 'submitted' });
    await routePromise;
  });

  it('successful placeOrder transitions order to submitted', async () => {
    (connector.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      order_id: 'venue-ord-1',
      venue_order_id: 'venue-ord-1',
      status: 'submitted',
    } satisfies OrderResult);

    const cmd = makeTradeCommand({ id: 'cmd-submitted' });
    await router.routeCommand(cmd);

    const orders = router.getOrders();
    expect(orders.size).toBe(1);

    const [, orderState] = [...orders.entries()][0];
    expect(orderState.status).toBe('submitted');
  });

  it('fill updates status to filled', async () => {
    (connector.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      order_id: 'venue-ord-2',
      venue_order_id: 'venue-ord-2',
      status: 'filled',
      fill_price: 0.72,
      filled_at: '2026-02-11T10:30:00Z',
    } satisfies OrderResult);

    const cmd = makeTradeCommand({ id: 'cmd-filled' });
    await router.routeCommand(cmd);

    const orders = router.getOrders();
    const [, orderState] = [...orders.entries()][0];
    expect(orderState.status).toBe('filled');
  });

  it('rejection updates status to rejected', async () => {
    (connector.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      order_id: 'venue-ord-3',
      status: 'rejected',
      error: 'Insufficient balance',
    } satisfies OrderResult);

    // Must listen for 'error' events to prevent Node EventEmitter from throwing
    const errors: ErrorReport[] = [];
    router.on('error', (err: ErrorReport) => errors.push(err));

    const cmd = makeTradeCommand({ id: 'cmd-rejected' });
    await router.routeCommand(cmd);

    const orders = router.getOrders();
    const [, orderState] = [...orders.entries()][0];
    expect(orderState.status).toBe('rejected');
  });

  it('OrderUpdate report is emitted for each state change', async () => {
    (connector.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      order_id: 'venue-ord-4',
      venue_order_id: 'venue-ord-4',
      status: 'submitted',
    } satisfies OrderResult);

    const updates: OrderUpdateReport[] = [];
    router.on('order_update', (report: OrderUpdateReport) => updates.push(report));

    const cmd = makeTradeCommand({ id: 'cmd-emit-test', side: 'yes', action: 'buy', size: 5 });
    await router.routeCommand(cmd);

    expect(updates).toHaveLength(1);
    expect(updates[0].type).toBe('order_update');
    expect(updates[0].venue).toBe('kalshi');
    expect(updates[0].status).toBe('submitted');
    expect(updates[0].side).toBe('yes');
    expect(updates[0].action).toBe('buy');
    expect(updates[0].size).toBe(5);
    expect(updates[0].venue_order_id).toBe('venue-ord-4');
  });
});

// ============================================================
// ============================================================

describe('Pause/Resume handling', () => {
  let router: OrderRouter;
  let connector: VenueConnector;

  beforeEach(() => {
    router = new OrderRouter();
    connector = createMockConnector('kalshi');
    router.registerConnector(connector);
  });

  it('pause command stops routing new trade commands with GATEWAY_PAUSED error', async () => {
    const errors: ErrorReport[] = [];
    router.on('error', (err: ErrorReport) => errors.push(err));

    // Pause the gateway
    const pauseCmd: PauseCommand = { type: 'pause', id: 'cmd-pause' };
    await router.routeCommand(pauseCmd);

    expect(router.isPaused()).toBe(true);

    // Attempt a trade - should be rejected
    const tradeCmd = makeTradeCommand({ id: 'cmd-paused-trade' });
    await router.routeCommand(tradeCmd);

    expect(connector.placeOrder).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('GATEWAY_PAUSED');
    expect(errors[0].command_id).toBe('cmd-paused-trade');
  });

  it('resume command re-enables routing', async () => {
    // Pause then resume
    const pauseCmd: PauseCommand = { type: 'pause', id: 'cmd-pause-2' };
    await router.routeCommand(pauseCmd);
    expect(router.isPaused()).toBe(true);

    const resumeCmd: ResumeCommand = { type: 'resume', id: 'cmd-resume-2' };
    await router.routeCommand(resumeCmd);
    expect(router.isPaused()).toBe(false);

    // Trade should now succeed
    const tradeCmd = makeTradeCommand({ id: 'cmd-after-resume' });
    await router.routeCommand(tradeCmd);

    expect(connector.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('pause does not affect in-flight orders', async () => {
    // Set up a placeOrder that we control
    let resolvePlaceOrder!: (value: OrderResult) => void;
    (connector.placeOrder as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<OrderResult>((resolve) => {
          resolvePlaceOrder = resolve;
        })
    );

    const updates: OrderUpdateReport[] = [];
    router.on('order_update', (report: OrderUpdateReport) => updates.push(report));

    // Start a trade (in-flight)
    const tradeCmd = makeTradeCommand({ id: 'cmd-inflight' });
    const routePromise = router.routeCommand(tradeCmd);

    // Pause while order is in-flight
    const pauseCmd: PauseCommand = { type: 'pause', id: 'cmd-pause-inflight' };
    await router.routeCommand(pauseCmd);
    expect(router.isPaused()).toBe(true);

    // Resolve the in-flight order -- it should still complete
    resolvePlaceOrder({
      order_id: 'venue-inflight',
      venue_order_id: 'venue-inflight',
      status: 'filled',
      fill_price: 0.65,
    });
    await routePromise;

    // The in-flight order should have completed normally
    expect(updates).toHaveLength(1);
    expect(updates[0].status).toBe('filled');

    const orders = router.getOrders();
    const [, orderState] = [...orders.entries()][0];
    expect(orderState.status).toBe('filled');
  });
});
