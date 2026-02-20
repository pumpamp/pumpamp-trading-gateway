import { z } from 'zod';
import { readFileSync } from 'node:fs';
import * as dotenv from 'dotenv';
import { createLogger } from './logger.js';

const logger = createLogger('config');

// Kalshi requires API key + private key (either base64-encoded PEM or file path)
const kalshiSchema = z.object({
  KALSHI_API_KEY: z.string().min(1),
  KALSHI_PRIVATE_KEY: z.string().min(1).optional(),
  KALSHI_PRIVATE_KEY_PATH: z.string().min(1).optional(),
});

const polymarketSchema = z.object({
  POLYMARKET_PRIVATE_KEY: z.string().min(1),
  POLYMARKET_API_KEY: z.string().min(1),
  POLYMARKET_API_SECRET: z.string().min(1),
  POLYMARKET_API_PASSPHRASE: z.string().min(1),
});

const hyperliquidSchema = z.object({
  HYPERLIQUID_PRIVATE_KEY: z.string().min(1),
});

const binanceSchema = z.object({
  BINANCE_API_KEY: z.string().min(1),
  BINANCE_API_SECRET: z.string().min(1),
});

const configSchema = z.object({
  PUMPAMP_API_KEY: z.string().min(1, 'PUMPAMP_API_KEY is required'),
  PUMPAMP_HOST: z.string().default('api.pumpamp.com'),
  PUMPAMP_PAIRING_ID: z.string().optional(),
  CANCEL_ON_SHUTDOWN: z.preprocess(
    (val) => val === 'true' || val === true,
    z.boolean().default(false),
  ),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  STRATEGY_CONFIG_PATH: z.string().optional(),
  AUTO_TRADE_ENABLED: z.preprocess(
    (val) => val === 'true' || val === true,
    z.boolean().default(false),
  ),
  SIMULATE_ORDERS: z.preprocess(
    (val) => val === 'true' || val === true,
    z.boolean().default(false),
  ),
});

export interface KalshiConfig {
  apiUrl: string;
  apiKey: string;
  privateKeyPem: string;
}

export interface PolymarketConfig {
  apiUrl: string;
  privateKey: string;
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  proxyAddress?: string;
}

export interface HyperliquidConfig {
  privateKey: string;
}

export interface BinanceConfig {
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
  futures: boolean;
}

export interface GatewayConfig {
  pumpampApiKey: string;
  pumpampHost: string;
  pumpampPairingId?: string;
  cancelOnShutdown: boolean;
  logLevel: string;
  strategyConfigPath?: string;
  autoTradeEnabled: boolean;
  simulateOrders: boolean;
  kalshi?: KalshiConfig;
  polymarket?: PolymarketConfig;
  hyperliquid?: HyperliquidConfig;
  binance?: BinanceConfig;
}

function tryParseVenueConfig<T>(
  name: string,
  schema: z.ZodType<T>,
  env: Record<string, string | undefined>,
): T | undefined {
  const result = schema.safeParse(env);
  if (result.success) {
    return result.data;
  }
  // Check if ANY of the venue's vars are present (partial config)
  const schemaObj = schema as unknown as z.ZodObject<any>;
  const keys = Object.keys(schemaObj.shape ?? {});
  const hasAny = keys.some((k) => env[k] !== undefined && env[k] !== '');
  if (hasAny) {
    logger.warn({ venue: name, missing: result.error.issues.map((i) => i.path.join('.')) },
      `${name} connector disabled: incomplete credential block`);
  }
  return undefined;
}

/**
 * Resolve Kalshi private key PEM from either base64 env var or file path.
 * Returns null if neither is provided (connector won't be enabled).
 */
function resolveKalshiPrivateKey(raw: { KALSHI_PRIVATE_KEY?: string; KALSHI_PRIVATE_KEY_PATH?: string }): string | null {
  if (raw.KALSHI_PRIVATE_KEY) {
    return Buffer.from(raw.KALSHI_PRIVATE_KEY, 'base64').toString('utf8');
  }
  if (raw.KALSHI_PRIVATE_KEY_PATH) {
    return readFileSync(raw.KALSHI_PRIVATE_KEY_PATH, 'utf8');
  }
  return null;
}

export function loadConfig(envOverrides?: Record<string, string | undefined>): GatewayConfig {
  dotenv.config();
  const env = envOverrides ?? process.env;

  const core = configSchema.parse(env);

  const kalshiRaw = tryParseVenueConfig('Kalshi', kalshiSchema, env as Record<string, string | undefined>);
  const kalshiPem = kalshiRaw ? resolveKalshiPrivateKey(kalshiRaw) : null;
  if (kalshiRaw && !kalshiPem) {
    logger.warn({ venue: 'Kalshi' }, 'Kalshi connector disabled: neither KALSHI_PRIVATE_KEY nor KALSHI_PRIVATE_KEY_PATH provided');
  }
  const polymarketRaw = tryParseVenueConfig('Polymarket', polymarketSchema, env as Record<string, string | undefined>);
  const hyperliquidRaw = tryParseVenueConfig('Hyperliquid', hyperliquidSchema, env as Record<string, string | undefined>);
  const binanceRaw = tryParseVenueConfig('Binance', binanceSchema, env as Record<string, string | undefined>);

  return {
    pumpampApiKey: core.PUMPAMP_API_KEY,
    pumpampHost: core.PUMPAMP_HOST,
    pumpampPairingId: core.PUMPAMP_PAIRING_ID || undefined,
    cancelOnShutdown: core.CANCEL_ON_SHUTDOWN,
    logLevel: core.LOG_LEVEL,
    strategyConfigPath: core.STRATEGY_CONFIG_PATH || undefined,
    autoTradeEnabled: core.AUTO_TRADE_ENABLED,
    simulateOrders: core.SIMULATE_ORDERS,
    kalshi: kalshiRaw && kalshiPem
      ? {
          apiUrl: (env as any).KALSHI_API_URL || 'https://api.elections.kalshi.com',
          apiKey: kalshiRaw.KALSHI_API_KEY,
          privateKeyPem: kalshiPem,
        }
      : undefined,
    polymarket: polymarketRaw
      ? {
          apiUrl: (env as any).POLYMARKET_API_URL || 'https://clob.polymarket.com',
          privateKey: polymarketRaw.POLYMARKET_PRIVATE_KEY,
          apiKey: polymarketRaw.POLYMARKET_API_KEY,
          apiSecret: polymarketRaw.POLYMARKET_API_SECRET,
          passphrase: polymarketRaw.POLYMARKET_API_PASSPHRASE,
          proxyAddress: (env as any).POLYMARKET_PROXY_ADDRESS || undefined,
        }
      : undefined,
    hyperliquid: hyperliquidRaw
      ? { privateKey: hyperliquidRaw.HYPERLIQUID_PRIVATE_KEY }
      : undefined,
    binance: binanceRaw
      ? {
          apiUrl: (env as any).BINANCE_API_URL || 'https://fapi.binance.com',
          apiKey: binanceRaw.BINANCE_API_KEY,
          apiSecret: binanceRaw.BINANCE_API_SECRET,
          futures: (env as any).BINANCE_FUTURES === 'true',
        }
      : undefined,
  };
}
