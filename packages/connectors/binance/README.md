# @pumpamp/connector-binance

Binance spot and futures connector for PumpAmp Trading Gateway.

## Overview

This connector implements the `VenueConnector` interface for Binance, enabling automated trading on Binance spot and futures markets through the PumpAmp Trading Gateway.

## Features

- **REST API Integration**: Native `fetch` with HMAC-SHA256 authentication
- **Spot and Futures**: Toggle between spot and futures with a single config flag
- **Order Management**: Place, cancel, and track orders (market and limit)
- **Position Tracking**: Real-time position monitoring with P&L
- **Balance Queries**: USDT balance for both spot and futures accounts
- **Health Checks**: 30-second periodic health monitoring
- **Error Mapping**: Standardized error codes (INSUFFICIENT_BALANCE, INVALID_ORDER, RATE_LIMITED, etc.)

## Configuration

### Environment Variables

```env
BINANCE_API_KEY=your-api-key
BINANCE_API_SECRET=your-api-secret
BINANCE_FUTURES=true
BINANCE_API_URL=https://fapi.binance.com
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BINANCE_API_KEY` | Yes | - | Binance API key |
| `BINANCE_API_SECRET` | Yes | - | Binance API secret |
| `BINANCE_FUTURES` | No | `false` | Enable futures trading |
| `BINANCE_API_URL` | No | `https://api.binance.com` (spot) / `https://fapi.binance.com` (futures) | API base URL |

## Usage

```typescript
import { BinanceConnector } from '@pumpamp/connector-binance';

const connector = new BinanceConnector({
  apiUrl: 'https://fapi.binance.com',
  apiKey: process.env.BINANCE_API_KEY!,
  apiSecret: process.env.BINANCE_API_SECRET!,
  futures: true,
});

// Connect and validate credentials
await connector.connect();

// Place a market order
const result = await connector.placeOrder({
  market_id: 'binance:BTCUSDT',
  venue: 'binance',
  side: 'long',
  action: 'open',
  size: 0.01,
  order_type: 'market',
  command_id: 'cmd-123',
});

// Place a limit order
const limitResult = await connector.placeOrder({
  market_id: 'binance:ETHUSDT',
  venue: 'binance',
  side: 'long',
  action: 'open',
  size: 0.1,
  order_type: 'limit',
  limit_price: 3500,
  command_id: 'cmd-456',
});

// Get positions
const positions = await connector.getPositions();

// Get balance
const balance = await connector.getBalance();

// Disconnect
await connector.disconnect();
```

## API Reference

### BinanceConnector

Implements `VenueConnector` interface.

#### Methods

- `connect()`: Validate credentials via balance check, start health monitoring
- `disconnect()`: Stop health checks
- `placeOrder(order: OrderRequest)`: Place a new order
- `cancelOrder(orderId: string)`: Cancel a specific order (ID format: `binance-SYMBOL-orderId`)
- `cancelAllOrders()`: Cancel all open orders across active symbols
- `getPositions()`: Fetch current positions (futures only, filters zero positions)
- `getBalance()`: Fetch USDT balance (spot or futures)
- `isHealthy()`: Check connector health status

### Authentication

Binance uses HMAC-SHA256 signature authentication:

```typescript
import { signQuery, buildAuthHeaders } from '@pumpamp/connector-binance';

const signature = signQuery(apiSecret, queryString);
const headers = buildAuthHeaders(apiKey);
```

## Market ID Format

Market IDs follow the pattern `binance:SYMBOL`:
- `binance:BTCUSDT` - BTC/USDT
- `binance:ETHUSDT` - ETH/USDT

The connector strips the `binance:` prefix before sending to the API.

## Order Sides

- **Open long**: side=`long`, action=`open` -> Binance `BUY`
- **Close long**: side=`long`, action=`close` -> Binance `SELL`
- **Open short**: side=`short`, action=`open` -> Binance `SELL`
- **Close short**: side=`short`, action=`close` -> Binance `BUY`

Closing positions automatically set `reduceOnly: true`.

## Error Handling

The connector maps Binance error codes to standardized codes:

| Binance Code | Mapped Code |
|-------------|-------------|
| -2019 | `INSUFFICIENT_BALANCE` |
| -1102 | `INVALID_ORDER` |
| -1003 | `RATE_LIMITED` |
| -2010 | `ORDER_NOT_FOUND` |
| -1021 | `TIMESTAMP_OUT_OF_SYNC` |
| Other | `BINANCE_ERROR: <message>` |

## Architecture

```
BinanceConnector (VenueConnector)
├── BinanceApi (REST client)
│   ├── placeOrder()
│   ├── cancelOrder()
│   ├── cancelAllOrders()
│   ├── getPositions()
│   └── getBalance()
└── binance-auth (HMAC-SHA256 signing)
    └── signQuery()
```

## Health Monitoring

The connector runs a health check every 30 seconds by calling `getBalance()`. If the health check fails, `isHealthy()` returns `false` and the gateway can take appropriate action.

## Resources

- [Binance API Docs](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info)
- [Binance Spot API](https://developers.binance.com/docs/binance-spot-api-docs/rest-api)
- [PumpAmp Trading Gateway](https://github.com/pumpamp/pumpamp-trading-gateway)

## License

MIT
