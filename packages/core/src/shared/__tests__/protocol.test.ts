import { describe, it, expect } from 'vitest';
import type {
  TradeCommand,
  CancelCommand,
  CancelAllCommand,
  PauseCommand,
  ResumeCommand,
  PairingConfirmed,
  PairingRevoked,
  HeartbeatReport,
  CommandAckReport,
  OrderUpdateReport,
  PositionReport,
  SettlementReport,
  ErrorReport,
} from '../protocol.js';

describe('BotUserCommand serialization', () => {
  it('Trade command round-trips through JSON.parse(JSON.stringify())', () => {
    const cmd: TradeCommand = {
      type: 'trade',
      id: 'cmd-001',
      market_id: 'BTC-USD-2026-03-01',
      venue: 'kalshi',
      side: 'yes',
      action: 'buy',
      size: 10,
      order_type: 'market',
      limit_price: 0.65,
    };

    const roundTripped = JSON.parse(JSON.stringify(cmd)) as TradeCommand;

    expect(roundTripped).toEqual(cmd);
    expect(roundTripped.type).toBe('trade');
    expect(roundTripped.id).toBe('cmd-001');
    expect(roundTripped.market_id).toBe('BTC-USD-2026-03-01');
    expect(roundTripped.venue).toBe('kalshi');
    expect(roundTripped.side).toBe('yes');
    expect(roundTripped.action).toBe('buy');
    expect(roundTripped.size).toBe(10);
    expect(roundTripped.order_type).toBe('market');
    expect(roundTripped.limit_price).toBe(0.65);
  });

  it('Cancel command serializes with type: "cancel" and order_id', () => {
    const cmd: CancelCommand = {
      type: 'cancel',
      id: 'cmd-002',
      order_id: 'ord-abc-123',
    };

    const json = JSON.parse(JSON.stringify(cmd));

    expect(json).toEqual({
      type: 'cancel',
      id: 'cmd-002',
      order_id: 'ord-abc-123',
    });
  });

  it('Cancel_all command serializes with type: "cancel_all"', () => {
    const cmd: CancelAllCommand = {
      type: 'cancel_all',
      id: 'cmd-003',
    };

    const json = JSON.parse(JSON.stringify(cmd));

    expect(json).toEqual({
      type: 'cancel_all',
      id: 'cmd-003',
    });
  });

  it('Pause command serializes with type: "pause"', () => {
    const cmd: PauseCommand = {
      type: 'pause',
      id: 'cmd-004',
    };

    const json = JSON.parse(JSON.stringify(cmd));

    expect(json).toEqual({
      type: 'pause',
      id: 'cmd-004',
    });
  });

  it('Resume command serializes with type: "resume"', () => {
    const cmd: ResumeCommand = {
      type: 'resume',
      id: 'cmd-005',
    };

    const json = JSON.parse(JSON.stringify(cmd));

    expect(json).toEqual({
      type: 'resume',
      id: 'cmd-005',
    });
  });

  it('Trade command with optional limit_price omitted', () => {
    const cmd: TradeCommand = {
      type: 'trade',
      id: 'cmd-006',
      market_id: 'ETH-USD',
      venue: 'binance',
      side: 'buy',
      action: 'open',
      size: 1.5,
      order_type: 'market',
    };

    const json = JSON.parse(JSON.stringify(cmd));

    expect(json.type).toBe('trade');
    expect(json).not.toHaveProperty('limit_price');
  });

  it('Trade command with limit_price present', () => {
    const cmd: TradeCommand = {
      type: 'trade',
      id: 'cmd-007',
      market_id: 'ETH-USD',
      venue: 'binance',
      side: 'buy',
      action: 'open',
      size: 1.5,
      order_type: 'limit',
      limit_price: 3200.50,
    };

    const json = JSON.parse(JSON.stringify(cmd));

    expect(json.type).toBe('trade');
    expect(json.limit_price).toBe(3200.50);
    expect(typeof json.limit_price).toBe('number');
  });
});

describe('RelayControlMessage serialization', () => {
  it('PairingConfirmed deserializes from JSON', () => {
    const raw = JSON.stringify({
      type: 'pairing_confirmed',
      pairing_id: 'pair-abc-123',
      relay_session_id: 'sess-xyz-789',
    });

    const msg = JSON.parse(raw) as PairingConfirmed;

    expect(msg.type).toBe('pairing_confirmed');
    expect(msg.pairing_id).toBe('pair-abc-123');
    expect(msg.relay_session_id).toBe('sess-xyz-789');
  });

  it('PairingRevoked deserializes from JSON', () => {
    const raw = JSON.stringify({
      type: 'pairing_revoked',
      pairing_id: 'pair-abc-123',
      reason: 'User revoked pairing from dashboard',
    });

    const msg = JSON.parse(raw) as PairingRevoked;

    expect(msg.type).toBe('pairing_revoked');
    expect(msg.pairing_id).toBe('pair-abc-123');
    expect(typeof msg.reason).toBe('string');
    expect(msg.reason).toBe('User revoked pairing from dashboard');
  });
});

