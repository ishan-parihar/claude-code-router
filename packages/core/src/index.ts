/**
 * Core Package Exports
 * Includes legacy and new decoupled architecture exports
 */

// Interfaces (Phase 3 Architecture)
export * from "./interfaces";

// Server
export { default as Server } from "./server";

// Services
export { TransformerService } from "./services/transformer";
export { DecoupledTransformerService, TransformerComponents } from "./services/decoupled-transformer.service";
export {
  metricsCollector,
  MetricsCollector,
  RequestMetrics,
  ProviderStats,
  MetricsSummary,
} from "./services/metrics";

// Types
export * from "./types/llm";
export * from "./types/transformer";

// Legacy exports (backward compatibility)
export { default as Transformers } from "./transformer";
export * from "./transformer";

// Utilities
export * from "./utils/sse";
