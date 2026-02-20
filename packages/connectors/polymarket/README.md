# @pumpamp/connector-polymarket

Polymarket prediction market connector for PumpAmp Trading Gateway.

## Overview

This connector implements the `VenueConnector` interface for Polymarket, enabling automated trading on Polymarket binary outcome markets through the PumpAmp Trading Gateway. It uses the official `@polymarket/clob-client` for order building, signing, and API communication.

## Features

- **Official CLOB Client**: Uses `@polymarket/clob-client` for EIP-712 order signing
- **Automatic Market Resolution**: Resolves condition IDs to token IDs via the Polymarket API
- **Token Caching**: 5-minute TTL cache for market metadata (token IDs, fee rates)
- **Proxy Wallet Support**: EOA and POLY_PROXY signature types
- **Order Management**: Place, cancel, and track orders
- **Health Checks**: 30-second periodic health monitoring
- **Neg-Risk Support**: Handles neg-risk markets automatically

## Configuration

### Environment Variables

```env
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_API_KEY=your-clob-api-key
POLYMARKET_API_SECRET=your-clob-api-secret
POLYMARKET_API_PASSPHRASE=your-clob-passphrase
POLYMARKET_PROXY_ADDRESS=0x...
POLYMARKET_API_URL=https://clob.polymarket.com
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POLYMARKET_PRIVATE_KEY` | Yes | - | Ethereum private key (0x...) |
| `POLYMARKET_API_KEY` | Yes | - | CLOB API key |
| `POLYMARKET_API_SECRET` | Yes | - | CLOB API secret |
| `POLYMARKET_API_PASSPHRASE` | Yes | - | CLOB API passphrase |
| `POLYMARKET_PROXY_ADDRESS` | No | - | Proxy wallet address (if using POLY_PROXY) |
| `POLYMARKET_API_URL` | No | `https://clob.polymarket.com` | CLOB API base URL |

## Usage

```typescript
import { PolymarketConnector } from '@pumpamp/connector-polymarket';

const connector = new PolymarketConnector({
  apiUrl: 'https://clob.polymarket.com',
  privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
  apiKey: process.env.POLYMARKET_API_KEY!,
  apiSecret: process.env.POLYMARKET_API_SECRET!,
  passphrase: process.env.POLYMARKET_API_PASSPHRASE!,
  proxyAddress: process.env.POLYMARKET_PROXY_ADDRESS,
});

// Connect and validate credentials
await connector.connect();

// Place an order (buy Yes outcome)
const result = await connector.placeOrder({
  market_id: 'polymarket:0xabc123...',
  venue: 'polymarket',
  side: 'Yes',
  action: 'open',
  size: 25,
  order_type: 'limit',
  limit_price: 0.65,
  command_id: 'cmd-123',
});

// Cancel an order
await connector.cancelOrder('order-id-from-polymarket');

// Cancel all orders
await connector.cancelAllOrders();

// Disconnect
await connector.disconnect();
```

## API Reference

### PolymarketConnector

Implements `VenueConnector` interface.

#### Methods

- `connect()`: Validate credentials via open orders query
- `disconnect()`: Stop health checks
- `placeOrder(order: OrderRequest)`: Build, sign, and submit an order
- `cancelOrder(orderId: string)`: Cancel a specific order
- `cancelAllOrders()`: Cancel all open orders
- `getPositions()`: Fetch current positions
- `getBalance()`: Fetch account balance
- `isHealthy()`: Check connector health status

## Market ID Format

Market IDs follow the pattern `polymarket:<conditionId>` or `polymarket:<conditionId>:<tokenIndex>`:
- `polymarket:0xabc123...` - Resolved via API to Yes/No token IDs
- `polymarket:0xabc123...:0` - Explicit token index (0 = Yes, 1 = No)

The connector resolves condition IDs to token IDs automatically and caches the result for 5 minutes.

## Order Sides

Polymarket uses binary outcomes (Yes/No):
- **Open Yes**: side=`Yes`, action=`open` -> CLOB `BUY` on Yes token
- **Close Yes**: side=`Yes`, action=`close` -> CLOB `SELL` on Yes token
- **Open No**: side=`No`, action=`open` -> CLOB `BUY` on No token
- **Close No**: side=`No`, action=`close` -> CLOB `SELL` on No token

## Order Types

- **Market**: Fill-or-Kill (FOK) - immediate full execution or rejection
- **Limit**: Good-till-Cancel (GTC) - rests on the order book

## Authentication

Polymarket uses a two-layer authentication scheme:
1. **CLOB API credentials** (key, secret, passphrase) for API access
2. **EIP-712 signatures** (Ethereum private key) for order signing on Polygon

The connector supports both EOA wallets (signatureType=0) and POLY_PROXY wallets (signatureType=1) when a proxy address is configured.

## Architecture

```
PolymarketConnector (VenueConnector)
├── ClobClient (@polymarket/clob-client)
│   ├── createOrder()    # EIP-712 signed order building
│   ├── postOrder()      # Submit signed order
│   ├── cancelOrder()
│   ├── cancelAll()
│   ├── getMarket()      # Resolve condition_id to tokens
│   └── getOpenOrders()  # Health check / connection test
└── Market Cache (5min TTL)
    └── condition_id -> { yes_token, no_token, fee_rate, neg_risk }
```

## Health Monitoring

The connector runs a health check every 30 seconds by calling `getOpenOrders()`. If the health check fails, `isHealthy()` returns `false` and the gateway can take appropriate action.

## Resources

- [Polymarket CLOB API Docs](https://docs.polymarket.com/)
- [Polymarket CLOB Client (npm)](https://www.npmjs.com/package/@polymarket/clob-client)
- [PumpAmp Trading Gateway](https://github.com/pumpamp/pumpamp-trading-gateway)

## License

MIT
