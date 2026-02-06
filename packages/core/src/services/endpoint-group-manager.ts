export interface ProviderInfo {
  name: string;
  models: string[];
  apiKey: string;
}

export interface EndpointSlot {
  endpoint: string;
  providers: string[];
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
  preferredProvider?: string;
}

export interface EndpointGroupConfig {
  enabled: boolean;
  maxConcurrentPerEndpoint: number;
  strategy: 'round-robin' | 'least-loaded' | 'random';
  providerWeights: Record<string, number>;
}

export class EndpointGroupManager {
  private endpointSlots: Map<string, EndpointSlot> = new Map();
  private providerEndpoints: Map<string, string> = new Map();
  private config: EndpointGroupConfig;
  private logger: any;
  private queueProcessCallbacks: Map<string, (request: QueuedRequest) => void> = new Map();
  private reservationTimeoutMap: Map<string, NodeJS.Timeout> = new Map();
  private roundRobinIndex: Map<string, number> = new Map();

  constructor(config: EndpointGroupConfig, logger: any = console) {
    this.logger = logger;
    this.config = config;
    this.logger.info('[EndpointGroupManager] Initialized', this.config);
  }

  registerProvider(providerName: string, endpoint: string, models: string[]): void {
    this.providerEndpoints.set(providerName, endpoint);

    if (!this.endpointSlots.has(endpoint)) {
      this.endpointSlots.set(endpoint, {
        endpoint,
        providers: [],
        activeRequests: 0,
        reservedRequests: 0,
        reservedForQueue: 0,
        maxConcurrent: this.config.maxConcurrentPerEndpoint,
        queuedRequests: [],
        lastUsed: Date.now(),
        circuitBreakerOpen: false,
        failureCount: 0,
        successCount: 0,
        rateLimitBackoffCount: 0,
        rateLimitBaseRetryAfter: 60000,
      });

      this.roundRobinIndex.set(endpoint, 0);

      this.logger.info(
        `[EndpointGroupManager] Created endpoint group for ${endpoint}`
      );
    }

    const slot = this.endpointSlots.get(endpoint)!;
    if (!slot.providers.includes(providerName)) {
      slot.providers.push(providerName);
      this.logger.info(
        `[EndpointGroupManager] Registered provider ${providerName} for endpoint ${endpoint}`
      );
    }
  }

  private getEndpointSlot(endpoint: string): EndpointSlot {
    const slot = this.endpointSlots.get(endpoint);
    if (!slot) {
      throw new Error(`Endpoint slot not found for ${endpoint}`);
    }
    return slot;
  }

  private validateSlotCounters(slot: EndpointSlot, endpoint: string): void {
    let hasIssues = false;

    if (slot.activeRequests < 0) {
      this.logger.error(
        `[EndpointGroupManager] Negative activeRequests for ${endpoint}: ${slot.activeRequests}. Resetting to 0.`
      );
      slot.activeRequests = 0;
      hasIssues = true;
    }

    if (slot.reservedRequests < 0) {
      this.logger.error(
        `[EndpointGroupManager] Negative reservedRequests for ${endpoint}: ${slot.reservedRequests}. Resetting to 0.`
      );
      slot.reservedRequests = 0;
      hasIssues = true;
    }

    if (slot.reservedForQueue < 0) {
      this.logger.error(
        `[EndpointGroupManager] Negative reservedForQueue for ${endpoint}: ${slot.reservedForQueue}. Resetting to 0.`
      );
      slot.reservedForQueue = 0;
      hasIssues = true;
    }

    if (hasIssues) {
      this.logger.warn(
        `[EndpointGroupManager] Reset counters for ${endpoint} - ` +
        `active: ${slot.activeRequests}, reserved: ${slot.reservedRequests}, reservedForQueue: ${slot.reservedForQueue}`
      );
    }
  }

  hasCapacity(endpoint: string): boolean {
    const slot = this.getEndpointSlot(endpoint);

    this.validateSlotCounters(slot, endpoint);

    if (slot.circuitBreakerOpen) {
      if (slot.circuitBreakerOpenUntil && Date.now() < slot.circuitBreakerOpenUntil) {
        this.logger.debug(
          `[EndpointGroupManager] Circuit breaker open for ${endpoint}, ` +
          `cooldown until ${new Date(slot.circuitBreakerOpenUntil).toISOString()}`
        );
        return false;
      }

      this.logger.info(
        `[EndpointGroupManager] Circuit breaker cooldown passed for ${endpoint}, allowing test request`
      );
      slot.circuitBreakerOpen = false;
      slot.failureCount = 0;
    }

    if (slot.rateLimitUntil && Date.now() < slot.rateLimitUntil) {
      this.logger.debug(
        `[EndpointGroupManager] Rate limited for ${endpoint}, ` +
        `retry after ${new Date(slot.rateLimitUntil).toISOString()}`
      );
      return false;
    }

    const effectiveCapacity = slot.maxConcurrent - slot.activeRequests - slot.reservedRequests - slot.reservedForQueue;
    return effectiveCapacity > 0;
  }

