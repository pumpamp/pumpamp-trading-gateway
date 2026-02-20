# @pumpamp/connector-kalshi

Kalshi prediction market connector for PumpAmp Trading Gateway.

## Overview

This connector implements the `VenueConnector` interface for Kalshi, enabling automated trading on Kalshi prediction markets through the PumpAmp Trading Gateway.

## Features

- **REST API Integration**: Native `fetch` with RSA-PSS authentication
- **Order Management**: Place, cancel, and track orders
- **Position Tracking**: Real-time position monitoring
- **Balance Queries**: Account balance and payout tracking
- **Health Checks**: 30-second periodic health monitoring
- **Error Mapping**: Standardized error codes (INSUFFICIENT_BALANCE, INVALID_ORDER, RATE_LIMITED, etc.)

## Installation

```bash
pnpm add @pumpamp/connector-kalshi
```

## Configuration

### Environment Variables

```env
KALSHI_API_URL=https://trading-api.kalshi.com
KALSHI_API_KEY=your-api-key
KALSHI_PRIVATE_KEY_PATH=/path/to/private-key.pem
```

### Private Key Generation

1. Generate RSA key pair via Kalshi dashboard
2. Download the private key PEM file
3. Store securely and reference via `KALSHI_PRIVATE_KEY_PATH`

## Usage

```typescript
import { KalshiConnector } from '@pumpamp/connector-kalshi';

const connector = new KalshiConnector({
  apiUrl: process.env.KALSHI_API_URL!,
  apiKey: process.env.KALSHI_API_KEY!,
  privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH!,
});

// Connect and validate credentials
await connector.connect();

// Place an order
const result = await connector.placeOrder({
  market_id: 'KXBTC-24DEC-T55000',
  venue: 'kalshi',
  side: 'yes',
  action: 'buy',
  size: 10,
  order_type: 'limit',
  limit_price: 55,
  command_id: 'cmd-123',
});

// Get positions
const positions = await connector.getPositions();

// Get balance
const balance = await connector.getBalance();

// Disconnect
await connector.disconnect();
```

## API Reference

### KalshiConnector

Implements `VenueConnector` interface.

#### Methods

- `connect()`: Validate credentials and start health checks
- `disconnect()`: Stop health checks
- `placeOrder(order: OrderRequest)`: Place a new order
- `cancelOrder(orderId: string)`: Cancel a specific order
- `cancelAllOrders()`: Cancel all open orders
- `getPositions()`: Fetch current positions
- `getBalance()`: Fetch account balance
- `isHealthy()`: Check connector health status

### KalshiApi

Low-level REST API client.

#### Methods

- `placeOrder(params: KalshiOrderRequest)`
- `cancelOrder(orderId: string)`
- `cancelAllOrders()`
- `getPositions()`
- `getBalance()`

### Authentication

Kalshi uses RSA-PSS signature authentication:

```typescript
import { signRequest, buildAuthHeaders } from '@pumpamp/connector-kalshi';

const signature = signRequest(privateKeyPem, timestamp, 'GET', '/trade-api/v2/portfolio/balance');
const headers = buildAuthHeaders(apiKey, privateKeyPem, 'GET', '/trade-api/v2/portfolio/balance');
```

## Error Handling

The connector maps Kalshi API errors to standardized codes:

| Kalshi Error | Mapped Code |
|--------------|-------------|
| Insufficient balance | `INSUFFICIENT_BALANCE` |
| Invalid order/ticker | `INVALID_ORDER` |
| Rate limit exceeded | `RATE_LIMITED` |
| Unauthorized/Forbidden | `AUTH_ERROR` |
| Other errors | `UNKNOWN_ERROR` |

## Types

### KalshiOrderRequest

```typescript
interface KalshiOrderRequest {
  ticker: string;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  count: number;
  type: 'market' | 'limit';
  yes_price?: number;
  no_price?: number;
  expiration_ts?: number;
  client_order_id?: string;
}
```

### KalshiPosition

```typescript
interface KalshiPosition {
  ticker: string;
  position: number;
  market_exposure_cents: number;
  realized_pnl_cents: number;
  fees_paid_cents: number;
  total_traded_cents: number;
  resting_orders_count: number;
}
```

### KalshiBalance

```typescript
interface KalshiBalance {
  balance: number; // Available balance in cents
  payout: number;  // Pending payout in cents
}
```

## Health Monitoring

The connector runs a health check every 30 seconds by calling `getBalance()`. If the health check fails, `isHealthy()` returns `false` and the gateway can take appropriate action (retry, reconnect, alert).

## Testing

```bash
# Build
pnpm build

# Run tests (when implemented)
pnpm test
```

## Resources

- [Kalshi Trading API Docs](https://trading-api.readme.io/reference/)
- [Kalshi Authentication Guide](https://trading-api.readme.io/reference/authentication)
- [PumpAmp Trading Gateway](https://github.com/pumpamp/pumpamp-trading-gateway)

## License

MIT