describe('RelayReport serialization', () => {
  it('Heartbeat report serializes correctly', () => {
    const report: HeartbeatReport = {
      type: 'heartbeat',
      uptime_secs: 3600,
      version: '0.1.0',
      strategy_status: 'running',
      connected_venues: ['kalshi', 'binance'],
      open_orders: 3,
      open_positions: 2,
    };

    const json = JSON.parse(JSON.stringify(report));

    expect(json.type).toBe('heartbeat');
    expect(json.uptime_secs).toBe(3600);
    expect(json.version).toBe('0.1.0');
    expect(json.strategy_status).toBe('running');
    expect(json.connected_venues).toEqual(['kalshi', 'binance']);
    expect(json.open_orders).toBe(3);
    expect(json.open_positions).toBe(2);
  });

  it('CommandAck report serializes correctly', () => {
    const report: CommandAckReport = {
      type: 'command_ack',
      command_id: 'cmd-001',
      status: 'accepted',
    };

    const json = JSON.parse(JSON.stringify(report));

    expect(json.type).toBe('command_ack');
    expect(json.command_id).toBe('cmd-001');
    expect(json.status).toBe('accepted');
  });

  it('OrderUpdate report with all fields', () => {
    const report: OrderUpdateReport = {
      type: 'order_update',
      order_id: 'ord-001',
      venue: 'kalshi',
      venue_order_id: 'kalshi-ord-xyz',
      market_id: 'BTC-USD-2026-03-01',
      status: 'filled',
      side: 'yes',
      action: 'buy',
      size: 10,
      fill_price: 0.72,
      filled_at: '2026-02-11T10:30:00Z',
    };

    const json = JSON.parse(JSON.stringify(report));

    expect(json.type).toBe('order_update');
    expect(json.order_id).toBe('ord-001');
    expect(json.venue).toBe('kalshi');
    expect(json.venue_order_id).toBe('kalshi-ord-xyz');
    expect(json.market_id).toBe('BTC-USD-2026-03-01');
    expect(json.status).toBe('filled');
    expect(json.side).toBe('yes');
    expect(json.action).toBe('buy');
    expect(json.size).toBe(10);
    expect(json.fill_price).toBe(0.72);
    expect(json.filled_at).toBe('2026-02-11T10:30:00Z');
  });

  it('OrderUpdate report with only required fields', () => {
    const report: OrderUpdateReport = {
      type: 'order_update',
      order_id: 'ord-002',
      venue: 'binance',
      market_id: 'ETH-USD',
      status: 'submitted',
      side: 'buy',
      action: 'open',
      size: 1.5,
    };

    const json = JSON.parse(JSON.stringify(report));

    expect(json.type).toBe('order_update');
    expect(json.order_id).toBe('ord-002');
    expect(json.venue).toBe('binance');
    expect(json.market_id).toBe('ETH-USD');
    expect(json.status).toBe('submitted');
    expect(json.side).toBe('buy');
    expect(json.action).toBe('open');
    expect(json.size).toBe(1.5);
    expect(json).not.toHaveProperty('venue_order_id');
    expect(json).not.toHaveProperty('fill_price');
    expect(json).not.toHaveProperty('filled_at');
  });

  it('Position report serializes correctly', () => {
    const report: PositionReport = {
      type: 'position',
      venue: 'kalshi',
      market_id: 'BTC-100K-2026-03-01',
      side: 'yes',
      size: 20,
      entry_price: 0.55,
      current_price: 0.68,
      unrealized_pnl: 2.6,
      contract_expires_at: '2026-03-01T00:00:00Z',
    };

    const json = JSON.parse(JSON.stringify(report));

    expect(json.type).toBe('position');
    expect(json.venue).toBe('kalshi');
    expect(json.market_id).toBe('BTC-100K-2026-03-01');
    expect(json.side).toBe('yes');
    expect(json.size).toBe(20);
    expect(json.entry_price).toBe(0.55);
    expect(json.current_price).toBe(0.68);
    expect(json.unrealized_pnl).toBe(2.6);
    expect(json.contract_expires_at).toBe('2026-03-01T00:00:00Z');
  });

  it('Settlement report serializes correctly', () => {
    const report: SettlementReport = {
      type: 'settlement',
      venue: 'kalshi',
      market_id: 'BTC-100K-2026-02-01',
      result: 'win',
      entry_price: 0.45,
      settlement_price: 1.0,
      realized_pnl: 11.0,
    };

    const json = JSON.parse(JSON.stringify(report));

    expect(json.type).toBe('settlement');
    expect(json.venue).toBe('kalshi');
    expect(json.market_id).toBe('BTC-100K-2026-02-01');
    expect(json.result).toBe('win');
    expect(json.entry_price).toBe(0.45);
    expect(json.settlement_price).toBe(1.0);
    expect(json.realized_pnl).toBe(11.0);
  });

  it('Error report with command_id', () => {
    const report: ErrorReport = {
      type: 'error',
      code: 'INSUFFICIENT_BALANCE',
      venue: 'kalshi',
      message: 'Not enough balance to place order',
      command_id: 'cmd-010',
    };

    const json = JSON.parse(JSON.stringify(report));

    expect(json.type).toBe('error');
    expect(json.code).toBe('INSUFFICIENT_BALANCE');
    expect(json.message).toBe('Not enough balance to place order');
    expect(json.command_id).toBe('cmd-010');
  });

  it('Error report without command_id', () => {
    const report: ErrorReport = {
      type: 'error',
      code: 'CONNECTION_LOST',
      message: 'WebSocket connection to venue dropped',
    };

    const json = JSON.parse(JSON.stringify(report));

    expect(json.type).toBe('error');
    expect(json.code).toBe('CONNECTION_LOST');
    expect(json.message).toBe('WebSocket connection to venue dropped');
    expect(json).not.toHaveProperty('command_id');
  });
});
