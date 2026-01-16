import { ConfigService } from './config';

/**
 * Represents a slot for a specific provider+model combination
 */
export interface ModelSlot {
  provider: string;
  model: string;
  activeRequests: number;
  reservedRequests: number;
  reservedForQueue: number;  // Tracks reservations held for queued requests
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

/**
 * Represents a queued request waiting for a slot
 */
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
}

/**
 * Configuration for model pool behavior
 */
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

/**
 * Model Pool Manager
 * 
 * Manages concurrent request slots for provider+model combinations,
 * implements circuit breaker pattern, rate limit tracking, and request queuing.
 */
export class ModelPoolManager {
  private slots: Map<string, ModelSlot> = new Map();
  private config: ModelPoolConfig;
  private logger: any;

  constructor(configService: ConfigService, logger: any = console) {
    this.logger = logger;
    this.config = this.loadConfig(configService);
    this.logger.info('[ModelPoolManager] Initialized with config', this.config);
  }

  /**
   * Load configuration from ConfigService
   */
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

  /**
   * Get or create a model slot
   */
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
    }
    
    return this.slots.get(key)!;
  }

  /**
   * Check if a model has capacity for a new request
   * Takes into account active requests, reservations, and queued requests
   */
  hasCapacity(provider: string, model: string): boolean {
    const slot = this.getOrCreateSlot(provider, model);
    
    // Check circuit breaker
    if (slot.circuitBreakerOpen) {
      // Check if cooldown period has passed
      if (slot.circuitBreakerOpenUntil && Date.now() < slot.circuitBreakerOpenUntil) {
        this.logger.debug(
          `[ModelPoolManager] Circuit breaker open for ${provider},${model}, ` +
          `cooldown until ${new Date(slot.circuitBreakerOpenUntil).toISOString()}`
        );
        return false;
      }
      
      // Cooldown passed, close circuit breaker if test request enabled
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
    
    // Check rate limit
    if (slot.rateLimitUntil && Date.now() < slot.rateLimitUntil) {
      this.logger.debug(
        `[ModelPoolManager] Rate limited for ${provider},${model}, ` +
        `retry after ${new Date(slot.rateLimitUntil).toISOString()}`
      );
      return false;
    }
    
    // Check concurrent request limit
    // Capacity = maxConcurrent - active - reserved - reservedForQueue
    // The reservedForQueue ensures we don't queue more than we can handle
    const effectiveCapacity = slot.maxConcurrent - slot.activeRequests - slot.reservedRequests - slot.reservedForQueue;
    return effectiveCapacity > 0;
  }

  /**
   * Acquire a slot for a request
   * Returns true if slot acquired, false if request was queued
   */
  async acquireSlot(
    provider: string,
    model: string,
    priority: number = 0
  ): Promise<boolean> {
    const slot = this.getOrCreateSlot(provider, model);
    
    // Check if we can acquire immediately
    if (this.hasCapacity(provider, model)) {
      slot.activeRequests++;
      slot.lastUsed = Date.now();
      this.logger.debug(
        `[ModelPoolManager] Acquired slot for ${provider},${model} ` +
        `(${slot.activeRequests}/${slot.maxConcurrent} active)`
      );
      return true;
    }
    
    // Cannot acquire immediately, queue the request
    return false;
  }

  /**
   * Reserve a slot for a request
   * Returns true if slot reserved, false if no capacity
   * 
   * The reserved slot must be confirmed via confirmSlot() or released via releaseReservation()
   * Unconfirmed reservations auto-expire after 30 seconds
   */
  reserveSlot(
    provider: string,
    model: string,
    timeoutMs: number = 30000
  ): boolean {
    const slot = this.getOrCreateSlot(provider, model);
    
    // Check if we can reserve (considering active, reserved, and reservedForQueue)
    if ((slot.activeRequests + slot.reservedRequests + slot.reservedForQueue) < slot.maxConcurrent) {
      slot.reservedRequests++;
      this.logger.debug(
        `[ModelPoolManager] Reserved slot for ${provider},${model} ` +
        `(${slot.activeRequests} active, ${slot.reservedRequests} reserved, ${slot.reservedForQueue} reservedForQueue)`
      );
      
      // Set timeout to release reservation if not confirmed
      setTimeout(() => {
        if (slot.reservedRequests > 0) {
          slot.reservedRequests--;
          this.logger.debug(
            `[ModelPoolManager] Reservation timeout for ${provider},${model}`
          );
        }
      }, timeoutMs);
      
      return true;
    }
    
    return false;
  }

  /**
   * Confirm a reserved slot (convert to active)
   */
  confirmSlot(provider: string, model: string): void {
    const slot = this.slots.get(`${provider},${model}`);
    if (!slot) {
      this.logger.warn(`[ModelPoolManager] Slot not found for ${provider},${model}`);
      return;
    }
    
    if (slot.reservedRequests > 0) {
      slot.reservedRequests--;
      slot.activeRequests++;
      slot.lastUsed = Date.now();
      this.logger.debug(
        `[ModelPoolManager] Confirmed slot for ${provider},${model} ` +
        `(${slot.activeRequests}/${slot.maxConcurrent} active)`
      );
    }
  }

  /**
   * Release a reserved slot without converting to active
   */
  releaseReservation(provider: string, model: string): void {
    const slot = this.slots.get(`${provider},${model}`);
    if (!slot) {
      this.logger.warn(`[ModelPoolManager] Slot not found for ${provider},${model}`);
      return;
    }
    
    if (slot.reservedRequests > 0) {
      slot.reservedRequests--;
      this.logger.debug(
        `[ModelPoolManager] Released reservation for ${provider},${model}`
      );
    }
  }

  /**
   * Check if a provider+model is currently rate-limited
   */
  isRateLimited(provider: string, model: string): boolean {
    const slot = this.slots.get(`${provider},${model}`);
    if (!slot) return false;
    
    if (slot.rateLimitUntil && Date.now() < slot.rateLimitUntil) {
      return true;
    }
    
    return false;
  }

  /**
   * Check if a provider+model has circuit breaker open
   */
  isCircuitBreakerOpen(provider: string, model: string): boolean {
    const slot = this.slots.get(`${provider},${model}`);
    if (!slot) return false;
    
    if (slot.circuitBreakerOpen && slot.circuitBreakerOpenUntil) {
      if (Date.now() < slot.circuitBreakerOpenUntil) {
        return true;
      }
      // Cooldown passed, allow test request
      if (this.config.circuitBreaker.testRequestAfterCooldown) {
        slot.circuitBreakerOpen = false;
        slot.failureCount = 0;
      }
    }
    
    return false;
  }

  /**
   * Enqueue a request waiting for a slot
   * 
   * IMPORTANT: The caller is responsible for holding a reserved slot BEFORE calling this.
   * The reserved slot will be converted from reserved to active when the request is processed.
   */
  async enqueueRequest(
    provider: string,
    model: string,
    req: any,
    reply: any,
    transformer: any,
    priority: number = 0
  ): Promise<any> {
    const slot = this.getOrCreateSlot(provider, model);
    
    // Check queue size limit
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
      
      // Add to queue (sorted by priority, higher first)
      slot.queuedRequests.push(queuedRequest);
      slot.queuedRequests.sort((a, b) => b.priority - a.priority);
      
      // Track that we're holding a slot for this queued request
      // This slot will be converted to active when processed
      slot.reservedForQueue++;
      
      // Set timeout - when it fires, remove from queue and reject
      queuedRequest.timeoutId = setTimeout(() => {
        const removed = this.removeFromQueue(provider, model, requestId);
        if (removed) {
          reject(new Error(`Request timeout after ${this.config.queue.queueTimeout}ms`));
        }
      }, this.config.queue.queueTimeout);
      
      this.logger.info(
        `[ModelPoolManager] Request queued for ${provider},${model} ` +
        `(position: ${slot.queuedRequests.length}, priority: ${priority}, reservedForQueue: ${slot.reservedForQueue})`
      );
    });
  }

  /**
   * Remove a request from the queue
   * Returns true if the request was found and removed
   */
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
      // Release the reserved slot that was being held for this queued request
      if (slot.reservedForQueue > 0) {
        slot.reservedForQueue--;
      }
      return true;
    }
    return false;
  }

  /**
   * Process the next queued request for a provider+model
   * Returns the queued request if one was processed, null otherwise
   */
  processNextQueuedRequest(provider: string, model: string): QueuedRequest | null {
    const slot = this.slots.get(`${provider},${model}`);
    if (!slot || slot.queuedRequests.length === 0) {
      return null;
    }
    
    const nextRequest = slot.queuedRequests.shift()!;
    
    if (nextRequest.timeoutId) {
      clearTimeout(nextRequest.timeoutId);
    }
    
    // Convert reservedForQueue to activeRequests
    if (slot.reservedForQueue > 0) {
      slot.reservedForQueue--;
    }
    slot.activeRequests++;
    slot.lastUsed = Date.now();
    
    this.logger.info(
      `[ModelPoolManager] Processing queued request for ${provider},${model} ` +
      `(${slot.queuedRequests.length} remaining, active: ${slot.activeRequests}/${slot.maxConcurrent})`
    );
    
    return nextRequest;
  }

  /**
   * Release a slot and process next queued request
   * 
   * Flow:
   * 1. Release the active slot
   * 2. Update success/failure counters
   3. If there are queued requests waiting, process the next one (convert reserved to active)
   */
  releaseSlot(provider: string, model: string, success: boolean): void {
    const slot = this.slots.get(`${provider},${model}`);
    if (!slot) {
      this.logger.warn(`[ModelPoolManager] Slot not found for ${provider},${model}`);
      return;
    }
    
    // Release active slot
    if (slot.activeRequests > 0) {
      slot.activeRequests--;
    }
    
    // Update success/failure counters
    if (success) {
      slot.successCount++;
    } else {
      slot.failureCount++;
    }
    
    this.logger.debug(
      `[ModelPoolManager] Released slot for ${provider},${model} ` +
      `(${slot.activeRequests}/${slot.maxConcurrent} active, ${slot.reservedForQueue} reserved for queue)`
    );
    
    // Process next queued request if any
    // The queued request was already holding a reserved slot via reservedForQueue
    // We just need to convert it to active now that there's capacity
    if (slot.queuedRequests.length > 0) {
      const nextRequest = slot.queuedRequests.shift()!;
      
      if (nextRequest.timeoutId) {
        clearTimeout(nextRequest.timeoutId);
      }
      
      // Convert reservedForQueue to active
      if (slot.reservedForQueue > 0) {
        slot.reservedForQueue--;
      }
      slot.activeRequests++;
      slot.lastUsed = Date.now();
      
      this.logger.info(
        `[ModelPoolManager] Processing queued request for ${provider},${model} ` +
        `(${slot.queuedRequests.length} remaining, active: ${slot.activeRequests}/${slot.maxConcurrent})`
      );
      
      // Resolve the promise to let the request proceed
      nextRequest.resolve({ provider, model });
    }
  }

  /**
   * Mark a provider+model as rate-limited with exponential backoff
   */
  markRateLimit(provider: string, model: string, retryAfter?: number): void {
    const slot = this.getOrCreateSlot(provider, model);
    
    // Increment backoff count
    slot.rateLimitBackoffCount++;
    
    // Calculate retry after with exponential backoff
    let calculatedRetryAfter: number;
    
    if (retryAfter && this.config.rateLimit.respectRetryAfterHeader) {
      // Use provider's retry-after if available
      calculatedRetryAfter = retryAfter;
      slot.rateLimitBaseRetryAfter = retryAfter;
    } else {
      // Use exponential backoff
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

  /**
   * Mark a failure for a provider+model
   */
  markFailure(provider: string, model: string): void {
    const slot = this.getOrCreateSlot(provider, model);
    slot.failureCount++;
    
    this.logger.warn(
      `[ModelPoolManager] Failure marked for ${provider},${model} ` +
      `(failure count: ${slot.failureCount}/${this.config.circuitBreaker.failureThreshold})`
    );
    
    // Check if circuit breaker should be opened
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
   * Mark a success for a provider+model
   */
  markSuccess(provider: string, model: string): void {
    const slot = this.getOrCreateSlot(provider, model);
    slot.successCount++;
    
    // Reset failure count on success (gradual recovery)
    if (slot.failureCount > 0) {
      slot.failureCount = Math.max(0, slot.failureCount - 1);
    }
    
    // Reset rate limit backoff count on success
    if (slot.rateLimitBackoffCount > 0) {
      slot.rateLimitBackoffCount = 0;
      slot.rateLimitBaseRetryAfter = this.config.rateLimit.defaultRetryAfter;
    }
    
    this.logger.debug(
      `[ModelPoolManager] Success marked for ${provider},${model} ` +
      `(success count: ${slot.successCount}, failure count: ${slot.failureCount})`
    );
  }

  /**
   * Get an available model from a list of alternatives
   */
  getAvailableModel(
    preferredModel: string,
    alternatives: Array<{ provider: string; model: string }>
  ): string | null {
    // Check preferred model first
    const [preferredProvider, preferredModelName] = preferredModel.split(',');
    if (this.hasCapacity(preferredProvider, preferredModelName)) {
      return preferredModel;
    }
    
    // Check alternatives
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

  /**
   * Get all available alternatives from a list, filtering out rate-limited and circuit-open models
   */
  getAvailableAlternatives(
    alternatives: Array<{ provider: string; model: string }>,
    priority?: number
  ): Array<{ provider: string; model: string }> {
    const available: Array<{ provider: string; model: string }> = [];
    
    for (const alt of alternatives) {
      // Check if this alternative is available
      if (this.hasCapacity(alt.provider, alt.model)) {
        available.push(alt);
      }
    }
    
    return available;
  }

  /**
   * Get status of all model slots
   */
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

  /**
   * Get queue status
   */
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

  /**
   * Reset all circuit breakers
   */
  resetCircuitBreakers(): void {
    for (const slot of this.slots.values()) {
      slot.circuitBreakerOpen = false;
      slot.circuitBreakerOpenUntil = undefined;
      slot.failureCount = 0;
    }
    
    this.logger.info('[ModelPoolManager] All circuit breakers reset');
  }

  /**
   * Clear all queued requests
   */
  clearQueue(): void {
    for (const slot of this.slots.values()) {
      for (const request of slot.queuedRequests) {
        if (request.timeoutId) {
          clearTimeout(request.timeoutId);
        }
        request.reject(new Error('Queue cleared'));
      }
      slot.queuedRequests = [];
    }
    
    this.logger.info('[ModelPoolManager] All queues cleared');
  }

  /**
   * Get configuration
   */
  getConfig(): ModelPoolConfig {
    return { ...this.config };
  }
}