import { ModelPoolManager } from './model-pool-manager';
import { ConfigService } from './config';

export interface ModelCandidate {
  provider: string;
  model: string;
  priority: number;
  score: number;
  reason: string;
  hasCapacity: boolean;
  isRateLimited: boolean;
  isCircuitOpen: boolean;
  successRate: number;
  avgResponseTime?: number;
}

export interface ModelSelectorConfig {
  enableProactiveFailover: boolean;
  enableHealthBasedRouting: boolean;
  enablePerformanceBasedRouting: boolean;
  preferHealthyModels: boolean;
  maxParallelAlternatives: number;
  scoreWeights: {
    capacity: number;
    health: number;
    performance: number;
    priority: number;
  };
}

export class ModelSelector {
  private modelPoolManager: ModelPoolManager;
  private configService: ConfigService;
  private config: ModelSelectorConfig;
  private logger: any;

  constructor(
    modelPoolManager: ModelPoolManager,
    configService: ConfigService,
    logger: any = console
  ) {
    this.modelPoolManager = modelPoolManager;
    this.configService = configService;
    this.logger = logger;
    this.config = this.loadConfig();
  }

  private loadConfig(): ModelSelectorConfig {
    const selectorConfig = this.configService.get<any>('modelSelector') || {};

    return {
      enableProactiveFailover: selectorConfig.enableProactiveFailover !== false,
      enableHealthBasedRouting: selectorConfig.enableHealthBasedRouting !== false,
      enablePerformanceBasedRouting: selectorConfig.enablePerformanceBasedRouting || false,
      preferHealthyModels: selectorConfig.preferHealthyModels !== false,
      maxParallelAlternatives: selectorConfig.maxParallelAlternatives || 3,
      scoreWeights: {
        capacity: selectorConfig.scoreWeights?.capacity || 0.4,
        health: selectorConfig.scoreWeights?.health || 0.3,
        performance: selectorConfig.scoreWeights?.performance || 0.2,
        priority: selectorConfig.scoreWeights?.priority || 0.1,
      },
    };
  }

  selectModel(
    preferredModel: string,
    alternatives: Array<{ provider: string; model: string }>,
    scenarioType: string = 'default',
    requestPriority: number = 0
  ): {
    selected: ModelCandidate | null;
    shouldParallelExecute: boolean;
    parallelCandidates: ModelCandidate[];
    reason: string;
  } {
    const allCandidates = this.buildCandidates(
      preferredModel,
      alternatives,
      requestPriority
    );

    this.logger.debug(
      `[ModelSelector] Evaluating ${allCandidates.length} candidates for ${scenarioType}`,
      {
        scenarioType,
        requestPriority,
        candidates: allCandidates.map(c => ({
          model: `${c.provider},${c.model}`,
          score: c.score,
          hasCapacity: c.hasCapacity,
          isRateLimited: c.isRateLimited,
          isCircuitOpen: c.isCircuitOpen,
        })),
      }
    );

    const availableCandidates = allCandidates.filter(c => c.hasCapacity);

    if (availableCandidates.length === 0) {
      this.logger.warn(
        `[ModelSelector] No available candidates, all models are rate-limited, circuit-open, or at capacity`
      );

      return {
        selected: null,
        shouldParallelExecute: false,
        parallelCandidates: [],
        reason: 'No available models (all rate-limited, circuit-open, or at capacity)',
      };
    }

    const sortedCandidates = availableCandidates.sort((a, b) => b.score - a.score);
    const selected = sortedCandidates[0];

    const shouldParallelExecute = this.shouldUseParallelExecution(
      selected,
      sortedCandidates.slice(1),
      scenarioType
    );

    let parallelCandidates: ModelCandidate[] = [];

    if (shouldParallelExecute) {
      parallelCandidates = sortedCandidates.slice(1, this.config.maxParallelAlternatives + 1);

      this.logger.info(
        `[ModelSelector] Selecting ${parallelCandidates.length} parallel alternatives`,
        {
          primary: `${selected.provider},${selected.model}`,
          alternatives: parallelCandidates.map(c => `${c.provider},${c.model}`),
        }
      );
    }

    this.logger.info(
      `[ModelSelector] Selected model: ${selected.provider},${selected.model}`,
      {
        score: selected.score,
        reason: selected.reason,
        shouldParallelExecute,
        parallelCount: parallelCandidates.length,
      }
    );

    return {
      selected,
      shouldParallelExecute,
      parallelCandidates,
      reason: selected.reason,
    };
  }

