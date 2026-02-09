import { ConfigService } from './config';

import { ProviderErrorHandler, ProviderError } from "@/utils/errors";

export interface ModelSlot {
  provider: string;
  model: string;
  activeRequests: number;
  reservedRequests: number;
  reservedForQueue: number;
  maxConcurrent: number;
  queuedRequests: QueuedRequest[];
  lastUsed: number;
  rateLimitUntil?: number;
  rateLimitBackoffCount: number;
  rateLimitBaseRetryAfter: number;
  circuitBreakerOpen: boolean;
  circuitBreakerOpenUntil?: number;
  failureCount: number;
  successCount: number;
}

export interface QueuedRequest {
  id: string;
  req: any;
  reply: any;
  transformer: any;
  priority: number;
  timestamp: number;
  timeout: number;
  timeoutId?: NodeJS.Timeout;
  resolve: (result: any) => void;
  reject: (error: any) => void;
  reservationTimeoutId?: NodeJS.Timeout;
}

export interface ModelPoolConfig {
  maxConcurrentPerModel: number;
  circuitBreaker: {
    failureThreshold: number;
    cooldownPeriod: number;
    testRequestAfterCooldown: boolean;
  };
  rateLimit: {
    defaultRetryAfter: number;
    respectRetryAfterHeader: boolean;
    backoffMultiplier: number;
    maxBackoff: number;
  };
  queue: {
    maxQueueSize: number;
    queueTimeout: number;
    priorityLevels: {
      high: number;
      normal: number;
      low: number;
    };
    skipRateLimited: boolean;
  };
  priorityFailover: boolean;
}

export class ModelPoolManager {
  private slots: Map<string, ModelSlot> = new Map();
  private config: ModelPoolConfig;
  private logger: any;
  private queueProcessCallbacks: Map<string, (request: QueuedRequest) => void> = new Map();
  private reservationTimeoutMap: Map<string, NodeJS.Timeout> = new Map();
  private queueProcessingInterval?: NodeJS.Timeout;

  constructor(configService: ConfigService, logger: any = console) {
    this.logger = logger;
    this.config = this.loadConfig(configService);
    this.logger.info('[ModelPoolManager] Initialized with config', this.config);
    this.startQueueProcessing();
  }

  private loadConfig(configService: ConfigService): ModelPoolConfig {
    const poolConfig = configService.get<any>('modelPool') || {};

    return {
      maxConcurrentPerModel: poolConfig.maxConcurrentPerModel || 2,
      circuitBreaker: {
        failureThreshold: poolConfig.circuitBreaker?.failureThreshold || 5,
        cooldownPeriod: poolConfig.circuitBreaker?.cooldownPeriod || 60000,
        testRequestAfterCooldown: poolConfig.circuitBreaker?.testRequestAfterCooldown !== false,
      },
      rateLimit: {
        defaultRetryAfter: poolConfig.rateLimit?.defaultRetryAfter || 60000,
        respectRetryAfterHeader: poolConfig.rateLimit?.respectRetryAfterHeader !== false,
        backoffMultiplier: poolConfig.rateLimit?.backoffMultiplier || 1.5,
        maxBackoff: poolConfig.rateLimit?.maxBackoff || 300000,
      },
      queue: {
        maxQueueSize: poolConfig.queue?.maxQueueSize || 100,
        queueTimeout: poolConfig.queue?.queueTimeout || 300000,
        priorityLevels: {
          high: poolConfig.queue?.priorityLevels?.high || 10,
          normal: poolConfig.queue?.priorityLevels?.normal || 0,
          low: poolConfig.queue?.priorityLevels?.low || -10,
        },
        skipRateLimited: poolConfig.queue?.skipRateLimited !== false,
      },
      priorityFailover: poolConfig.priorityFailover !== false,
    };
  }

  private startQueueProcessing(): void {
    this.queueProcessingInterval = setInterval(() => {
      this.processAllQueues();
      this.checkQueueHealth();
    }, 1000); // Process all queues every second

    this.logger.info('[ModelPoolManager] Background queue processing started');
  }

