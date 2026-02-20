import { z } from 'zod';
import * as fs from 'fs';
import { createLogger } from '../../shared/logger.js';

const logger = createLogger('StrategyConfig');

// --- Risk Limits Schema ---

export const riskLimitsSchema = z.object({
  max_position_size_per_market: z.number().positive().optional(),
  max_total_exposure_usd: z.number().positive().optional(),
  max_trades_per_minute: z.number().int().positive().default(5),
  market_cooldown_seconds: z.number().int().nonnegative().default(30),
  signal_dedup_window_seconds: z.number().int().nonnegative().default(300),
});

export type RiskLimits = z.infer<typeof riskLimitsSchema>;

// --- Strategy Action Schema ---

export const strategyActionSchema = z.object({
  side: z.string(),
  size: z.number().positive(),
  order_type: z.enum(['market', 'limit']).default('market'),
  limit_price_offset_bps: z.number().optional(),
});

export type StrategyAction = z.infer<typeof strategyActionSchema>;

// --- Strategy Rule Schema ---

export const strategyRuleSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  signal_types: z.array(z.enum(['alert', 'strategy', 'cross_venue_arbitrage'])).min(1),
  signal_names: z.array(z.string()).optional(),
  venues: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  min_confidence: z.number().min(0).max(100).optional(),
  min_severity: z.enum(['Low', 'Medium', 'High', 'Critical']).optional(),
  directions: z.array(z.enum(['above', 'below', 'cross', 'long', 'short', 'neutral'])).optional(),
  action: strategyActionSchema,
});

export type StrategyRule = z.infer<typeof strategyRuleSchema>;

// --- Strategy Config Schema ---

export const strategyConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().default(true),
  dry_run: z.boolean().default(true),
  rules: z.array(strategyRuleSchema),
  market_mappings: z.record(z.string(), z.string()).default({}),
  risk_limits: riskLimitsSchema.default({}),
  _description: z.string().optional(),
  _usage: z.string().optional(),
  _signals: z.array(z.string()).optional(),
}).passthrough();

export type StrategyConfig = z.infer<typeof strategyConfigSchema>;

// --- Loader ---

export function loadStrategyConfig(filePath: string): StrategyConfig {
  logger.info({ path: filePath }, 'Loading strategy config');

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Strategy config not found: ${filePath}\n` +
      'Create one from the example: cp strategy.example.json strategy.json\n' +
      'Or set STRATEGY_CONFIG_PATH to the correct path.',
    );
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const json = JSON.parse(raw);
  const config = strategyConfigSchema.parse(json);

  logger.info(
    { rules: config.rules.length, dry_run: config.dry_run, enabled: config.enabled },
    'Strategy config loaded',
  );

  return config;
}
