# Strategy Templates

Pre-built strategy configurations for the PumpAmp Trading Gateway. Each template targets a specific prediction market trading approach and ships with safe defaults (`dry_run: true`).

## Templates

| Template | Signals | Venues | Description |
|----------|---------|--------|-------------|
| `prediction-arb.json` | cross_venue_arbitrage, prediction_market_inefficiency | kalshi, polymarket | Cross-venue arbitrage between prediction markets |
| `sharp-line-movement.json` | sharp_line_movement | kalshi, polymarket | Follow sharp price movements with momentum |
| `prediction-whale-follow.json` | prediction_large_trade, whale_activity | kalshi, polymarket | Follow large trades and whale activity |
| `prediction-volume-spike.json` | prediction_volume_spike | kalshi, polymarket | Trade volume spikes (momentum + contrarian) |

## Quick Start

1. Copy a template to your gateway root:
   ```bash
   cp templates/prediction-arb.json strategy.json
   ```

2. Validate the configuration:
   ```bash
   pumpamp-gateway strategy validate strategy.json
   ```

3. Run in dry-run mode first to verify signal matching:
   ```bash
   pumpamp-gateway simulate --strategy strategy.json
   ```

4. When ready, set `dry_run` to `false` in your `strategy.json`.

## Listing Templates

Use the CLI to list all available templates:

```bash
pumpamp-gateway strategy list
pumpamp-gateway strategy list --templates-dir /path/to/templates
```

## Customization Guide

### Adjusting Position Sizes

Each rule has an `action.size` field that controls the position size per trade. Start small and increase gradually:

```json
"action": {
  "side": "from_signal",
  "size": 5,
  "order_type": "market"
}
```

### Risk Limits

All templates include a `risk_limits` block:

- `max_position_size_per_market`: Maximum total position size per market
- `max_trades_per_minute`: Rate limit for trade execution
- `market_cooldown_seconds`: Minimum time between trades on the same market
- `signal_dedup_window_seconds`: Window for deduplicating identical signals

### Market Mappings

Prediction markets require explicit mappings from PumpAmp signal market IDs to venue-native IDs. See `sharp-line-movement.json` for an example:

```json
"market_mappings": {
  "kalshi:BTC-100K/YES": "kalshi:KXBTCD-26DEC31",
  "polymarket:BTC-100K/YES": "polymarket:0xabc123:0"
}
```

The arbitrage template (`prediction-arb.json`) does not require mappings because arb signals include venue-native market IDs in the payload.

### Enabling/Disabling Rules

Each rule has an `enabled` field. Set to `false` to disable without removing:

```json
{
  "name": "volume_spike_contrarian",
  "enabled": false,
  ...
}
```

### Documentation Fields

Templates include underscore-prefixed documentation fields that are preserved but ignored by the engine:

- `_description`: Human-readable description of the strategy
- `_usage`: Usage instructions and recommendations
- `_signals`: List of signal names this template handles
