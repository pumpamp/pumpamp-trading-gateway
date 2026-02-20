import { ethers } from 'ethers';
import { signAction } from './hyperliquid-auth.js';
import type {
  HyperliquidAction,
  HyperliquidOrderRequest,
  HyperliquidOrderResponse,
  ClearinghouseState,
  HyperliquidMeta,
} from './types.js';

// ============================================================
// Hyperliquid REST API client
// ============================================================

const EXCHANGE_ENDPOINT = 'https://api.hyperliquid.xyz/exchange';
const INFO_ENDPOINT = 'https://api.hyperliquid.xyz/info';

export interface HyperliquidConfig {
  privateKey: string;
  vaultAddress?: string;
  isMainnet?: boolean;
}

export class HyperliquidApi {
  private wallet: ethers.Wallet;
  private vaultAddress?: string;
  private isMainnet: boolean;

  constructor(config: HyperliquidConfig) {
    this.wallet = new ethers.Wallet(config.privateKey);
    this.vaultAddress = config.vaultAddress;
    this.isMainnet = config.isMainnet ?? true;
  }

  get address(): string {
    return this.wallet.address;
  }

  /**
   * Sign and POST an action to the exchange endpoint
   */
  private async postExchangeAction(action: HyperliquidAction): Promise<any> {
    const nonce = Date.now();
    const signature = await signAction(
      this.wallet,
      action,
      nonce,
      this.vaultAddress
    );

    const payload = {
      action,
      nonce,
      signature,
      vaultAddress: this.vaultAddress ?? null,
    };

    const response = await fetch(EXCHANGE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Hyperliquid exchange error: ${response.status} ${text}`);
    }

    return response.json();
  }

  /**
   * POST a read-only query to the info endpoint
   */
  private async postInfo(request: object): Promise<any> {
    const response = await fetch(INFO_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Hyperliquid info error: ${response.status} ${text}`);
    }

    return response.json();
  }

  /**
   * Place an order
   * @param order - Hyperliquid order request
   * @returns Order response with status
   */
  async placeOrder(
    order: HyperliquidOrderRequest
  ): Promise<HyperliquidOrderResponse> {
    const action: HyperliquidAction = {
      type: 'order',
      orders: [order],
    };

    return this.postExchangeAction(action);
  }

  /**
   * Cancel a specific order by ID
   * @param asset - Asset index
   * @param orderId - Order ID (oid)
   */
  async cancelOrder(asset: number, orderId: number): Promise<any> {
    const action: HyperliquidAction = {
      type: 'cancel',
      cancels: [{ a: asset, o: orderId }],
    };

    return this.postExchangeAction(action);
  }

  /**
   * Cancel all open orders
   * This is achieved by fetching open orders first, then canceling each
   */
  async cancelAllOrders(): Promise<void> {
    const _state = await this.getClearinghouseState();
    const openOrders = await this.getOpenOrders();

    if (openOrders.length === 0) {
      return;
    }

    const cancels = openOrders.map((order: any) => ({
      a: order.coin,
      o: order.oid,
    }));

    const action: HyperliquidAction = {
      type: 'cancel',
      cancels,
    };

    await this.postExchangeAction(action);
  }

  /**
   * Get clearinghouse state (positions and balances)
   */
  async getClearinghouseState(): Promise<ClearinghouseState> {
    return this.postInfo({
      type: 'clearinghouseState',
      user: this.wallet.address,
    });
  }

  /**
   * Get open orders
   */
  async getOpenOrders(): Promise<any[]> {
    return this.postInfo({
      type: 'openOrders',
      user: this.wallet.address,
    });
  }

  /**
   * Get asset metadata (universe)
   */
  async getMeta(): Promise<HyperliquidMeta> {
    return this.postInfo({
      type: 'meta',
    });
  }

  /**
   * Get positions from clearinghouse state
   */
  async getPositions(): Promise<ClearinghouseState['assetPositions']> {
    const state = await this.getClearinghouseState();
    return state.assetPositions.filter((p) => parseFloat(p.position.szi) !== 0);
  }

  /**
   * Get balance (withdrawable + total account value)
   */
  async getBalance(): Promise<{
    available: number;
    total: number;
  }> {
    const state = await this.getClearinghouseState();
    return {
      available: parseFloat(state.withdrawable),
      total: parseFloat(state.marginSummary.accountValue),
    };
  }
}