  private buildCandidates(
    preferredModel: string,
    alternatives: Array<{ provider: string; model: string }>,
    requestPriority: number
  ): ModelCandidate[] {
    const candidates: ModelCandidate[] = [];

    const [preferredProvider, preferredModelName] = preferredModel.split(',');

    const allModels = [
      { provider: preferredProvider, model: preferredModelName, isPreferred: true },
      ...alternatives.map(alt => ({ ...alt, isPreferred: false })),
    ];

    for (const modelInfo of allModels) {
      const candidate: ModelCandidate = {
        provider: modelInfo.provider,
        model: modelInfo.model,
        priority: modelInfo.isPreferred ? 10 : 0,
        score: 0,
        reason: '',
        hasCapacity: this.modelPoolManager.hasCapacity(modelInfo.provider, modelInfo.model),
        isRateLimited: this.modelPoolManager.isRateLimited(modelInfo.provider, modelInfo.model),
        isCircuitOpen: this.modelPoolManager.isCircuitBreakerOpen(modelInfo.provider, modelInfo.model),
        successRate: 100,
      };

      if (candidate.isRateLimited) {
        candidate.reason = 'Rate-limited';
        candidate.score = 0;
      } else if (candidate.isCircuitOpen) {
        candidate.reason = 'Circuit breaker open';
        candidate.score = 0;
      } else if (!candidate.hasCapacity) {
        candidate.reason = 'No capacity';
        candidate.score = 0;
      } else {
        candidate.score = this.calculateScore(candidate, requestPriority);
        candidate.reason = this.getScoreReason(candidate);
      }

      candidates.push(candidate);
    }

    return candidates;
  }

  private calculateScore(candidate: ModelCandidate, requestPriority: number): number {
    let score = 0;

    const status = this.modelPoolManager.getStatus();
    const key = `${candidate.provider},${candidate.model}`;
    const slotStatus = status[key];

    let capacityScore = 0;
    if (slotStatus) {
      const effectiveCapacity = slotStatus.effectiveCapacity;
      const maxConcurrent = slotStatus.maxConcurrent;
      capacityScore = (effectiveCapacity / maxConcurrent) * 100;
    }

    let healthScore = 100;
    if (slotStatus) {
      healthScore = slotStatus.successRate || 100;
    }

    let performanceScore = 100;
    if (this.config.enablePerformanceBasedRouting && slotStatus) {
      performanceScore = 100 - (slotStatus.failureCount * 10);
      performanceScore = Math.max(0, performanceScore);
    }

    let priorityScore = candidate.priority + requestPriority;

    score =
      (capacityScore * this.config.scoreWeights.capacity) +
      (healthScore * this.config.scoreWeights.health) +
      (performanceScore * this.config.scoreWeights.performance) +
      (priorityScore * this.config.scoreWeights.priority);

    return Math.round(score * 100) / 100;
  }

  private getScoreReason(candidate: ModelCandidate): string {
    const reasons: string[] = [];

    if (candidate.hasCapacity) {
      reasons.push('Has capacity');
    }

    if (!candidate.isRateLimited) {
      reasons.push('Not rate-limited');
    }

    if (!candidate.isCircuitOpen) {
      reasons.push('Circuit closed');
    }

    if (candidate.successRate > 90) {
      reasons.push('High success rate');
    }

    return reasons.join(', ') || 'Available';
  }

  private shouldUseParallelExecution(
    selected: ModelCandidate,
    otherCandidates: ModelCandidate[],
    scenarioType: string
  ): boolean {
    if (!this.config.enableProactiveFailover) {
      return false;
    }

    if (scenarioType !== 'default') {
      this.logger.debug(
        `[ModelSelector] Parallel execution not enabled for scenario: ${scenarioType}`
      );
      return false;
    }

    if (otherCandidates.length === 0) {
      return false;
    }

    const hasAvailableAlternatives = otherCandidates.some(c => c.hasCapacity);
    if (!hasAvailableAlternatives) {
      return false;
    }

    const lowScoreThreshold = 50;
    const moderateScoreThreshold = 70;

    if (selected.score < lowScoreThreshold) {
      this.logger.info(
        `[ModelSelector] Primary model has low score (${selected.score}), using parallel execution`
      );
      return true;
    }

    if (selected.score < moderateScoreThreshold && otherCandidates.length > 0) {
      this.logger.info(
        `[ModelSelector] Primary model has moderate score (${selected.score}), using parallel execution`
      );
      return true;
    }

    return false;
  }

  selectFailoverCandidates(
    failedProvider: string,
    failedModel: string,
    alternatives: Array<{ provider: string; model: string }>,
    reason: string
  ): ModelCandidate[] {
    const candidates = alternatives
      .map(alt => {
        const hasCapacity = this.modelPoolManager.hasCapacity(alt.provider, alt.model);
        const isRateLimited = this.modelPoolManager.isRateLimited(alt.provider, alt.model);
        const isCircuitOpen = this.modelPoolManager.isCircuitBreakerOpen(alt.provider, alt.model);

        if (!hasCapacity || isRateLimited || isCircuitOpen) {
          return null;
        }

        const candidate: ModelCandidate = {
          provider: alt.provider,
          model: alt.model,
          priority: 0,
          score: 0,
          reason: 'Failover candidate',
          hasCapacity: true,
          isRateLimited: false,
          isCircuitOpen: false,
          successRate: 100,
        };

        candidate.score = this.calculateScore(candidate, 0);

        return candidate;
      })
      .filter((c): c is ModelCandidate => c !== null);

    const sortedCandidates = candidates.sort((a, b) => b.score - a.score);

    this.logger.info(
      `[ModelSelector] Found ${sortedCandidates.length} failover candidates for ${failedProvider},${failedModel}`,
      {
        reason,
        candidates: sortedCandidates.map(c => ({
          model: `${c.provider},${c.model}`,
          score: c.score,
        })),
      }
    );

    return sortedCandidates;
  }

  getConfig(): ModelSelectorConfig {
    return { ...this.config };
  }
}
