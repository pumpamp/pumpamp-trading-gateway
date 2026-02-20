# @pumpamp/connector-hyperliquid

Hyperliquid connector for PumpAmp Trading Gateway.

## Features

- EIP-712 signature-based authentication
- Perpetual futures trading
- Position management
- Account balance queries
- Order placement (market and limit)
- Order cancellation (single and all)
- Health monitoring

## Usage

```typescript
import { HyperliquidConnector } from '@pumpamp/connector-hyperliquid';

const connector = new HyperliquidConnector({
  privateKey: process.env.HYPERLIQUID_PRIVATE_KEY,
  isMainnet: true, // or false for testnet
});

await connector.connect();

// Place a market order
const result = await connector.placeOrder({
  market_id: 'BTC-PERP',
  venue: 'hyperliquid',
  side: 'long',
  action: 'open',
  size: 0.01,
  order_type: 'market',
  command_id: 'cmd-123',
});

// Get positions
const positions = await connector.getPositions();

// Get balance
const balance = await connector.getBalance();
```

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| privateKey | string | Yes | Ethereum private key (0x...) |
| vaultAddress | string | No | Vault address for vault trading |
| isMainnet | boolean | No | Use mainnet (true) or testnet (false). Default: true |

## Market ID Format

Hyperliquid uses coin names for markets. Supported formats:
- `BTC` or `BTC-PERP` (both map to BTC perpetual)
- `ETH` or `ETH-PERP`
- Any coin in the Hyperliquid universe

## Order Types

- **Market**: Immediate execution at best available price (IoC)
- **Limit**: Good-till-cancel limit order at specified price

## Position Sides

- **Long**: Buy to open, sell to close
- **Short**: Sell to open, buy to close

## Error Handling

All API errors are caught and returned in the `OrderResult.error` field or thrown as exceptions for non-order operations.

## Health Checks

The connector performs automatic health checks every 30 seconds via `isHealthy()`. This queries the clearinghouse state to verify connectivity.

## Architecture

```
HyperliquidConnector (VenueConnector)
├── HyperliquidApi (REST client)
│   ├── placeOrder()
│   ├── cancelOrder()
│   ├── cancelAllOrders()
│   ├── getPositions()
│   └── getBalance()
└── hyperliquid-auth (EIP-712 signing)
    └── signAction()
```

## API Endpoints

- **Exchange**: `https://api.hyperliquid.xyz/exchange` (signed actions)
- **Info**: `https://api.hyperliquid.xyz/info` (read-only queries)

## References

- [Hyperliquid API Docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api)
- [EIP-712 Typed Data Standard](https://eips.ethereum.org/EIPS/eip-712)
