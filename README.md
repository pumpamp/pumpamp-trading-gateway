# PumpAmp Trading Gateway

Open-source trading gateway for PumpAmp -- execute trades on your exchange accounts from PumpAmp signals.

## Overview

The PumpAmp Trading Gateway is a standalone TypeScript/Node.js application that connects your exchange accounts to PumpAmp's trading signals. It runs on your own infrastructure, keeping your exchange API keys secure and under your control.

**Key features:**
- Connects to PumpAmp relay for real-time trade commands
- Consumes PumpAmp signal stream for automated strategies
- Supports 4 venues: Kalshi, Polymarket, Hyperliquid, Binance
- Built-in [simulation mode](#simulation-mode) -- test the full pipeline without real connections
- Your exchange credentials never leave your machine
- Automatic reconnection with exponential backoff
- Structured logging with automatic secret redaction

## Architecture

```
PumpAmp Cloud                    Your Machine
+-------------------+            +-------------------------+
|  Relay Server     | <------->  | Trading Gateway         |
|  Signal Stream    | <------->  |  +-- Relay Client       |
+-------------------+            |  +-- Signal Consumer    |
                                 |  +-- Order Router       |
                                 |  +-- Position Tracker   |
                                 |  +-- Venue Connectors   |
                                 |      +-- Kalshi         |
                                 |      +-- Polymarket     |
                                 |      +-- Hyperliquid    |
                                 |      +-- Binance        |
                                 +-------------------------+
                                           |
                                 +---------+---------+
                                 | Exchange APIs      |
                                 | (direct from your  |
                                 |  machine only)     |
                                 +--------------------+
```

## Quick Start

### 1. Install

```bash
git clone https://github.com/pumpamp/pumpamp-trading-gateway.git
cd pumpamp-trading-gateway
pnpm install
pnpm build
```

### 2. Set your API key

Generate an API key from the PumpAmp dashboard (Settings > API Keys), then save it:

```bash
node ./packages/core/dist/cli.js api-key pa_live_your_key_here
```

This writes `PUMPAMP_API_KEY` to your `.env` file. 

### 3. Pair with PumpAmp

Generate a pairing code in the PumpAmp dashboard (Settings > Gateways), then:

```bash
node ./packages/core/dist/cli.js pair X7K9M2
```

The pairing ID is saved to `.env` automatically.

### 4. Configure venue credentials

Add your exchange credentials to `.env` (see [Venue Setup Guides](#venue-setup-guides) below):

```bash
# Example: Kalshi
KALSHI_API_KEY=your_kalshi_key
KALSHI_PRIVATE_KEY_PATH=./kalshi.pem
```

### 5. Start

```bash
node ./packages/core/dist/cli.js start
```

### Global Install (optional)

To get the short `pumpamp-gateway` command available system-wide:

```bash
npm install -g .
# or
pnpm link --global
```

After global install, you can use `pumpamp-gateway start` directly instead of the full `node ./packages/core/dist/cli.js start` path.

## Configuration Reference

All configuration is via environment variables (`.env` file).

### Required

| Variable | Description |
|----------|-------------|
| `PUMPAMP_API_KEY` | Your PumpAmp API key (format: `pa_live_...`) |

### Optional (PumpAmp)

| Variable | Default | Description |
|----------|---------|-------------|
| `PUMPAMP_HOST` | `api.pumpamp.com` | PumpAmp API host |
| `PUMPAMP_PAIRING_ID` | (auto-saved) | Pairing ID (saved by `pair` command) |

### Venue Credentials

Each venue requires a complete set of credentials. Partial configuration disables the connector with a warning.

**Kalshi** (2 required):
| Variable | Description |
|----------|-------------|
| `KALSHI_API_KEY` | Kalshi API key |
| `KALSHI_PRIVATE_KEY_PATH` | Path to RSA private key PEM file |

**Polymarket** (1 required):
| Variable | Description |
|----------|-------------|
| `POLYMARKET_PRIVATE_KEY` | Ethereum private key (0x...) |

API credentials (`POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`) are **auto-derived** from the private key on startup using the CLOB client's `deriveApiKey()`. You do not need to copy them from the Polymarket website. If you do provide them explicitly, they will be used as-is.

Polymarket uses a proxy wallet architecture: your private key controls an EOA (Externally Owned Account), and Polymarket assigns a proxy contract wallet that holds your funds. The gateway handles this automatically -- just provide your private key and optionally `POLYMARKET_PROXY_ADDRESS` if you know your proxy address.

**Hyperliquid** (1 required):
| Variable | Description |
|----------|-------------|
| `HYPERLIQUID_PRIVATE_KEY` | Ethereum private key (0x...) |

**Binance** (2 required):
| Variable | Description |
|----------|-------------|
| `BINANCE_API_KEY` | Binance API key |
| `BINANCE_API_SECRET` | Binance API secret |

### Gateway Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `CANCEL_ON_SHUTDOWN` | `false` | Cancel pending orders on shutdown |
| `LOG_LEVEL` | `info` | Log level: trace, debug, info, warn, error, fatal |
| `AUTO_TRADE_ENABLED` | `false` | Enable local auto-trade strategy engine |
| `STRATEGY_CONFIG_PATH` | (unset) | Path to strategy JSON config file |
| `SIMULATE_ORDERS` | `false` | Simulate order execution (see [Simulate Orders Mode](#simulate-orders-mode)) |

## CLI Commands

Run commands via `node ./packages/core/dist/cli.js <command>` after building, or `pumpamp-gateway <command>` if [globally installed](#global-install-optional).

### `api-key <key>`

Save your PumpAmp API key to `.env`. The key must start with `pa_live_`. Get one from the PumpAmp dashboard (Settings > API Keys).

### `start`

Start the gateway with configured venues.

Options:
- `--cancel-on-shutdown` - Cancel pending orders on shutdown
- `--simulate-orders` - Simulate order execution (no real orders sent to venues)

### `pair <code>`

Pair with PumpAmp using a 6-character pairing code from the dashboard. Saves the pairing ID to `.env` automatically.

### `status`

Show gateway configuration: API key (masked), pairing status, configured venues.

### `venues`

List all supported venues and their configuration status.

### `simulate`

Run the gateway in simulation mode -- no PumpAmp connection or real exchange APIs needed. See [Simulation Mode](#simulation-mode) below.

### `strategy validate <path>`

Validate a strategy JSON file and print a summary (rule count, dry_run status).

### `strategy show`

Load strategy from `STRATEGY_CONFIG_PATH` (or `./strategy.json`) and print the resolved config.

## Simulate Orders Mode

Test the full order flow from the PumpAmp dashboard without sending real orders to exchanges. The gateway connects to PumpAmp normally (real relay, real pairing) but replaces all venue connectors with simulators that return instant fills.

This is useful for:
- Smoke-testing the dashboard trade widget end-to-end
- Verifying order routing, position tracking, and reporting
- Onboarding new users before configuring exchange credentials

```bash
# Via CLI flag
node ./packages/core/dist/cli.js start --simulate-orders

# Or via .env
SIMULATE_ORDERS=true
node ./packages/core/dist/cli.js start
```

When active, the gateway logs simulated fills to the console:

```
[SIMULATE] Order simulation mode active - no real orders will be sent
[SIMULATE] Simulated venues: kalshi, polymarket, hyperliquid, binance
[SIMULATE] FILL  kalshi:KXBTCD-26FEB19  yes/buy  10  @ $0.65  order=kalshi-sim-001
```

All 4 venues are available as simulators (no exchange credentials required). Orders fill at 100% rate with 100ms simulated latency and a randomized fill price. Order updates flow back through the relay to the frontend exactly as they would with real venues.

## Simulation Mode

Test the full gateway pipeline without connecting to PumpAmp or real exchanges:

```bash
node ./packages/core/dist/cli.js simulate
```

The simulator creates fake venue connectors and generates synthetic trade commands that flow through the same OrderRouter -> VenueConnector -> PositionTracker pipeline as real commands.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--interval <seconds>` | `5` | Interval between generated commands |
| `--venues <list>` | `kalshi,binance` | Comma-separated simulated venues |
| `--fill-rate <0-1>` | `0.9` | Fraction of orders that fill vs reject |
| `--fill-delay <ms>` | `200` | Simulated fill latency in milliseconds |
| `--count <n>` | `0` | Number of commands to generate (0 = infinite) |
| `--scenario <name>` | `basic` | Pre-built scenario (see below) |
| `--strategy <path>` | (none) | Path to strategy.json for strategy simulation |

### Scenarios

| Scenario | Description |
|----------|-------------|
| `basic` | Alternating buy/sell on one market, all fills |
| `mixed` | Multiple venues, mixed market/limit orders, some rejects |
| `stress` | Rapid cycling across 4 markets, tests error handling |

### Examples

```bash
# Basic simulation with default settings
node ./packages/core/dist/cli.js simulate

# Stress test: fast commands, high reject rate, 20 commands then exit
node ./packages/core/dist/cli.js simulate --scenario stress --interval 1 --fill-rate 0.5 --count 20

# Single venue with slow fills
node ./packages/core/dist/cli.js simulate --venues kalshi --fill-delay 500

# Strategy simulation (signals -> strategy engine -> order router)
node ./packages/core/dist/cli.js simulate --strategy ./strategy.example.json --count 10 --interval 2
```

If globally installed, replace `node ./packages/core/dist/cli.js` with `pumpamp-gateway`.

Press Ctrl+C to stop an infinite simulation. The simulator prints a summary on exit.

## 15-Minute Crypto Prediction Markets

PumpAmp supports binary prediction contracts that settle every 15 minutes on crypto prices. These are available on Kalshi and Polymarket for BTC, ETH, SOL, and XRP.

Each contract asks "Will BTC be above $X at 14:15 UTC?" and settles as Yes (1.00) or No (0.00). New markets are created by the venue every 15 minutes with fresh identifiers.

### Kalshi Ticker Format

Kalshi 15-minute crypto tickers follow the pattern:

```
KXBTC15M-26FEB18T1600-B100000
^^^^^^^  ^^^^^^^^^^^^^^^^^^^^^^^^
prefix   date + time + strike price
```

Prefixes: `KXBTC15M`, `KXETH15M`, `KXSOL15M`, `KXXRP15M`

### Strategy Templates

Two pre-built templates are included for 15-minute crypto markets:

- **`templates/crypto-15m-momentum.json`** - Trades on sharp line movements and breakout signals with 90-second cooldown
- **`templates/crypto-15m-arb.json`** - Cross-venue arbitrage between Kalshi and Polymarket on the same underlying

### Market Mapping

Because Kalshi and Polymarket create new market identifiers every 15 minutes, you must update `market_mappings` in your strategy config with current tickers before each trading session. The PumpAmp dashboard shows active 15-minute markets with their venue-native IDs.

Example mapping:

```json
{
  "market_mappings": {
    "kalshi:BTC/15M": "kalshi:KXBTC15M-26FEB18T1600-B100000",
    "polymarket:BTC/15M": "polymarket:0xabc123...def:0"
  }
}
```

### Quick Start (15m Markets)

```bash
# Copy the 15m momentum template
cp templates/crypto-15m-momentum.json strategy.json

# Edit market_mappings with current tickers from PumpAmp dashboard
# Set dry_run to false when ready to trade live

# Run in strategy simulation mode first
node ./packages/core/dist/cli.js simulate --strategy strategy.json --count 10 --interval 2

# Start the gateway (requires configured .env and active PumpAmp pairing)
STRATEGY_CONFIG_PATH=./strategy.json AUTO_TRADE_ENABLED=true node ./packages/core/dist/cli.js start
```

## Venue Setup Guides

### Kalshi

1. Log in to [Kalshi](https://kalshi.com)
2. Go to Settings > API Keys
3. Create a new API key and download the private key PEM file
4. Set `KALSHI_API_KEY` and `KALSHI_PRIVATE_KEY_PATH` in `.env`

### Polymarket

1. You need an Ethereum wallet with a private key that has been used on [Polymarket](https://polymarket.com)
2. Set `POLYMARKET_PRIVATE_KEY` in `.env`

That's it. The gateway automatically derives the CLOB API credentials from your private key on startup using Polymarket's `deriveApiKey()` method. This is a deterministic derivation -- the same private key always produces the same API credentials, so there is no need to copy key/secret/passphrase from the Polymarket website.

**Why only the private key?** Polymarket's CLOB API credentials are cryptographically derived from your Ethereum private key via an EIP-712 signature. The `deriveApiKey()` function signs a structured message with your key and uses the signature to deterministically generate the API key, secret, and passphrase. This means the API credentials are not independent secrets -- they are a function of your private key. Requiring users to manually copy them from the website was unnecessary friction.

### Hyperliquid

1. You need an Ethereum wallet with a private key
2. Deposit funds to [Hyperliquid](https://app.hyperliquid.xyz)
3. Set `HYPERLIQUID_PRIVATE_KEY` in `.env`

### Binance

1. Log in to [Binance](https://www.binance.com)
2. Go to API Management and create a new API key
3. Enable futures trading if using futures
4. Set `BINANCE_API_KEY` and `BINANCE_API_SECRET` in `.env`
5. Optionally set `BINANCE_FUTURES=true` and `BINANCE_API_URL`

## Security

### Credentials Never Leave Your Machine

Exchange API keys, private keys, and secrets are used **only** for signing requests to exchange APIs directly from your machine. They are **never** included in any message sent to PumpAmp relay or signal endpoints.

### Secret Redaction in Logs

The gateway uses structured logging (pino) with automatic redaction of sensitive fields:
- API keys, secrets, private keys, passphrases
- Auth headers (Authorization, X-MBX-APIKEY, KALSHI-ACCESS-SIGNATURE)
- Query parameters in WebSocket URLs (api_key stripped)

All sensitive values appear as `[REDACTED]` in log output.

### Open Source Audit

This gateway is fully open source (MIT license). You can audit every line of code to verify that credentials are handled safely.

## Development

### Prerequisites

- Node.js 20+
- pnpm 8+

### Install Dependencies

```bash
pnpm install
```

### Build

```bash
pnpm build
```

### Test

```bash
pnpm test
```

### Type Check

```bash
pnpm typecheck
```

### Lint

```bash
pnpm lint
```

## Project Structure

```
pumpamp-trading-gateway/
  packages/
    core/
      src/
        gateway.ts                        # Main orchestrator
        cli.ts                            # CLI commands (start, pair, simulate, etc.)
        index.ts                          # Public exports
        shared/
          config.ts                       # .env loading and validation
          logger.ts                       # Structured logging with secret redaction
          protocol.ts                     # Relay message type definitions
        features/
          execution/
            order-router.ts               # Route commands to venue connectors
            venue-connector.ts            # VenueConnector interface
            position-tracker.ts           # Aggregate positions, compute P&L
          relay/
            relay-client.ts               # WebSocket client to PumpAmp relay
          signals/
            signal-consumer.ts            # WebSocket client to signal stream
          strategy/
            strategy-engine.ts            # Auto-trade strategy engine
            strategy-config.ts            # Strategy config schema and loader
            risk-manager.ts               # Rate limit, cooldown, exposure checks
            market-id-mapper.ts           # Venue:symbol market ID translation
          simulator/
            simulator.ts                  # Simulation mode (fake venues + commands)
            simulator-signal-source.ts    # Synthetic signal generator
          replay/
            replay-consumer.ts            # Historical signal replay engine
    connectors/
      kalshi/               # RSA-PSS authentication
      polymarket/           # EIP-712 + HMAC authentication
      hyperliquid/          # EIP-712 authentication
      binance/              # HMAC-SHA256 authentication
```

## Dependency Notes

The Polymarket connector uses `@ethersproject/wallet` (ethers v5) because it depends on `@polymarket/clob-client` which requires ethers v5. The Hyperliquid connector uses `ethers` v6. Both are isolated in their own packages and do not conflict at runtime.

## Docker

Run the gateway in a container:

```bash
docker build -t pumpamp-gateway .
docker run --env-file .env pumpamp-gateway start
```

Or run simulation mode:

```bash
docker run pumpamp-gateway simulate --count 10 --interval 1
```

## Troubleshooting

### `PUMPAMP_API_KEY is required`

Set your PumpAmp API key in `.env`:
```
PUMPAMP_API_KEY=pa_live_your_key_here
```

### `No connector registered for venue: kalshi`

The venue's credentials are not configured or incomplete. Run `venues` to see which environment variables are missing:
```bash
node ./packages/core/dist/cli.js venues
```

### `Pairing timed out`

Pairing codes expire after 10 minutes. Generate a fresh code from the PumpAmp dashboard and try again. Ensure the gateway can reach the relay server (check `PUMPAMP_HOST`).

### `Strategy config not found`

Copy the example and customize it:
```bash
cp strategy.example.json strategy.json
```

Or set `STRATEGY_CONFIG_PATH` to point to your strategy file.

### `No market mapping found`

Prediction market venues (Kalshi, Polymarket) require explicit `market_mappings` in your strategy config. Crypto venues (Binance, Hyperliquid) resolve automatically. See the [Market Mapping](#market-mapping) section.

### Node.js version

The gateway requires Node.js 20 or later. Check your version:
```bash
node --version
```

## License

MIT License - See [LICENSE](LICENSE) file for details.
