import { describe, it, expect, beforeEach } from 'vitest';
import { PositionTracker } from '../position-tracker.js';
import type { Position, Settlement } from '../../../shared/protocol.js';

// ============================================================
// Helpers
// ============================================================

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    venue: 'kalshi',
    market_id: 'KXBTCD-26FEB11',
    side: 'yes',
    size: 10,
    entry_price: 0.55,
    ...overrides,
  };
}

function makeSettlement(overrides: Partial<Settlement> = {}): Settlement {
  return {
    venue: 'kalshi',
    market_id: 'KXBTCD-26FEB11',
    result: 'win',
    entry_price: 0.55,
    settlement_price: 1.0,
    realized_pnl: 4.5,
    ...overrides,
  };
}

// ============================================================
// ============================================================

describe('Position aggregation', () => {
  let tracker: PositionTracker;

  beforeEach(() => {
    tracker = new PositionTracker();
  });

  it('updatePosition adds a new position', () => {
    const position = makePosition();

    tracker.updatePosition(position);

    const positions = tracker.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].venue).toBe('kalshi');
    expect(positions[0].market_id).toBe('KXBTCD-26FEB11');
    expect(positions[0].side).toBe('yes');
    expect(positions[0].size).toBe(10);
    expect(positions[0].entry_price).toBe(0.55);
  });

  it('updatePosition with same venue:market_id upserts (count stays 1)', () => {
    const position1 = makePosition({ size: 10, entry_price: 0.55 });
    const position2 = makePosition({ size: 20, entry_price: 0.60 });

    tracker.updatePosition(position1);
    tracker.updatePosition(position2);

    const positions = tracker.getPositions();
    expect(positions).toHaveLength(1);
    // Should reflect the second (updated) values
    expect(positions[0].size).toBe(20);
    expect(positions[0].entry_price).toBe(0.60);
  });

  it('multiple positions from different venues are all returned', () => {
    const kalshiPos = makePosition({ venue: 'kalshi', market_id: 'KXBTCD-26FEB11' });
    const binancePos = makePosition({ venue: 'binance', market_id: 'BTCUSDT' });
    const polyPos = makePosition({ venue: 'polymarket', market_id: '0xabc123' });

    tracker.updatePosition(kalshiPos);
    tracker.updatePosition(binancePos);
    tracker.updatePosition(polyPos);

    const positions = tracker.getPositions();
    expect(positions).toHaveLength(3);

    const venues = positions.map((p) => p.venue).sort();
    expect(venues).toEqual(['binance', 'kalshi', 'polymarket']);
  });

  it('removePosition removes by venue:market_id key', () => {
    const pos1 = makePosition({ venue: 'kalshi', market_id: 'KXBTCD-26FEB11' });
    const pos2 = makePosition({ venue: 'binance', market_id: 'BTCUSDT' });

    tracker.updatePosition(pos1);
    tracker.updatePosition(pos2);
    expect(tracker.getPositions()).toHaveLength(2);

    tracker.removePosition('kalshi', 'KXBTCD-26FEB11');

    const remaining = tracker.getPositions();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].venue).toBe('binance');
    expect(remaining[0].market_id).toBe('BTCUSDT');
  });
});

// ============================================================
// ============================================================

describe('P&L computation', () => {
  let tracker: PositionTracker;

  beforeEach(() => {
    tracker = new PositionTracker();
  });

  it('long position P&L: (current - entry) * size (positive)', () => {
    const position = makePosition({
      side: 'yes',
      size: 10,
      entry_price: 0.55,
      current_price: 0.75,
    });

    tracker.updatePosition(position);

    const positions = tracker.getPositions();
    expect(positions).toHaveLength(1);
    // (0.75 - 0.55) * 10 = 2.0
    expect(positions[0].unrealized_pnl).toBeCloseTo(2.0, 10);
  });

  it('long position negative P&L: price decreased', () => {
    const position = makePosition({
      side: 'buy',
      size: 20,
      entry_price: 0.60,
      current_price: 0.45,
    });

    tracker.updatePosition(position);

    const positions = tracker.getPositions();
    expect(positions).toHaveLength(1);
    // (0.45 - 0.60) * 20 = -3.0
    expect(positions[0].unrealized_pnl).toBeCloseTo(-3.0, 10);
  });

  it('short position P&L: (entry - current) * size', () => {
    const position = makePosition({
      side: 'no',
      size: 15,
      entry_price: 0.70,
      current_price: 0.50,
    });

    tracker.updatePosition(position);

    const positions = tracker.getPositions();
    expect(positions).toHaveLength(1);
    // (0.70 - 0.50) * 15 = 3.0
    expect(positions[0].unrealized_pnl).toBeCloseTo(3.0, 10);
  });

  it('position with no current_price: P&L is undefined', () => {
    const position = makePosition({
      side: 'yes',
      size: 10,
      entry_price: 0.55,
      // current_price intentionally omitted
    });

    tracker.updatePosition(position);

    const positions = tracker.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].unrealized_pnl).toBeUndefined();
  });
});