  private checkQueueHealth(): void {
    const warningThreshold = this.config.queue.maxQueueSize * 0.8; // 80% of max queue size
    const criticalThreshold = this.config.queue.maxQueueSize * 0.95; // 95% of max queue size

    for (const [key, slot] of this.slots.entries()) {
      const queueLength = slot.queuedRequests.length;

      if (queueLength >= criticalThreshold) {
        this.logger.error(
          `[ModelPoolManager] CRITICAL: Queue depth for ${key} is ${queueLength}/${this.config.queue.maxQueueSize} (${Math.round(queueLength / this.config.queue.maxQueueSize * 100)}%)`
        );
      } else if (queueLength >= warningThreshold) {
        this.logger.warn(
          `[ModelPoolManager] WARNING: Queue depth for ${key} is ${queueLength}/${this.config.queue.maxQueueSize} (${Math.round(queueLength / this.config.queue.maxQueueSize * 100)}%)`
        );
      }
    }
  }

  private processAllQueues(): void {
    for (const [key, slot] of this.slots.entries()) {
      if (slot.queuedRequests.length > 0) {
        this.processQueueForSlot(key);
      }
    }
  }

  destroy(): void {
    if (this.queueProcessingInterval) {
      clearInterval(this.queueProcessingInterval);
      this.queueProcessingInterval = undefined;
      this.logger.info('[ModelPoolManager] Background queue processing stopped');
    }
  }

  private getOrCreateSlot(provider: string, model: string): ModelSlot {
    const key = `${provider},${model}`;

    if (!this.slots.has(key)) {
      this.slots.set(key, {
        provider,
        model,
        activeRequests: 0,
        reservedRequests: 0,
        reservedForQueue: 0,
        maxConcurrent: this.config.maxConcurrentPerModel,
        queuedRequests: [],
        lastUsed: Date.now(),
        circuitBreakerOpen: false,
        failureCount: 0,
        successCount: 0,
        rateLimitBackoffCount: 0,
        rateLimitBaseRetryAfter: this.config.rateLimit.defaultRetryAfter,
      });

      this.logger.debug(
        `[ModelPoolManager] Created new slot for ${key}`
      );
    }

    return this.slots.get(key)!;
  }

  private validateSlotCounters(slot: ModelSlot, provider: string, model: string): void {
    let hasIssues = false;

    if (slot.activeRequests < 0) {
      this.logger.error(
        `[ModelPoolManager] Negative activeRequests detected for ${provider},${model}: ${slot.activeRequests}. Resetting to 0.`
      );
      slot.activeRequests = 0;
      hasIssues = true;
    }

    if (slot.reservedRequests < 0) {
      this.logger.error(
        `[ModelPoolManager] Negative reservedRequests detected for ${provider},${model}: ${slot.reservedRequests}. Resetting to 0.`
      );
      slot.reservedRequests = 0;
      hasIssues = true;
    }

    if (slot.reservedForQueue < 0) {
      this.logger.error(
        `[ModelPoolManager] Negative reservedForQueue detected for ${provider},${model}: ${slot.reservedForQueue}. Resetting to 0.`
      );
      slot.reservedForQueue = 0;
      hasIssues = true;
    }

    if (hasIssues) {
      this.logger.warn(
        `[ModelPoolManager] Reset counters for ${provider},${model} - ` +
        `active: ${slot.activeRequests}, reserved: ${slot.reservedRequests}, reservedForQueue: ${slot.reservedForQueue}`
      );
    }
  }

