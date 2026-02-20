// ============================================================
// Hyperliquid-specific types for API interaction
// ============================================================

export interface HyperliquidOrderRequest {
  a: number; // asset index
  b: boolean; // isBuy
  p: string; // price (as string)
  s: string; // size (as string)
  r: boolean; // reduce only
  t: {
    limit?: {
      tif: 'Gtc' | 'Ioc' | 'Alo';
    };
  };
}

export interface HyperliquidAction {
  type: 'order' | 'cancel' | 'cancelByCloid' | 'batchModify';
  orders?: HyperliquidOrderRequest[];
  cancels?: Array<{ a: number; o: number }>; // asset, oid
}

export interface HyperliquidSignature {
  r: string;
  s: string;
  v: number;
}

export interface HyperliquidOrderResponse {
  status: 'ok' | 'err';
  response?: {
    type: 'order';
    data?: {
      statuses: Array<{
        resting?: {
          oid: number;
        };
        filled?: {
          oid: number;
          totalSz: string;
          avgPx: string;
        };
        error?: string;
      }>;
    };
  };
}

export interface ClearinghouseState {
  assetPositions: Array<{
    position: {
      coin: string;
      szi: string; // size (signed, positive = long, negative = short)
      entryPx: string; // entry price
      positionValue: string;
      unrealizedPnl: string;
    };
  }>;
  marginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
  };
  crossMarginSummary: {
    crossMaintenanceMarginUsed: string;
  };
  withdrawable: string;
}

export interface HyperliquidMeta {
  universe: Array<{
    name: string;
    szDecimals: number;
  }>;
}
