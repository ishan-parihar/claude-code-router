/**
 * Metrics and observability service for CCR
 * Tracks request lifecycle metrics for monitoring and debugging
 */

export interface RequestMetrics {
  requestId: string;
  provider: string;
  model: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  tokensIn?: number;
  tokensOut?: number;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  endpoint?: string;
  isStream: boolean;
  retryCount: number;
  scenarioType?: string;
}

export interface ProviderStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageLatency: number;
  averageTokensIn: number;
  averageTokensOut: number;
  errorBreakdown: Record<string, number>;
  lastError?: string;
  lastErrorTime?: number;
}

export interface MetricsSummary {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageLatency: number;
  providers: Record<string, ProviderStats>;
  timeWindow: number;
}

/**
 * MetricsCollector collects and aggregates request metrics
 * for observability and performance monitoring
 */
export class MetricsCollector {
  private metrics: Map<string, RequestMetrics> = new Map();
  private providerStats: Map<string, ProviderStats> = new Map();
  private maxMetricsSize: number = 10000;
  private retentionWindowMs: number = 24 * 60 * 60 * 1000; // 24 hours

  constructor(options?: { maxMetricsSize?: number; retentionWindowMs?: number }) {
    if (options?.maxMetricsSize) {
      this.maxMetricsSize = options.maxMetricsSize;
    }
    if (options?.retentionWindowMs) {
      this.retentionWindowMs = options.retentionWindowMs;
    }
  }

  /**
   * Record the start of a request
   */
  recordStart(
    requestId: string,
    provider: string,
    model: string,
    options: {
      endpoint?: string;
      isStream?: boolean;
      scenarioType?: string;
    } = {}
  ): void {
    const metric: RequestMetrics = {
      requestId,
      provider,
      model,
      startTime: Date.now(),
      success: false,
      isStream: options.isStream ?? false,
      retryCount: 0,
      endpoint: options.endpoint,
      scenarioType: options.scenarioType,
    };

    this.metrics.set(requestId, metric);
    this.enforceMaxSize();
  }

  /**
   * Record a retry attempt
   */
  recordRetry(requestId: string): void {
    const metric = this.metrics.get(requestId);
    if (metric) {
      metric.retryCount++;
    }
  }

  /**
   * Record successful completion of a request
   */
  recordComplete(
    requestId: string,
    options: {
      tokensIn?: number;
      tokensOut?: number;
    } = {}
  ): void {
    const metric = this.metrics.get(requestId);
    if (!metric) {
      return;
    }

    metric.endTime = Date.now();
    metric.duration = metric.endTime - metric.startTime;
    metric.success = true;
    metric.tokensIn = options.tokensIn;
    metric.tokensOut = options.tokensOut;

    this.updateProviderStats(metric);
  }

  /**
   * Record failed request
   */
  recordError(
    requestId: string,
    errorCode: string,
    errorMessage?: string
  ): void {
    const metric = this.metrics.get(requestId);
    if (!metric) {
      return;
    }

    metric.endTime = Date.now();
    metric.duration = metric.endTime - metric.startTime;
    metric.success = false;
    metric.errorCode = errorCode;
    metric.errorMessage = errorMessage;

    this.updateProviderStats(metric);
  }

  /**
   * Get metrics for a specific request
   */
  getMetric(requestId: string): RequestMetrics | undefined {
    return this.metrics.get(requestId);
  }

  /**
   * Get statistics for a specific provider
   */
  getProviderStats(provider: string, timeWindowMs?: number): ProviderStats {
    const window = timeWindowMs ?? this.retentionWindowMs;
    const cutoffTime = Date.now() - window;

    const providerMetrics = Array.from(this.metrics.values()).filter(
      (m) => m.provider === provider && m.startTime >= cutoffTime
    );

    if (providerMetrics.length === 0) {
      return this.getEmptyProviderStats();
    }

    const successful = providerMetrics.filter((m) => m.success);
    const failed = providerMetrics.filter((m) => !m.success);

    const latencies = successful
      .map((m) => m.duration)
      .filter((d): d is number => d !== undefined);

    const tokensIn = successful
      .map((m) => m.tokensIn)
      .filter((t): t is number => t !== undefined);

    const tokensOut = successful
      .map((m) => m.tokensOut)
      .filter((t): t is number => t !== undefined);

    const errorBreakdown: Record<string, number> = {};
    failed.forEach((m) => {
      const code = m.errorCode || "unknown";
      errorBreakdown[code] = (errorBreakdown[code] || 0) + 1;
    });

    const lastError = failed
      .filter((m) => m.errorMessage)
      .sort((a, b) => (b.endTime || 0) - (a.endTime || 0))[0];

    return {
      totalRequests: providerMetrics.length,
      successfulRequests: successful.length,
      failedRequests: failed.length,
      averageLatency:
        latencies.length > 0
          ? latencies.reduce((a, b) => a + b, 0) / latencies.length
          : 0,
      averageTokensIn:
        tokensIn.length > 0
          ? tokensIn.reduce((a, b) => a + b, 0) / tokensIn.length
          : 0,
      averageTokensOut:
        tokensOut.length > 0
          ? tokensOut.reduce((a, b) => a + b, 0) / tokensOut.length
          : 0,
      errorBreakdown,
      lastError: lastError?.errorMessage,
      lastErrorTime: lastError?.endTime,
    };
  }