  hasCapacity(provider: string, model: string): boolean {
    const slot = this.getOrCreateSlot(provider, model);

    this.validateSlotCounters(slot, provider, model);

    if (slot.circuitBreakerOpen) {
      if (slot.circuitBreakerOpenUntil && Date.now() < slot.circuitBreakerOpenUntil) {
        this.logger.debug(
          `[ModelPoolManager] Circuit breaker open for ${provider},${model}, ` +
          `cooldown until ${new Date(slot.circuitBreakerOpenUntil).toISOString()}`
        );
        return false;
      }

      if (this.config.circuitBreaker.testRequestAfterCooldown) {
        this.logger.info(
          `[ModelPoolManager] Circuit breaker cooldown passed for ${provider},${model}, ` +
          `allowing test request`
        );
        slot.circuitBreakerOpen = false;
        slot.failureCount = 0;
      } else {
        return false;
      }
    }

    if (slot.rateLimitUntil && Date.now() < slot.rateLimitUntil) {
      this.logger.debug(
        `[ModelPoolManager] Rate limited for ${provider},${model}, ` +
        `retry after ${new Date(slot.rateLimitUntil).toISOString()}`
      );
      return false;
    }

    const effectiveCapacity = slot.maxConcurrent - slot.activeRequests - slot.reservedRequests - slot.reservedForQueue;
    return effectiveCapacity > 0;
  }

  async acquireSlot(
    provider: string,
    model: string,
    priority: number = 0
  ): Promise<boolean> {
    const slot = this.getOrCreateSlot(provider, model);

    if (this.hasCapacity(provider, model)) {
      slot.activeRequests++;
      slot.lastUsed = Date.now();
      this.logger.debug(
        `[ModelPoolManager] Acquired slot for ${provider},${model} ` +
        `(${slot.activeRequests}/${slot.maxConcurrent} active, ` +
        `${slot.reservedRequests} reserved, ${slot.reservedForQueue} reservedForQueue)`
      );
      return true;
    }

    return false;
  }

  reserveSlot(
    provider: string,
    model: string,
    timeoutMs: number = 30000,
    reservationId?: string
  ): string | boolean {
    const slot = this.getOrCreateSlot(provider, model);
    const key = `${provider},${model}`;

    const currentUsage = slot.activeRequests + slot.reservedRequests + slot.reservedForQueue;
    
    if (currentUsage < slot.maxConcurrent) {
      slot.reservedRequests++;

      this.validateSlotCounters(slot, provider, model);

      this.logger.debug(
        `[ModelPoolManager] Reserved slot for ${provider},${model} ` +
        `(${slot.activeRequests} active, ${slot.reservedRequests} reserved, ${slot.reservedForQueue} reservedForQueue, capacity: ${slot.maxConcurrent})`
      );

      const actualReservationId = reservationId || `${key}-${Date.now()}-${Math.random()}`;

      const timeoutId = setTimeout(() => {
        const currentSlot = this.slots.get(key);
        if (currentSlot && currentSlot.reservedRequests > 0) {
          currentSlot.reservedRequests--;

          this.logger.warn(
            `[ModelPoolManager] Reservation timeout for ${provider},${model} ` +
            `(reservationId: ${actualReservationId})`
          );

          this.reservationTimeoutMap.delete(actualReservationId);

          this.processQueueForSlot(key);
        }
      }, timeoutMs);

      this.reservationTimeoutMap.set(actualReservationId, timeoutId);

      return actualReservationId;
    }

    this.logger.debug(
      `[ModelPoolManager] Cannot reserve slot for ${provider},${model} ` +
      `(usage: ${currentUsage}/${slot.maxConcurrent})`
    );

    return false;
  }

  confirmSlot(provider: string, model: string, reservationId?: string): void {
    const slot = this.slots.get(`${provider},${model}`);
    if (!slot) {
      this.logger.warn(`[ModelPoolManager] Slot not found for ${provider},${model}`);
      return;
    }

    if (slot.reservedRequests > 0) {
      slot.reservedRequests--;
      slot.activeRequests++;
      slot.lastUsed = Date.now();

      this.validateSlotCounters(slot, provider, model);

      this.logger.debug(
        `[ModelPoolManager] Confirmed slot for ${provider},${model} ` +
        `(${slot.activeRequests}/${slot.maxConcurrent} active, ${slot.reservedRequests} reserved)`
      );

      if (reservationId) {
        const timeoutId = this.reservationTimeoutMap.get(reservationId);
        if (timeoutId) {
          clearTimeout(timeoutId);
          this.reservationTimeoutMap.delete(reservationId);
        }
      }
    } else {
      this.logger.warn(
        `[ModelPoolManager] Attempted to confirm slot with no reservations for ${provider},${model}`
      );
    }
  }

