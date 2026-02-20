FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/tsconfig.json packages/core/
COPY packages/connectors/kalshi/package.json packages/connectors/kalshi/tsconfig.json packages/connectors/kalshi/
COPY packages/connectors/polymarket/package.json packages/connectors/polymarket/tsconfig.json packages/connectors/polymarket/
COPY packages/connectors/hyperliquid/package.json packages/connectors/hyperliquid/tsconfig.json packages/connectors/hyperliquid/
COPY packages/connectors/binance/package.json packages/connectors/binance/tsconfig.json packages/connectors/binance/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY templates/ templates/
COPY strategy.example.json .

RUN pnpm build

FROM node:20-alpine

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages/core/package.json packages/core/
COPY --from=builder /app/packages/core/dist/ packages/core/dist/
COPY --from=builder /app/packages/connectors/kalshi/package.json packages/connectors/kalshi/
COPY --from=builder /app/packages/connectors/kalshi/dist/ packages/connectors/kalshi/dist/
COPY --from=builder /app/packages/connectors/polymarket/package.json packages/connectors/polymarket/
COPY --from=builder /app/packages/connectors/polymarket/dist/ packages/connectors/polymarket/dist/
COPY --from=builder /app/packages/connectors/hyperliquid/package.json packages/connectors/hyperliquid/
COPY --from=builder /app/packages/connectors/hyperliquid/dist/ packages/connectors/hyperliquid/dist/
COPY --from=builder /app/packages/connectors/binance/package.json packages/connectors/binance/
COPY --from=builder /app/packages/connectors/binance/dist/ packages/connectors/binance/dist/
COPY --from=builder /app/templates/ templates/
COPY --from=builder /app/strategy.example.json .

RUN pnpm install --frozen-lockfile --prod

ENTRYPOINT ["node", "./packages/core/dist/cli.js"]
CMD ["start"]