  /**
   * Get aggregated statistics across all providers
   */
  getStats(timeWindowMs?: number): MetricsSummary {
    const window = timeWindowMs ?? this.retentionWindowMs;
    const cutoffTime = Date.now() - window;

    const recentMetrics = Array.from(this.metrics.values()).filter(
      (m) => m.startTime >= cutoffTime
    );

    const successful = recentMetrics.filter((m) => m.success);
    const latencies = successful
      .map((m) => m.duration)
      .filter((d): d is number => d !== undefined);

    const providers: Record<string, ProviderStats> = {};
    const providerNames = new Set(recentMetrics.map((m) => m.provider));

    providerNames.forEach((provider) => {
      providers[provider] = this.getProviderStats(provider, window);
    });

    return {
      totalRequests: recentMetrics.length,
      successfulRequests: successful.length,
      failedRequests: recentMetrics.length - successful.length,
      averageLatency:
        latencies.length > 0
          ? latencies.reduce((a, b) => a + b, 0) / latencies.length
          : 0,
      providers,
      timeWindow: window,
    };
  }

  /**
   * Get recent metrics with optional filtering
   */
  getRecentMetrics(
    options: {
      provider?: string;
      model?: string;
      success?: boolean;
      limit?: number;
      timeWindowMs?: number;
    } = {}
  ): RequestMetrics[] {
    const window = options.timeWindowMs ?? this.retentionWindowMs;
    const cutoffTime = Date.now() - window;

    let metrics = Array.from(this.metrics.values()).filter(
      (m) => m.startTime >= cutoffTime
    );

    if (options.provider) {
      metrics = metrics.filter((m) => m.provider === options.provider);
    }

    if (options.model) {
      metrics = metrics.filter((m) => m.model === options.model);
    }

    if (options.success !== undefined) {
      metrics = metrics.filter((m) => m.success === options.success);
    }

    metrics.sort((a, b) => b.startTime - a.startTime);

    if (options.limit) {
      metrics = metrics.slice(0, options.limit);
    }

    return metrics;
  }

  /**
   * Clear old metrics beyond retention window
   */
  cleanup(): number {
    const cutoffTime = Date.now() - this.retentionWindowMs;
    let clearedCount = 0;

    for (const [requestId, metric] of this.metrics) {
      if (metric.startTime < cutoffTime) {
        this.metrics.delete(requestId);
        clearedCount++;
      }
    }

    return clearedCount;
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.metrics.clear();
    this.providerStats.clear();
  }

  private updateProviderStats(metric: RequestMetrics): void {
    const existing = this.providerStats.get(metric.provider);

    if (!existing) {
      this.providerStats.set(metric.provider, {
        totalRequests: 1,
        successfulRequests: metric.success ? 1 : 0,
        failedRequests: metric.success ? 0 : 1,
        averageLatency: metric.duration || 0,
        averageTokensIn: metric.tokensIn || 0,
        averageTokensOut: metric.tokensOut || 0,
        errorBreakdown: metric.errorCode
          ? { [metric.errorCode]: 1 }
          : {},
        lastError: metric.success ? undefined : metric.errorMessage,
        lastErrorTime: metric.success ? undefined : metric.endTime,
      });
      return;
    }

    existing.totalRequests++;

    if (metric.success) {
      existing.successfulRequests++;
      if (metric.duration) {
        existing.averageLatency =
          (existing.averageLatency * (existing.successfulRequests - 1) +
            metric.duration) /
          existing.successfulRequests;
      }
      if (metric.tokensIn) {
        existing.averageTokensIn =
          (existing.averageTokensIn * (existing.successfulRequests - 1) +
            metric.tokensIn) /
          existing.successfulRequests;
      }
      if (metric.tokensOut) {
        existing.averageTokensOut =
          (existing.averageTokensOut * (existing.successfulRequests - 1) +
            metric.tokensOut) /
          existing.successfulRequests;
      }
    } else {
      existing.failedRequests++;
      if (metric.errorCode) {
        existing.errorBreakdown[metric.errorCode] =
          (existing.errorBreakdown[metric.errorCode] || 0) + 1;
      }
      existing.lastError = metric.errorMessage;
      existing.lastErrorTime = metric.endTime;
    }
  }

  private enforceMaxSize(): void {
    if (this.metrics.size <= this.maxMetricsSize) {
      return;
    }

    const sortedMetrics = Array.from(this.metrics.entries()).sort(
      (a, b) => a[1].startTime - b[1].startTime
    );

    const toDelete = sortedMetrics.slice(0, sortedMetrics.length - this.maxMetricsSize);
    toDelete.forEach(([requestId]) => {
      this.metrics.delete(requestId);
    });
  }

  private getEmptyProviderStats(): ProviderStats {
    return {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageLatency: 0,
      averageTokensIn: 0,
      averageTokensOut: 0,
      errorBreakdown: {},
    };
  }
}

// Global metrics collector instance
export const metricsCollector = new MetricsCollector();

export default metricsCollector;