  releaseReservation(provider: string, model: string, reservationId?: string): void {
    const slot = this.slots.get(`${provider},${model}`);
    if (!slot) {
      this.logger.warn(`[ModelPoolManager] Slot not found for ${provider},${model}`);
      return;
    }

    if (slot.reservedRequests > 0) {
      slot.reservedRequests--;

      this.validateSlotCounters(slot, provider, model);
    } else {
      this.logger.warn(
        `[ModelPoolManager] Attempted to release reservation with reservedRequests=0 for ${provider},${model}`
      );
    }

    this.logger.debug(
      `[ModelPoolManager] Released reservation for ${provider},${model} ` +
      `(reserved: ${slot.reservedRequests})`
    );

    if (reservationId) {
      const timeoutId = this.reservationTimeoutMap.get(reservationId);
      if (timeoutId) {
        clearTimeout(timeoutId);
        this.reservationTimeoutMap.delete(reservationId);
      }
    }

    const key = `${provider},${model}`;
    this.processQueueForSlot(key);
  }

  isRateLimited(provider: string, model: string): boolean {
    const slot = this.slots.get(`${provider},${model}`);
    if (!slot) return false;

    if (slot.rateLimitUntil && Date.now() < slot.rateLimitUntil) {
      return true;
    }

    return false;
  }

  isCircuitBreakerOpen(provider: string, model: string): boolean {
    const slot = this.slots.get(`${provider},${model}`);
    if (!slot) return false;

    if (slot.circuitBreakerOpen && slot.circuitBreakerOpenUntil) {
      if (Date.now() < slot.circuitBreakerOpenUntil) {
        return true;
      }

      if (this.config.circuitBreaker.testRequestAfterCooldown) {
        slot.circuitBreakerOpen = false;
        slot.failureCount = 0;
      }
    }

    return false;
  }

  async enqueueRequest(
    provider: string,
    model: string,
    req: any,
    reply: any,
    transformer: any,
    priority: number = 0,
    onProcess?: (request: QueuedRequest) => void
  ): Promise<any> {
    const slot = this.getOrCreateSlot(provider, model);

    if (slot.queuedRequests.length >= this.config.queue.maxQueueSize) {
      throw new Error(
        `Queue full for ${provider},${model} ` +
        `(${slot.queuedRequests.length}/${this.config.queue.maxQueueSize})`
      );
    }

    const requestId = `${provider},${model}-${Date.now()}-${Math.random()}`;

    return new Promise((resolve, reject) => {
      const queuedRequest: QueuedRequest = {
        id: requestId,
        req,
        reply,
        transformer,
        priority,
        timestamp: Date.now(),
        timeout: this.config.queue.queueTimeout,
        resolve,
        reject,
      };

      slot.queuedRequests.push(queuedRequest);
      slot.queuedRequests.sort((a, b) => b.priority - a.priority);

      slot.reservedForQueue++;

      if (onProcess) {
        this.queueProcessCallbacks.set(requestId, onProcess);
      }

      queuedRequest.timeoutId = setTimeout(() => {
        const removed = this.removeFromQueue(provider, model, requestId);
        if (removed) {
          slot.reservedForQueue--;
          reject(new Error(`Request timeout after ${this.config.queue.queueTimeout}ms`));
        }
      }, this.config.queue.queueTimeout);

      this.logger.info(
        `[ModelPoolManager] Request queued for ${provider},${model} ` +
        `(position: ${slot.queuedRequests.length}, priority: ${priority}, reservedForQueue: ${slot.reservedForQueue})`
      );
    });
  }

