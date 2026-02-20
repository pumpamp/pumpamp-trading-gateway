// Shared
export * from './shared/protocol.js';
export * from './shared/config.js';
export { createLogger, sanitizeUrl } from './shared/logger.js';

// Features: execution
export * from './features/execution/venue-connector.js';
export { PositionTracker } from './features/execution/position-tracker.js';
export { OrderRouter, parseMarketId } from './features/execution/order-router.js';

// Features: relay
export { RelayClient, type RelayClientConfig, type StatusUpdate } from './features/relay/relay-client.js';

// Features: signals
export { SignalConsumer, type SignalConsumerOptions, type Signal } from './features/signals/signal-consumer.js';

// Features: strategy
export { StrategyEngine, type StrategyStatus } from './features/strategy/strategy-engine.js';
export { loadStrategyConfig, strategyConfigSchema, type StrategyConfig, type StrategyRule, type StrategyAction } from './features/strategy/strategy-config.js';
export { MarketIdMapper } from './features/strategy/market-id-mapper.js';
export { RiskManager, type RiskResult, type RiskLimits } from './features/strategy/risk-manager.js';

// Features: simulator
export { SimulatorSignalSource, type SimulatorSignalSourceConfig } from './features/simulator/simulator-signal-source.js';
export {
  SimulatorVenueConnector,
  SimulatorRelay,
  type SimulatorConfig,
  DEFAULT_SIMULATOR_CONFIG,
  formatFill,
  formatReject,
  formatPosition,
  formatSettlement,
} from './features/simulator/simulator.js';

// Features: replay
export { ReplayConsumer, type ReplayConsumerConfig } from './features/replay/replay-consumer.js';
export { ReplayEngine, type ReplayConfig, type ReplayPosition, type ReplayProgress } from './features/replay/replay-engine.js';
export { generateReport, formatReportTable, type ReplayReport } from './features/replay/replay-report.js';

// Root
export { Gateway, type GatewayStatus } from './gateway.js';