// ============================================================
// ============================================================

describe('Settlement detection', () => {
  let tracker: PositionTracker;

  beforeEach(() => {
    tracker = new PositionTracker();
  });

  it('addSettlement records the settlement', () => {
    const settlement = makeSettlement();

    tracker.addSettlement(settlement);

    const settlements = tracker.getSettlements();
    expect(settlements).toHaveLength(1);
    expect(settlements[0].venue).toBe('kalshi');
    expect(settlements[0].market_id).toBe('KXBTCD-26FEB11');
    expect(settlements[0].result).toBe('win');
    expect(settlements[0].entry_price).toBe(0.55);
    expect(settlements[0].settlement_price).toBe(1.0);
    expect(settlements[0].realized_pnl).toBe(4.5);
  });

  it('addSettlement removes the corresponding position', () => {
    // Add a position first
    const position = makePosition({
      venue: 'kalshi',
      market_id: 'KXBTCD-26FEB11',
      current_price: 0.90,
    });
    tracker.updatePosition(position);
    expect(tracker.getPositions()).toHaveLength(1);

    // Settle it
    const settlement = makeSettlement({
      venue: 'kalshi',
      market_id: 'KXBTCD-26FEB11',
    });
    tracker.addSettlement(settlement);

    // Position should be removed
    expect(tracker.getPositions()).toHaveLength(0);
    // Settlement should be recorded
    expect(tracker.getSettlements()).toHaveLength(1);
  });

  it('settlement event is emitted', () => {
    const emittedSettlements: Settlement[] = [];
    tracker.on('settlement', (s: Settlement) => emittedSettlements.push(s));

    const settlement = makeSettlement({ result: 'loss', realized_pnl: -5.5 });
    tracker.addSettlement(settlement);

    expect(emittedSettlements).toHaveLength(1);
    expect(emittedSettlements[0].result).toBe('loss');
    expect(emittedSettlements[0].realized_pnl).toBe(-5.5);
  });

  it('realized P&L is computed correctly from settlement data', () => {
    // Add position then settle - verify the settlement carries correct realized P&L
    const position = makePosition({
      venue: 'kalshi',
      market_id: 'KXBTCD-26FEB11',
      side: 'yes',
      size: 10,
      entry_price: 0.45,
      current_price: 0.90,
    });
    tracker.updatePosition(position);

    // Settlement: bought at 0.45, settled at 1.0 for 10 contracts
    // Realized P&L = (1.0 - 0.45) * 10 = 5.5
    const settlement = makeSettlement({
      venue: 'kalshi',
      market_id: 'KXBTCD-26FEB11',
      entry_price: 0.45,
      settlement_price: 1.0,
      realized_pnl: 5.5,
    });

    const emittedSettlements: Settlement[] = [];
    tracker.on('settlement', (s: Settlement) => emittedSettlements.push(s));

    tracker.addSettlement(settlement);

    expect(emittedSettlements).toHaveLength(1);
    expect(emittedSettlements[0].realized_pnl).toBeCloseTo(5.5, 10);
    expect(emittedSettlements[0].entry_price).toBe(0.45);
    expect(emittedSettlements[0].settlement_price).toBe(1.0);

    // Position should be gone, settlement recorded
    expect(tracker.getPositions()).toHaveLength(0);
    expect(tracker.getSettlements()).toHaveLength(1);
  });
});
