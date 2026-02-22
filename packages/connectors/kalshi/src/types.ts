// ============================================================
// Kalshi API Types
// Based on https://trading-api.readme.io/reference/
// ============================================================

export interface KalshiOrderRequest {
  ticker: string;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  count: number;
  // Kalshi v2 has no "type" field -- order behavior is implicit from price + time_in_force
  yes_price?: number;
  no_price?: number;
  buy_max_cost?: number;
  time_in_force?: 'fill_or_kill' | 'good_till_canceled' | 'immediate_or_cancel';
  expiration_ts?: number;
  client_order_id?: string;
}

export interface KalshiOrderResponse {
  order_id: string;
  ticker: string;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  count: number;
  filled_count?: number;
  yes_price?: number;
  no_price?: number;
  status: 'resting' | 'pending' | 'filled' | 'canceled' | 'rejected';
  created_time: string;
  updated_time?: string;
  client_order_id?: string;
}

export interface KalshiPosition {
  ticker: string;
  position: number;
  market_exposure_cents: number;
  realized_pnl_cents: number;
  fees_paid_cents: number;
  total_traded_cents: number;
  resting_orders_count: number;
}

export interface KalshiBalance {
  balance: number;
  payout: number;
}

export interface KalshiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  open_interest: number;
  close_time: string;
  expiration_time: string;
  result?: 'yes' | 'no';
  status: 'active' | 'closed' | 'settled';
}