  removeFromQueue(provider: string, model: string, requestId: string): boolean {
    const slot = this.slots.get(`${provider},${model}`);
    if (!slot) return false;

    const index = slot.queuedRequests.findIndex((r) => r.id === requestId);
    if (index !== -1) {
      const request = slot.queuedRequests[index];
      if (request.timeoutId) {
        clearTimeout(request.timeoutId);
      }
      slot.queuedRequests.splice(index, 1);

if (slot.reservedForQueue > 0) {
      slot.reservedForQueue--;

      this.validateSlotCounters(slot, provider, model);
    } else {
      this.logger.warn(
        `[ModelPoolManager] Attempted to decrement reservedForQueue with value=0 for ${provider},${model}`
      );
    }

      this.queueProcessCallbacks.delete(requestId);

      this.logger.debug(
        `[ModelPoolManager] Removed request from queue ${provider},${model} ` +
        `(remaining: ${slot.queuedRequests.length}, reservedForQueue: ${slot.reservedForQueue})`
      );

      return true;
    }
    return false;
  }

  processNextQueuedRequest(provider: string, model: string): QueuedRequest | null {
    const slot = this.slots.get(`${provider},${model}`);
    if (!slot || slot.queuedRequests.length === 0) {
      return null;
    }

    const nextRequest = slot.queuedRequests.shift()!;

    if (nextRequest.timeoutId) {
      clearTimeout(nextRequest.timeoutId);
    }

    if (slot.reservedForQueue > 0) {
      slot.reservedForQueue--;

      this.validateSlotCounters(slot, provider, model);
    }
    slot.activeRequests++;
    slot.lastUsed = Date.now();

    this.validateSlotCounters(slot, provider, model);

    this.logger.info(
      `[ModelPoolManager] Processing queued request for ${provider},${model} ` +
      `(${slot.queuedRequests.length} remaining, active: ${slot.activeRequests}/${slot.maxConcurrent})`
    );

    return nextRequest;
  }

  private processQueueForSlot(slotKey: string): void {
    const slot = this.slots.get(slotKey);
    if (!slot || slot.queuedRequests.length === 0) {
      return;
    }

    const effectiveCapacity = slot.maxConcurrent - slot.activeRequests - slot.reservedRequests - slot.reservedForQueue;

    if (effectiveCapacity > 0) {
      this.logger.debug(
        `[ModelPoolManager] Processing queue for ${slotKey} ` +
        `(effectiveCapacity: ${effectiveCapacity}, queued: ${slot.queuedRequests.length})`
      );

      const nextRequest = this.processNextQueuedRequest(slot.provider, slot.model);

      if (nextRequest) {
        nextRequest.resolve({ provider: slot.provider, model: slot.model });

        const callback = this.queueProcessCallbacks.get(nextRequest.id);
        if (callback) {
          this.logger.debug(`[ModelPoolManager] Invoking processing callback for ${nextRequest.id}`);
          try {
            callback(nextRequest);
          } catch (callbackError) {
            this.logger.error(`[ModelPoolManager] Error in processing callback: ${callbackError}`);
          } finally {
            this.queueProcessCallbacks.delete(nextRequest.id);
          }
        }
      }
    }
  }

  releaseSlot(provider: string, model: string, success: boolean): void {
    const slot = this.slots.get(`${provider},${model}`);
    if (!slot) {
      this.logger.warn(`[ModelPoolManager] Slot not found for ${provider},${model}`);
      return;
    }

    const beforeRelease = slot.activeRequests;

    if (slot.activeRequests > 0) {
      slot.activeRequests--;

      this.validateSlotCounters(slot, provider, model);
    } else {
      this.logger.warn(
        `[ModelPoolManager] Attempted to release slot with activeRequests=0 for ${provider},${model}`
      );
    }

    if (success) {
      slot.successCount++;
    } else {
      slot.failureCount++;
    }

    this.logger.debug(
      `[ModelPoolManager] Released slot for ${provider},${model} ` +
      `(active: ${beforeRelease} → ${slot.activeRequests}/${slot.maxConcurrent}, ` +
      `reserved: ${slot.reservedRequests}, ` +
      `queued: ${slot.reservedForQueue})`
    );

    const key = `${provider},${model}`;
    this.processQueueForSlot(key);
  }

