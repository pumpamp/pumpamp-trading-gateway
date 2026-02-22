// ============================================================
// Polymarket VenueConnector Implementation
// Uses the official @polymarket/clob-client for order building,
// signing, and API communication.
// ============================================================

import type { VenueConnector, OrderRequest, OrderResult, Position, Balance } from '@pumpamp/core';
import { ClobClient, Chain, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

export interface PolymarketConnectorConfig {
  apiUrl: string;
  privateKey: string;
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
  proxyAddress?: string;
}

interface CachedMarket {
  yes: string;
  no: string;
  feeRateBps: number;
  negRisk: boolean;
  fetchedAt: number;
}

export class PolymarketConnector implements VenueConnector {
  readonly venue = 'polymarket';
  private client: ClobClient;
  private readonly config: PolymarketConnectorConfig;
  private readonly wallet: Wallet;
  private healthy = false;
  private lastHealthCheck = 0;
  private readonly HEALTH_CHECK_INTERVAL = 30_000;
  private readonly TOKEN_CACHE_TTL = 300_000; // 5 minutes
  private marketCache = new Map<string, CachedMarket>();

  constructor(config: PolymarketConnectorConfig) {
    this.config = config;
    this.wallet = new Wallet(config.privateKey);

    // signatureType: 0 = EOA (no proxy), 1 = POLY_PROXY (proxy wallet holds funds)
    const signatureType = config.proxyAddress ? 1 : 0;

    // Create initial client -- may be without API creds if auto-deriving
    const creds = config.apiKey && config.apiSecret && config.passphrase
      ? { key: config.apiKey, secret: config.apiSecret, passphrase: config.passphrase }
      : undefined;

    this.client = new ClobClient(
      config.apiUrl,
      Chain.POLYGON,
      this.wallet,
      creds,
      signatureType,
      config.proxyAddress,
    );
  }

  async connect(): Promise<void> {
    try {
      // Auto-derive API credentials from private key if not explicitly provided
      if (!this.config.apiKey || !this.config.apiSecret || !this.config.passphrase) {
        const derived = await this.client.deriveApiKey();
        const signatureType = this.config.proxyAddress ? 1 : 0;

        // Re-create client with derived credentials
        this.client = new ClobClient(
          this.config.apiUrl,
          Chain.POLYGON,
          this.wallet,
          { key: derived.key, secret: derived.secret, passphrase: derived.passphrase },
          signatureType,
          this.config.proxyAddress,
        );
      }

      await this.client.getOpenOrders();
      this.healthy = true;
      this.lastHealthCheck = Date.now();
    } catch (error) {
      this.healthy = false;
      throw new Error(`Polymarket connection failed: ${(error as Error).message}`);
    }
  }

  async disconnect(): Promise<void> {
    this.healthy = false;
  }

  // Resolve a condition_id to market metadata (token_ids, fee rate) via GET /markets/{condition_id}
  private async resolveMarket(conditionId: string): Promise<CachedMarket> {
    const cached = this.marketCache.get(conditionId);
    if (cached && Date.now() - cached.fetchedAt < this.TOKEN_CACHE_TTL) {
      return cached;
    }

    const market = await this.client.getMarket(conditionId);
    const tokens: Array<{ token_id: string; outcome: string }> = market.tokens ?? [];

    if (tokens.length < 2) {
      throw new Error(`Market ${conditionId} has ${tokens.length} tokens, expected 2`);
    }

    // First token = Yes/Up outcome, second = No/Down
    const entry: CachedMarket = {
      yes: tokens[0].token_id,
      no: tokens[1].token_id,
      feeRateBps: market.maker_base_fee ?? market.taker_base_fee ?? 0,
      negRisk: market.neg_risk ?? false,
      fetchedAt: Date.now(),
    };
    this.marketCache.set(conditionId, entry);
    return entry;
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    try {
      // Parse market_id: "polymarket:<conditionId>" or "polymarket:<conditionId>:<tokenId>"
      const parts = order.market_id.split(':');
      let tokenId: string;
      let feeRateBps = 0;
      let negRisk = false;

      if (parts.length === 3 && !parts[2].startsWith('0x')) {
        // Explicit token_id provided (e.g., from strategy templates)
        tokenId = parts[2];
        // Still need market metadata for fee rate - resolve via condition_id
        try {
          const mkt = await this.resolveMarket(parts[1]);
          feeRateBps = mkt.feeRateBps;
          negRisk = mkt.negRisk;
        } catch { /* use defaults */ }
      } else {
        // Only condition_id provided - resolve to token_id via API
        const conditionId = parts.length >= 2 ? parts[parts.length - 1] : parts[0];
        const mkt = await this.resolveMarket(conditionId);
        feeRateBps = mkt.feeRateBps;
        negRisk = mkt.negRisk;
        // side: "Yes" -> first token (Up/Yes), "No" -> second token (Down/No)
        const isYes = order.side.toLowerCase() === 'yes' || order.side.toLowerCase() === 'long';
        tokenId = isYes ? mkt.yes : mkt.no;
      }

      // On Polymarket, buying YES or selling NO are both BUY-side on the YES token.
      // The frontend sends side="Yes"/"No" with action="open"/"close".
      // BUY = acquiring the outcome token, SELL = disposing of it.
      const isBuy = order.action === 'open';
      const side = isBuy ? Side.BUY : Side.SELL;

      // For market orders without a limit_price, use extreme boundary to ensure fill:
      // BUY: 0.99 (max valid price), SELL: 0.01 (min valid price)
      // Polymarket prices must be in (0, 1) exclusive. For size=1 at 0.99, the
      // order amount ($0.99) may be below Polymarket's $1 minimum -- use size >= 2.
      const defaultMarketPrice = isBuy ? 0.99 : 0.01;
      const price = order.limit_price ?? defaultMarketPrice;

      // Build and sign the order using the official client
      const signedOrder = await this.client.createOrder({
        tokenID: tokenId,
        side,
        price,
        size: order.size,
        feeRateBps,
        nonce: undefined,
        expiration: 0,
      }, { negRisk });

      // Submit the signed order
      const orderType = order.order_type === 'market' ? OrderType.FOK : OrderType.GTC;
      const response = await this.client.postOrder(signedOrder, orderType);

      return {
        order_id: response.orderID || `polymarket-${Date.now()}`,
        venue_order_id: response.orderID,
        status: response.success ? 'filled' : 'submitted',
        fill_price: order.limit_price,
        filled_at: response.success ? new Date().toISOString() : undefined,
      };
    } catch (error) {
      return {
        order_id: `polymarket-${Date.now()}`,
        status: 'rejected',
        error: (error as Error).message,
      };
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    try {
      await this.client.cancelOrder({ orderID: orderId });
    } catch (error) {
      throw new Error(`Polymarket cancel failed: ${(error as Error).message}`);
    }
  }

  async cancelAllOrders(): Promise<void> {
    try {
      await this.client.cancelAll();
    } catch (error) {
      throw new Error(`Polymarket cancel all failed: ${(error as Error).message}`);
    }
  }

  /**
   * Not yet implemented. Polymarket's CLOB API does not expose a single
   * positions endpoint; retrieving positions requires on-chain queries
   * against the CTF Exchange contract. Returns an empty array for now.
   */
  async getPositions(): Promise<Position[]> {
    return [];
  }

  /**
   * Not yet implemented. Polymarket balances live in a proxy contract
   * wallet and require on-chain reads. Returns zero balances for now.
   */
  async getBalance(): Promise<Balance> {
    return {
      venue: 'polymarket',
      available: 0,
      total: 0,
      currency: 'USDC',
    };
  }

  isHealthy(): boolean {
    const now = Date.now();
    if (now - this.lastHealthCheck > this.HEALTH_CHECK_INTERVAL) {
      this.checkHealth();
    }
    return this.healthy;
  }

  private async checkHealth(): Promise<void> {
    try {
      await this.client.getOpenOrders();
      this.healthy = true;
    } catch {
      this.healthy = false;
    } finally {
      this.lastHealthCheck = Date.now();
    }
  }
}