  selectProvider(endpoint: string, preferredProvider?: string): string | null {
    const slot = this.getEndpointSlot(endpoint);

    if (slot.providers.length === 0) {
      return null;
    }

    if (preferredProvider && slot.providers.includes(preferredProvider)) {
      return preferredProvider;
    }

    switch (this.config.strategy) {
      case 'least-loaded':
        return this.selectLeastLoadedProvider(slot);
      case 'round-robin':
        return this.selectRoundRobinProvider(slot);
      case 'random':
        return this.selectRandomProvider(slot);
      default:
        return this.selectLeastLoadedProvider(slot);
    }
  }

  private selectLeastLoadedProvider(slot: EndpointSlot): string {
    return slot.providers[0];
  }

  private selectRoundRobinProvider(slot: EndpointSlot): string {
    const index = this.roundRobinIndex.get(slot.endpoint) || 0;
    const provider = slot.providers[index];
    this.roundRobinIndex.set(slot.endpoint, (index + 1) % slot.providers.length);
    return provider;
  }

  private selectRandomProvider(slot: EndpointSlot): string {
    const randomIndex = Math.floor(Math.random() * slot.providers.length);
    return slot.providers[randomIndex];
  }

  reserveSlot(
    endpoint: string,
    timeoutMs: number = 30000,
    reservationId?: string
  ): string | boolean {
    const slot = this.getEndpointSlot(endpoint);

    const currentUsage = slot.activeRequests + slot.reservedRequests + slot.reservedForQueue;

    if (currentUsage < slot.maxConcurrent) {
      slot.reservedRequests++;

      this.validateSlotCounters(slot, endpoint);

      this.logger.debug(
        `[EndpointGroupManager] Reserved slot for ${endpoint} ` +
        `(${slot.activeRequests} active, ${slot.reservedRequests} reserved, ${slot.reservedForQueue} reservedForQueue, capacity: ${slot.maxConcurrent})`
      );

      const actualReservationId = reservationId || `${endpoint}-${Date.now()}-${Math.random()}`;

      const timeoutId = setTimeout(() => {
        const currentSlot = this.endpointSlots.get(endpoint);
        if (currentSlot && currentSlot.reservedRequests > 0) {
          currentSlot.reservedRequests--;

          this.logger.warn(
            `[EndpointGroupManager] Reservation timeout for ${endpoint} ` +
            `(reservationId: ${actualReservationId})`
          );

          this.reservationTimeoutMap.delete(actualReservationId);

          this.processQueueForEndpoint(endpoint);
        }
      }, timeoutMs);

      this.reservationTimeoutMap.set(actualReservationId, timeoutId);

      return actualReservationId;
    }

    this.logger.debug(
      `[EndpointGroupManager] Cannot reserve slot for ${endpoint} ` +
      `(usage: ${currentUsage}/${slot.maxConcurrent})`
    );

    return false;
  }

  confirmSlot(endpoint: string, reservationId?: string): void {
    const slot = this.endpointSlots.get(endpoint);
    if (!slot) {
      this.logger.warn(`[EndpointGroupManager] Slot not found for ${endpoint}`);
      return;
    }

    if (slot.reservedRequests > 0) {
      slot.reservedRequests--;
      slot.activeRequests++;
      slot.lastUsed = Date.now();

      this.validateSlotCounters(slot, endpoint);

      this.logger.debug(
        `[EndpointGroupManager] Confirmed slot for ${endpoint} ` +
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
        `[EndpointGroupManager] Attempted to confirm slot with no reservations for ${endpoint}`
      );
    }
  }

  releaseReservation(endpoint: string, reservationId?: string): void {
    const slot = this.endpointSlots.get(endpoint);
    if (!slot) {
      this.logger.warn(`[EndpointGroupManager] Slot not found for ${endpoint}`);
      return;
    }

    if (slot.reservedRequests > 0) {
      slot.reservedRequests--;

      this.validateSlotCounters(slot, endpoint);
    } else {
      this.logger.warn(
        `[EndpointGroupManager] Attempted to release reservation with reservedRequests=0 for ${endpoint}`
      );
    }

    this.logger.debug(
      `[EndpointGroupManager] Released reservation for ${endpoint} ` +
      `(reserved: ${slot.reservedRequests})`
    );

    if (reservationId) {
      const timeoutId = this.reservationTimeoutMap.get(reservationId);
      if (timeoutId) {
        clearTimeout(timeoutId);
        this.reservationTimeoutMap.delete(reservationId);
      }
    }

    this.processQueueForEndpoint(endpoint);
  }