  markRateLimit(provider: string, model: string, retryAfter?: number): void {
    const slot = this.getOrCreateSlot(provider, model);

    slot.rateLimitBackoffCount++;

    let calculatedRetryAfter: number;

    if (retryAfter && this.config.rateLimit.respectRetryAfterHeader) {
      calculatedRetryAfter = retryAfter;
      slot.rateLimitBaseRetryAfter = retryAfter;
    } else {
      calculatedRetryAfter = Math.min(
        slot.rateLimitBaseRetryAfter * Math.pow(this.config.rateLimit.backoffMultiplier, slot.rateLimitBackoffCount - 1),
        this.config.rateLimit.maxBackoff
      );
    }

    slot.rateLimitUntil = Date.now() + calculatedRetryAfter;

    this.logger.warn(
      `[ModelPoolManager] Rate limit marked for ${provider},${model}, ` +
      `retry after ${new Date(slot.rateLimitUntil).toISOString()} ` +
      `(backoff count: ${slot.rateLimitBackoffCount}, duration: ${calculatedRetryAfter}ms)`
    );
  }

  markFailure(provider: string, model: string): void {
    const slot = this.getOrCreateSlot(provider, model);
    slot.failureCount++;

    this.logger.warn(
      `[ModelPoolManager] Failure marked for ${provider},${model} ` +
      `(failure count: ${slot.failureCount}/${this.config.circuitBreaker.failureThreshold})`
    );

    if (slot.failureCount >= this.config.circuitBreaker.failureThreshold) {
      slot.circuitBreakerOpen = true;
      slot.circuitBreakerOpenUntil = Date.now() + this.config.circuitBreaker.cooldownPeriod;

      this.logger.error(
        `[ModelPoolManager] Circuit breaker opened for ${provider},${model} ` +
        `(cooldown until ${new Date(slot.circuitBreakerOpenUntil).toISOString()})`
      );
    }
  }

  /**
   * Handle provider-specific errors with enhanced logging and rate limiting
   */
  handleProviderError(
    provider: string,
    model: string,
    statusCode: number,
    errorBody: any
  ): ProviderError {
    const providerError = ProviderErrorHandler.parseError(provider, statusCode, errorBody);

    if (providerError.isRetryable) {
      // Use provider-specific retry after if available
      if (providerError.retryAfter) {
        this.markRateLimit(provider, model, providerError.retryAfter);
      } else if (providerError.code === "rate_limit_aggressive") {
        // Aggressive rate limiting - use longer backoff
        this.markRateLimit(provider, model, 60000);
      } else if (providerError.code === "rate_limit") {
        this.markRateLimit(provider, model);
      } else {
        // Other retryable errors - mark as failure but don't rate limit
        this.markFailure(provider, model);
      }
    } else {
      // Non-retryable errors - mark as failure
      this.markFailure(provider, model);

      // Log specific non-retryable errors
      if (providerError.code === "invalid_api_key" || providerError.code === "token_expired") {
        this.logger.error(
          `[ModelPoolManager] Authentication error for ${provider},${model}: ${providerError.message}`
        );
      } else if (providerError.code === "content_too_large") {
        this.logger.warn(
          `[ModelPoolManager] Content too large for ${provider},${model}: ${providerError.message}`
        );
      }
    }

    return providerError;
  }

  /**
   * Check if should failover to alternative provider based on error
   */
  shouldFailover(error: ProviderError): boolean {
    return ProviderErrorHandler.shouldFailover(error);
  }

  markSuccess(provider: string, model: string): void {
    const slot = this.getOrCreateSlot(provider, model);
    slot.successCount++;

    if (slot.failureCount > 0) {
      slot.failureCount = Math.max(0, slot.failureCount - 1);
    }

    if (slot.rateLimitBackoffCount > 0) {
      slot.rateLimitBackoffCount = 0;
      slot.rateLimitBaseRetryAfter = this.config.rateLimit.defaultRetryAfter;
    }

    this.logger.debug(
      `[ModelPoolManager] Success marked for ${provider},${model} ` +
      `(success count: ${slot.successCount}, failure count: ${slot.failureCount})`
    );
  }

