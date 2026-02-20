// Binance-specific types for API requests and responses

export interface BinanceOrderRequest {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  quantity?: number;
  price?: number;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  reduceOnly?: boolean;
  positionSide?: 'BOTH' | 'LONG' | 'SHORT';
  timestamp: number;
  recvWindow?: number;
}

export interface BinanceOrderResponse {
  orderId: number;
  symbol: string;
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';
  clientOrderId: string;
  price: string;
  avgPrice: string;
  origQty: string;
  executedQty: string;
  cumQty: string;
  cumQuote: string;
  timeInForce: string;
  type: string;
  reduceOnly: boolean;
  closePosition: boolean;
  side: 'BUY' | 'SELL';
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  stopPrice: string;
  workingType: string;
  priceProtect: boolean;
  origType: string;
  updateTime: number;
}

export interface BinancePosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  maxNotionalValue: string;
  marginType: string;
  isolatedMargin: string;
  isAutoAddMargin: string;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  notional: string;
  isolatedWallet: string;
  updateTime: number;
}

export interface BinanceBalance {
  accountAlias: string;
  asset: string;
  balance: string;
  crossWalletBalance: string;
  crossUnPnl: string;
  availableBalance: string;
  maxWithdrawAmount: string;
  marginAvailable: boolean;
  updateTime: number;
}

export interface BinanceSpotBalance {
  asset: string;
  free: string;
  locked: string;
}

export interface BinanceSpotAccount {
  makerCommission: number;
  takerCommission: number;
  buyerCommission: number;
  sellerCommission: number;
  canTrade: boolean;
  canWithdraw: boolean;
  canDeposit: boolean;
  updateTime: number;
  accountType: string;
  balances: BinanceSpotBalance[];
  permissions: string[];
}

export interface BinanceErrorResponse {
  code: number;
  msg: string;
}
