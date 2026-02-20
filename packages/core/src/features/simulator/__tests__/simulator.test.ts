import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SimulatorVenueConnector,
  SimulatorRelay,
  formatFill,
  formatReject,
  formatPosition,
  formatSettlement,
} from '../simulator.js';
import type { OrderRequest, BotUserCommand } from '../../../shared/protocol.js';

// ============================================================
// SimulatorVenueConnector tests
// ============================================================

describe('SimulatorVenueConnector', () => {
  let connector: SimulatorVenueConnector;

  beforeEach(() => {
    connector = new SimulatorVenueConnector('kalshi', 1.0, 0); // 100% fill, no delay
  });

  it('fills orders after delay', async () => {
    const order: OrderRequest = {
      market_id: 'KXBTCD-SIM-01',
      venue: 'kalshi',
      side: 'yes',
      action: 'buy',
      size: 10,
      order_type: 'market',
      command_id: 'cmd-001',
    };

    const result = await connector.placeOrder(order);

    expect(result.status).toBe('filled');
    expect(result.order_id).toBe('kalshi-sim-001');
    expect(result.venue_order_id).toBe('kalshi-sim-001');
    expect(result.fill_price).toBeTypeOf('number');
    expect(result.fill_price).toBeGreaterThan(0);
    expect(result.filled_at).toBeTypeOf('string');
  });

  it('rejects orders when fill rate is 0', async () => {
    const rejectConnector = new SimulatorVenueConnector('kalshi', 0, 0); // 0% fill rate

    const order: OrderRequest = {
      market_id: 'KXBTCD-SIM-01',
      venue: 'kalshi',
      side: 'yes',
      action: 'buy',
      size: 10,
      order_type: 'market',
      command_id: 'cmd-002',
    };

    const result = await rejectConnector.placeOrder(order);

    expect(result.status).toBe('rejected');
    expect(result.error).toContain('Simulated rejection');
  });

  it('uses limit_price when provided', async () => {
    const order: OrderRequest = {
      market_id: 'BTCUSDT',
      venue: 'kalshi',
      side: 'buy',
      action: 'buy',
      size: 0.1,
      order_type: 'limit',
      limit_price: 95000,
      command_id: 'cmd-003',
    };

    const result = await connector.placeOrder(order);

    expect(result.status).toBe('filled');
    expect(result.fill_price).toBe(95000);
  });

  it('increments order IDs', async () => {
    const makeOrder = (id: string): OrderRequest => ({
      market_id: 'KXBTCD-SIM-01',
      venue: 'kalshi',
      side: 'yes',
      action: 'buy',
      size: 5,
      order_type: 'market',
      command_id: id,
    });

    const r1 = await connector.placeOrder(makeOrder('a'));
    const r2 = await connector.placeOrder(makeOrder('b'));

    expect(r1.order_id).toBe('kalshi-sim-001');
    expect(r2.order_id).toBe('kalshi-sim-002');
  });

  it('tracks positions after fills', async () => {
    const order: OrderRequest = {
      market_id: 'KXBTCD-SIM-01',
      venue: 'kalshi',
      side: 'yes',
      action: 'buy',
      size: 10,
      order_type: 'market',
      command_id: 'cmd-004',
    };

    await connector.placeOrder(order);

    const positions = await connector.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].market_id).toBe('KXBTCD-SIM-01');
    expect(positions[0].side).toBe('yes');
    expect(positions[0].size).toBe(10);
  });

  it('closes position when opposite side is traded', async () => {
    // Open long
    await connector.placeOrder({
      market_id: 'KXBTCD-SIM-01',
      venue: 'kalshi',
      side: 'yes',
      action: 'buy',
      size: 10,
      order_type: 'market',
      command_id: 'cmd-open',
    });

    expect((await connector.getPositions())).toHaveLength(1);

    // Close with opposite side
    await connector.placeOrder({
      market_id: 'KXBTCD-SIM-01',
      venue: 'kalshi',
      side: 'no',
      action: 'buy',
      size: 10,
      order_type: 'market',
      command_id: 'cmd-close',
    });

    expect((await connector.getPositions())).toHaveLength(0);
  });

  it('closes position when action flips from buy to sell on same side', async () => {
    await connector.placeOrder({
      market_id: 'KXBTCD-SIM-01',
      venue: 'kalshi',
      side: 'yes',
      action: 'buy',
      size: 10,
      order_type: 'market',
      command_id: 'cmd-open-action',
    });

    expect((await connector.getPositions())).toHaveLength(1);

    await connector.placeOrder({
      market_id: 'KXBTCD-SIM-01',
      venue: 'kalshi',
      side: 'yes',
      action: 'sell',
      size: 10,
      order_type: 'market',
      command_id: 'cmd-close-action',
    });

    expect((await connector.getPositions())).toHaveLength(0);
  });

  it('isHealthy returns true', () => {
    expect(connector.isHealthy()).toBe(true);
  });

  it('getBalance returns simulated balance', async () => {
    const balance = await connector.getBalance();
    expect(balance.venue).toBe('kalshi');
    expect(balance.available).toBe(10000);
    expect(balance.currency).toBe('USD');
  });

  it('connect and disconnect are no-ops', async () => {
    await expect(connector.connect()).resolves.toBeUndefined();
    await expect(connector.disconnect()).resolves.toBeUndefined();
  });

  it('cancelOrder and cancelAllOrders are no-ops', async () => {
    await expect(connector.cancelOrder('some-id')).resolves.toBeUndefined();
    await expect(connector.cancelAllOrders()).resolves.toBeUndefined();
  });
});