  isRateLimited(endpoint: string): boolean {
    const slot = this.endpointSlots.get(endpoint);
    if (!slot) return false;

    if (slot.rateLimitUntil && Date.now() < slot.rateLimitUntil) {
      return true;
    }

    return false;
  }

  isCircuitBreakerOpen(endpoint: string): boolean {
    const slot = this.endpointSlots.get(endpoint);
    if (!slot) return false;

    if (slot.circuitBreakerOpen && slot.circuitBreakerOpenUntil) {
      if (Date.now() < slot.circuitBreakerOpenUntil) {
        return true;
      }

      slot.circuitBreakerOpen = false;
      slot.failureCount = 0;
    }

    return false;
  }

  async enqueueRequest(
    endpoint: string,
    req: any,
    reply: any,
    transformer: any,
    priority: number = 0,
    onProcess?: (request: QueuedRequest) => void,
    preferredProvider?: string
  ): Promise<any> {
    const slot = this.getEndpointSlot(endpoint);

    const requestId = `${endpoint}-${Date.now()}-${Math.random()}`;

    return new Promise((resolve, reject) => {
      const queuedRequest: QueuedRequest = {
        id: requestId,
        req,
        reply,
        transformer,
        priority,
        timestamp: Date.now(),
        timeout: 300000,
        resolve,
        reject,
        preferredProvider,
      };

      slot.queuedRequests.push(queuedRequest);
      slot.queuedRequests.sort((a, b) => b.priority - a.priority);

      slot.reservedForQueue++;

      if (onProcess) {
        this.queueProcessCallbacks.set(requestId, onProcess);
      }

      queuedRequest.timeoutId = setTimeout(() => {
        const removed = this.removeFromQueue(endpoint, requestId);
        if (removed) {
          slot.reservedForQueue--;
          reject(new Error(`Request timeout after 300000ms`));
        }
      }, 300000);

      this.logger.info(
        `[EndpointGroupManager] Request queued for ${endpoint} ` +
        `(position: ${slot.queuedRequests.length}, priority: ${priority}, reservedForQueue: ${slot.reservedForQueue})`
      );
    });
  }

  removeFromQueue(endpoint: string, requestId: string): boolean {
    const slot = this.endpointSlots.get(endpoint);
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

        this.validateSlotCounters(slot, endpoint);
      } else {
        this.logger.warn(
          `[EndpointGroupManager] Attempted to decrement reservedForQueue with value=0 for ${endpoint}`
        );
      }

      this.queueProcessCallbacks.delete(requestId);

      this.logger.debug(
        `[EndpointGroupManager] Removed request from queue ${endpoint} ` +
        `(remaining: ${slot.queuedRequests.length}, reservedForQueue: ${slot.reservedForQueue})`
      );

