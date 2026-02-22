// --- Commands: PumpAmp -> Gateway ---

export type TradeCommand = {
  type: 'trade';
  id: string;
  market_id: string;
  venue: string;
  side: string;
  action: string;
  size: number;
  order_type: string;
  limit_price?: number;
};

export type CancelCommand = {
  type: 'cancel';
  id: string;
  order_id: string;
};

export type CancelAllCommand = {
  type: 'cancel_all';
  id: string;
};

export type PauseCommand = {
  type: 'pause';
  id: string;
};

export type ResumeCommand = {
  type: 'resume';
  id: string;
};

export type BotUserCommand =
  | TradeCommand
  | CancelCommand
  | CancelAllCommand
  | PauseCommand
  | ResumeCommand;

// --- Control messages: Relay -> Gateway (server-only) ---

export type PairingConfirmed = {
  type: 'pairing_confirmed';
  pairing_id: string;
  relay_session_id: string;
};

export type PairingRevoked = {
  type: 'pairing_revoked';
  pairing_id: string;
  reason: string;
};

export type RelayControlMessage = PairingConfirmed | PairingRevoked;

// --- Reports: Gateway -> PumpAmp ---

export type HeartbeatReport = {
  type: 'heartbeat';
  uptime_secs: number;
  version: string;
  strategy_status: string;
  connected_venues: string[];
  open_orders: number;
  open_positions: number;
  strategy_metrics?: {
    signals_received: number;
    signals_matched: number;
    trades_generated: number;
    trades_rejected_by_risk: number;
    dry_run_trades: number;
    signals_dropped_stale_or_duplicate: number;
  };
};

export type CommandAckReport = {
  type: 'command_ack';
  command_id: string;
  status: string;
};

export type OrderUpdateReport = {
  type: 'order_update';
  order_id: string;
  command_id?: string;
  venue: string;
  venue_order_id?: string;
  market_id: string;
  status: string;
  side: string;
  action: string;
  size: number;
  order_type?: string;
  limit_price?: number;
  fill_price?: number;
  filled_at?: string;
};

export type PositionReport = {
  type: 'position';
  venue: string;
  market_id: string;
  side: string;
  size: number;
  entry_price: number;
  current_price?: number;
  unrealized_pnl?: number;
  contract_expires_at?: string;
};

export type SettlementReport = {
  type: 'settlement';
  venue: string;
  market_id: string;
  result: string;
  entry_price: number;
  settlement_price: number;
  realized_pnl: number;
  timestamp: string;
};

export type ErrorReport = {
  type: 'error';
  code: string;
  venue?: string;
  message: string;
  command_id?: string;
};

export type RelayReport =
  | HeartbeatReport
  | CommandAckReport
  | OrderUpdateReport
  | PositionReport
  | SettlementReport
  | ErrorReport;

// --- Incoming message union (what the gateway receives over WS) ---
export type IncomingRelayMessage = BotUserCommand | RelayControlMessage;

// --- ArbitragePayloadV1: cross-venue arbitrage signal payload ---

export interface ArbitragePayloadV1 {
  version: number;
  pair_id: string;
  pair_name: string;
  direction: string;
  buy_venue: string;
  sell_venue: string;
  buy_market_id: string;
  sell_market_id: string;
  buy_price: string;
  sell_price: string;
  gross_spread_pct: string;
  net_spread_pct: string;
  liquidity_used_usd: string;
  potential_profit_usd: string;
  emitted_at: string;
  /** Strategy type (directional or super_hedge) */
  strategy?: string;
  /** Outcome being bought (Yes or No) */
  buy_outcome?: string;
  /** Outcome being sold (Yes or No) */
  sell_outcome?: string;
  /** Best super-hedge pattern (A or B) */
  pattern?: string;
  /** Window end time for 15m ephemeral pairs (ISO 8601) */
  window_end_utc?: string;
  /** Signal cutoff time for 15m ephemeral pairs (ISO 8601) */
  signal_cutoff_utc?: string;
}

// --- Shared types for VenueConnector interface ---

export interface OrderRequest {
  market_id: string;
  venue: string;
  side: string;
  action: string;
  size: number;
  order_type: 'market' | 'limit';
  limit_price?: number;
  command_id: string;
}

export interface OrderResult {
  order_id: string;
  venue_order_id?: string;
  status: 'submitted' | 'filled' | 'rejected' | 'cancelled';
  fill_price?: number;
  filled_at?: string;
  error?: string;
}

export interface Position {
  venue: string;
  market_id: string;
  side: string;
  size: number;
  entry_price: number;
  current_price?: number;
  unrealized_pnl?: number;
  contract_expires_at?: string;
}

export interface Balance {
  venue: string;
  available: number;
  total: number;
  currency: string;
}

export interface Settlement {
  venue: string;
  market_id: string;
  result: string;
  entry_price: number;
  settlement_price: number;
  realized_pnl: number;
  timestamp?: string;
}