// ============================================================
// SimulatorRelay tests
// ============================================================

describe('SimulatorRelay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Suppress console.log during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('generates commands at configured interval', () => {
    const relay = new SimulatorRelay({ interval: 2, count: 0, scenario: 'basic', venues: ['kalshi'] });

    const commands: BotUserCommand[] = [];
    relay.on('command', (cmd) => commands.push(cmd));

    relay.start();

    // First command fires immediately on start()
    expect(commands).toHaveLength(1);

    // Advance 2 seconds -> second command
    vi.advanceTimersByTime(2000);
    expect(commands).toHaveLength(2);

    // Advance another 2 seconds -> third command
    vi.advanceTimersByTime(2000);
    expect(commands).toHaveLength(3);

    relay.stop();
  });

  it('stops after generating configured count', () => {
    const relay = new SimulatorRelay({ interval: 1, count: 3, scenario: 'basic', venues: ['kalshi'] });

    const commands: BotUserCommand[] = [];
    relay.on('command', (cmd) => commands.push(cmd));

    let stopped = false;
    relay.on('stopped', () => { stopped = true; });

    relay.start();
    // First command fires immediately
    expect(commands).toHaveLength(1);

    vi.advanceTimersByTime(1000); // 2nd
    vi.advanceTimersByTime(1000); // 3rd -- hits count, triggers stop

    expect(commands).toHaveLength(3);

    // Next tick should not generate (stopped)
    vi.advanceTimersByTime(1000);
    expect(commands).toHaveLength(3);
    expect(stopped).toBe(true);
  });

  it('stop clears the interval', () => {
    const relay = new SimulatorRelay({ interval: 1, count: 0, scenario: 'basic', venues: ['kalshi'] });

    const commands: BotUserCommand[] = [];
    relay.on('command', (cmd) => commands.push(cmd));

    relay.start();
    expect(commands).toHaveLength(1);

    relay.stop();

    vi.advanceTimersByTime(5000);
    expect(commands).toHaveLength(1); // No more commands after stop
  });

  it('generates TradeCommand with correct structure', () => {
    const relay = new SimulatorRelay({ interval: 5, count: 1, scenario: 'basic', venues: ['kalshi'] });

    const commands: BotUserCommand[] = [];
    relay.on('command', (cmd) => commands.push(cmd));

    relay.start();

    expect(commands).toHaveLength(1);
    const cmd = commands[0];
    expect(cmd.type).toBe('trade');
    if (cmd.type === 'trade') {
      expect(cmd.id).toBe('sim-cmd-001');
      expect(cmd.market_id).toContain('kalshi:');
      expect(cmd.venue).toBe('kalshi');
      expect(cmd.side).toBeTypeOf('string');
      expect(cmd.action).toBeTypeOf('string');
      expect(cmd.size).toBeGreaterThan(0);
      expect(['market', 'limit']).toContain(cmd.order_type);
    }
  });

  it('tracks stats via recordFill and recordReject', () => {
    const relay = new SimulatorRelay({ interval: 5, count: 0, scenario: 'basic', venues: ['kalshi'] });

    relay.recordFill();
    relay.recordFill();
    relay.recordReject();

    const stats = relay.getStats();
    expect(stats.fills).toBe(2);
    expect(stats.rejects).toBe(1);
  });

  it('uses mixed scenario with multiple venues', () => {
    const relay = new SimulatorRelay({
      interval: 1,
      count: 4,
      scenario: 'mixed',
      venues: ['kalshi', 'binance'],
    });

    const commands: BotUserCommand[] = [];
    relay.on('command', (cmd) => commands.push(cmd));

    relay.start();
    vi.advanceTimersByTime(3000); // fires 3 more (4 total with immediate)

    expect(commands).toHaveLength(4);

    // Should have commands for both venues
    const venues = commands
      .filter((c): c is Extract<typeof c, { type: 'trade' }> => c.type === 'trade')
      .map((c) => c.venue);
    expect(venues).toContain('kalshi');
    expect(venues).toContain('binance');
  });
});

// ============================================================
// Format helpers tests
// ============================================================

describe('Format helpers', () => {
  it('formatFill produces expected output', () => {
    const result = formatFill('kalshi:KXBTCD-SIM', 0.65, 'kalshi-sim-001', '00:05');
    expect(result).toContain('FILL');
    expect(result).toContain('$0.65');
    expect(result).toContain('kalshi-sim-001');
  });

  it('formatReject produces expected output', () => {
    const result = formatReject('kalshi:KXBTCD-SIM', 'insufficient liquidity', '00:10');
    expect(result).toContain('REJ');
    expect(result).toContain('insufficient liquidity');
  });

  it('formatPosition produces expected output', () => {
    const result = formatPosition('kalshi:KXBTCD-SIM', 'yes', 10, 0.65, '00:05');
    expect(result).toContain('POS');
    expect(result).toContain('yes');
    expect(result).toContain('$0.65');
  });

  it('formatSettlement positive P&L', () => {
    const result = formatSettlement('kalshi:KXBTCD-SIM', 0.7, '00:15');
    expect(result).toContain('SETTLE');
    expect(result).toContain('+$0.70');
  });

  it('formatSettlement negative P&L', () => {
    const result = formatSettlement('kalshi:KXBTCD-SIM', -0.3, '00:20');
    expect(result).toContain('SETTLE');
    expect(result).toContain('-$0.30');
  });
});