  getAvailableModel(
    preferredModel: string,
    alternatives: Array<{ provider: string; model: string }>
  ): string | null {
    const [preferredProvider, preferredModelName] = preferredModel.split(',');
    if (this.hasCapacity(preferredProvider, preferredModelName)) {
      return preferredModel;
    }

    for (const alt of alternatives) {
      if (this.hasCapacity(alt.provider, alt.model)) {
        this.logger.info(
          `[ModelPoolManager] Found available alternative: ${alt.provider},${alt.model}`
        );
        return `${alt.provider},${alt.model}`;
      }
    }

    return null;
  }

  getAvailableAlternatives(
    alternatives: Array<{ provider: string; model: string }>,
    priority?: number
  ): Array<{ provider: string; model: string }> {
    const available: Array<{ provider: string; model: string }> = [];

    for (const alt of alternatives) {
      if (this.hasCapacity(alt.provider, alt.model)) {
        available.push(alt);
      }
    }

    return available;
  }

  getStatus(): Record<string, any> {
    const status: Record<string, any> = {};

    for (const [key, slot] of this.slots.entries()) {
      const effectiveCapacity = slot.maxConcurrent - slot.activeRequests - slot.reservedRequests - slot.reservedForQueue;

      status[key] = {
        activeRequests: slot.activeRequests,
        reservedRequests: slot.reservedRequests,
        reservedForQueue: slot.reservedForQueue,
        maxConcurrent: slot.maxConcurrent,
        effectiveCapacity: effectiveCapacity,
        queuedRequests: slot.queuedRequests.length,
        circuitBreakerOpen: slot.circuitBreakerOpen,
        circuitBreakerOpenUntil: slot.circuitBreakerOpenUntil
          ? new Date(slot.circuitBreakerOpenUntil).toISOString()
          : null,
        rateLimitUntil: slot.rateLimitUntil
          ? new Date(slot.rateLimitUntil).toISOString()
          : null,
        rateLimitBackoffCount: slot.rateLimitBackoffCount,
        rateLimitBaseRetryAfter: slot.rateLimitBaseRetryAfter,
        failureCount: slot.failureCount,
        successCount: slot.successCount,
        successRate:
          slot.failureCount + slot.successCount > 0
            ? (slot.successCount / (slot.failureCount + slot.successCount)) * 100
            : 100,
        lastUsed: new Date(slot.lastUsed).toISOString(),
      };
    }

    return status;
  }

  getQueueStatus(): Record<string, any> {
    const queueStatus: Record<string, any> = {};

    for (const [key, slot] of this.slots.entries()) {
      if (slot.queuedRequests.length > 0) {
        queueStatus[key] = {
          queueLength: slot.queuedRequests.length,
          oldestRequestTimestamp: slot.queuedRequests[0].timestamp,
          oldestRequestAge: Date.now() - slot.queuedRequests[0].timestamp,
          priorityRange: {
            min: Math.min(...slot.queuedRequests.map((r) => r.priority)),
            max: Math.max(...slot.queuedRequests.map((r) => r.priority)),
          },
        };
      }
    }

    return queueStatus;
  }

  resetCircuitBreakers(): void {
    for (const slot of this.slots.values()) {
      slot.circuitBreakerOpen = false;
      slot.circuitBreakerOpenUntil = undefined;
      slot.failureCount = 0;
    }

    this.logger.info('[ModelPoolManager] All circuit breakers reset');
  }

  clearQueue(): void {
    for (const slot of this.slots.values()) {
      for (const request of slot.queuedRequests) {
        if (request.timeoutId) {
          clearTimeout(request.timeoutId);
        }
        request.reject(new Error('Queue cleared'));
        this.queueProcessCallbacks.delete(request.id);
      }
      slot.queuedRequests = [];
    }

    this.logger.info('[ModelPoolManager] All queues cleared');
  }

  getConfig(): ModelPoolConfig {
    return { ...this.config };
  }
}
