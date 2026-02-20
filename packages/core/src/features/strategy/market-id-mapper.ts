// Prediction market venues where explicit mapping is required
const PREDICTION_VENUES = new Set(['kalshi', 'polymarket']);

export class MarketIdMapper {
  private explicitMappings: Map<string, string>;

  constructor(mappings?: Record<string, string>) {
    this.explicitMappings = new Map(Object.entries(mappings ?? {}));
  }

  /**
   * Resolve a PumpAmp signal market_id to a venue-native TradeCommand market_id.
   *
   * Resolution order:
   * 1. Explicit mapping table (for prediction markets)
   * 2. Convention-based: strip "/" for crypto venues (BTC/USDT -> BTCUSDT)
   * 3. Return null if no mapping found (prediction markets require explicit mapping)
   */
  resolve(signalMarketId: string): string | null {
    if (!signalMarketId) return null;

    // 1. Check explicit mapping table first (takes priority)
    const explicit = this.explicitMappings.get(signalMarketId);
    if (explicit) return explicit;

    // 2. Parse venue:symbol
    const colonIndex = signalMarketId.indexOf(':');
    if (colonIndex === -1) return null;

    const venue = signalMarketId.substring(0, colonIndex);
    const symbol = signalMarketId.substring(colonIndex + 1);

    if (!venue || !symbol) return null;

    // Prediction markets require explicit mapping - no convention fallback
    if (PREDICTION_VENUES.has(venue.toLowerCase())) {
      return null;
    }

    // 3. Convention-based for crypto: strip slash (BTC/USDT -> BTCUSDT)
    if (symbol.includes('/')) {
      return `${venue}:${symbol.replace('/', '')}`;
    }

    // Already in native format
    return signalMarketId;
  }

  /**
   * Replace the mapping table (for config reload).
   */
  loadMappings(mappings: Record<string, string>): void {
    this.explicitMappings = new Map(Object.entries(mappings));
  }
}