      return true;
    }
    return false;
  }

  processNextQueuedRequest(endpoint: string): QueuedRequest | null {
    const slot = this.endpointSlots.get(endpoint);
    if (!slot || slot.queuedRequests.length === 0) {
      return null;
    }

    const nextRequest = slot.queuedRequests.shift()!;

    if (nextRequest.timeoutId) {
      clearTimeout(nextRequest.timeoutId);
    }

    if (slot.reservedForQueue > 0) {
      slot.reservedForQueue--;

      this.validateSlotCounters(slot, endpoint);
    }
    slot.activeRequests++;
    slot.lastUsed = Date.now();

    this.validateSlotCounters(slot, endpoint);

    this.logger.info(
      `[EndpointGroupManager] Processing queued request for ${endpoint} ` +
      `(${slot.queuedRequests.length} remaining, active: ${slot.activeRequests}/${slot.maxConcurrent})`
    );

    return nextRequest;
  }

  private processQueueForEndpoint(endpoint: string): void {
    const slot = this.endpointSlots.get(endpoint);
    if (!slot || slot.queuedRequests.length === 0) {
      return;
    }

    const effectiveCapacity = slot.maxConcurrent - slot.activeRequests - slot.reservedRequests - slot.reservedForQueue;

    if (effectiveCapacity > 0) {
      this.logger.debug(
        `[EndpointGroupManager] Processing queue for ${endpoint} ` +
        `(effectiveCapacity: ${effectiveCapacity}, queued: ${slot.queuedRequests.length})`
      );

      const nextRequest = this.processNextQueuedRequest(endpoint);

      if (nextRequest) {
        nextRequest.resolve({ endpoint });

        const callback = this.queueProcessCallbacks.get(nextRequest.id);
        if (callback) {
          this.logger.debug(`[EndpointGroupManager] Invoking processing callback for ${nextRequest.id}`);
          try {
            callback(nextRequest);
          } catch (callbackError) {
            this.logger.error(`[EndpointGroupManager] Error in processing callback: ${callbackError}`);
          } finally {
            this.queueProcessCallbacks.delete(nextRequest.id);
          }
        }
      }
    }
  }

  releaseSlot(endpoint: string, success: boolean): void {
    const slot = this.endpointSlots.get(endpoint);
    if (!slot) {
      this.logger.warn(`[EndpointGroupManager] Slot not found for ${endpoint}`);
      return;
    }

    const beforeRelease = slot.activeRequests;

    if (slot.activeRequests > 0) {
      slot.activeRequests--;

      this.validateSlotCounters(slot, endpoint);
    } else {
      this.logger.warn(
        `[EndpointGroupManager] Attempted to release slot with activeRequests=0 for ${endpoint}`
      );
    }

    if (success) {
      slot.successCount++;
    } else {
      slot.failureCount++;
    }

    this.logger.debug(
      `[EndpointGroupManager] Released slot for ${endpoint} ` +
      `(active: ${beforeRelease} → ${slot.activeRequests}/${slot.maxConcurrent}, ` +
      `reserved: ${slot.reservedRequests}, ` +
      `queued: ${slot.reservedForQueue})`
    );

    this.processQueueForEndpoint(endpoint);
  }

  markRateLimit(endpoint: string, retryAfter?: number): void {
    const slot = this.getEndpointSlot(endpoint);

    slot.rateLimitBackoffCount++;

    let calculatedRetryAfter: number;

    if (retryAfter) {
      calculatedRetryAfter = retryAfter;
      slot.rateLimitBaseRetryAfter = retryAfter;
    } else {
      calculatedRetryAfter = Math.min(
        slot.rateLimitBaseRetryAfter * Math.pow(1.5, slot.rateLimitBackoffCount - 1),
        300000
      );
    }

    slot.rateLimitUntil = Date.now() + calculatedRetryAfter;

    this.logger.warn(
      `[EndpointGroupManager] Rate limit marked for ${endpoint}, ` +
      `retry after ${new Date(slot.rateLimitUntil).toISOString()} ` +
      `(backoff count: ${slot.rateLimitBackoffCount}, duration: ${calculatedRetryAfter}ms)`
    );
  }

  markFailure(endpoint: string): void {
    const slot = this.getEndpointSlot(endpoint);
    slot.failureCount++;

    this.logger.warn(
      `[EndpointGroupManager] Failure marked for ${endpoint} ` +
      `(failure count: ${slot.failureCount}/5)`
    );

    if (slot.failureCount >= 5) {
      slot.circuitBreakerOpen = true;
      slot.circuitBreakerOpenUntil = Date.now() + 60000;

      this.logger.error(
        `[EndpointGroupManager] Circuit breaker opened for ${endpoint} ` +
        `(cooldown until ${new Date(slot.circuitBreakerOpenUntil).toISOString()})`
      );
    }
  }

  markSuccess(endpoint: string): void {
    const slot = this.getEndpointSlot(endpoint);
    slot.successCount++;

    if (slot.failureCount > 0) {
      slot.failureCount = Math.max(0, slot.failureCount - 1);
    }

    if (slot.rateLimitBackoffCount > 0) {
      slot.rateLimitBackoffCount = 0;
      slot.rateLimitBaseRetryAfter = 60000;
    }

    this.logger.debug(
      `[EndpointGroupManager] Success marked for ${endpoint} ` +
      `(success count: ${slot.successCount}, failure count: ${slot.failureCount})`
    );
  }

  getEndpointForProvider(providerName: string): string | null {
    return this.providerEndpoints.get(providerName) || null;
  }

  getProvidersForEndpoint(endpoint: string): string[] {
    const slot = this.endpointSlots.get(endpoint);
    return slot ? [...slot.providers] : [];
  }

  getStatus(): Record<string, any> {
    const status: Record<string, any> = {};

    for (const [endpoint, slot] of this.endpointSlots.entries()) {
      const effectiveCapacity = slot.maxConcurrent - slot.activeRequests - slot.reservedRequests - slot.reservedForQueue;

      status[endpoint] = {
        providers: slot.providers,
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

  resetCircuitBreakers(): void {
    for (const slot of this.endpointSlots.values()) {
      slot.circuitBreakerOpen = false;
      slot.circuitBreakerOpenUntil = undefined;
      slot.failureCount = 0;
    }

    this.logger.info('[EndpointGroupManager] All circuit breakers reset');
  }

  clearQueue(): void {
    for (const slot of this.endpointSlots.values()) {
      for (const request of slot.queuedRequests) {
        if (request.timeoutId) {
          clearTimeout(request.timeoutId);
        }
        request.reject(new Error('Queue cleared'));
        this.queueProcessCallbacks.delete(request.id);
      }
      slot.queuedRequests = [];
    }

    this.logger.info('[EndpointGroupManager] All queues cleared');
  }

  getConfig(): EndpointGroupConfig {
    return { ...this.config };
  }
}
