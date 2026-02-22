# Contributing to PumpAmp Trading Gateway

Thanks for your interest in contributing! This document covers the basics.

## Getting Started

1. Fork and clone the repo
2. Install dependencies: `pnpm install`
3. Build: `pnpm build`
4. Run tests: `pnpm test`

## Development

### Prerequisites

- Node.js 20+
- pnpm 10+

### Project Layout

This is a pnpm workspace monorepo:

- `packages/core/` -- Gateway runtime, CLI, relay client, strategy engine
- `packages/connectors/kalshi/` -- Kalshi venue connector
- `packages/connectors/polymarket/` -- Polymarket venue connector
- `packages/connectors/hyperliquid/` -- Hyperliquid venue connector
- `packages/connectors/binance/` -- Binance venue connector

### Running Tests

```bash
pnpm test          # Run all tests
pnpm lint          # ESLint
pnpm typecheck     # TypeScript type checking
```

### Code Style

- TypeScript strict mode
- ESLint with the project config
- No `console.log` in library code (use `createLogger()` from `@pumpamp/core`)
- `console.log` is acceptable in CLI output (`cli.ts`, `simulator.ts`)

## Pull Requests

1. Create a feature branch from `main`
2. Make your changes
3. Ensure `pnpm build && pnpm test && pnpm lint` all pass
4. Open a pull request with a clear description

## Reporting Issues

Open an issue on GitHub with:
- Steps to reproduce
- Expected vs actual behavior
- Node.js and pnpm versions

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
