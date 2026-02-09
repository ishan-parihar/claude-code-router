import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ModelPoolManager } from '../model-pool-manager';
import { ConfigService } from '../config';

// Mock ConfigService
const mockConfigService = {
  get: vi.fn(),
} as unknown as ConfigService;

describe('ModelPoolManager', () => {
  let manager: ModelPoolManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Set up default configuration
    (mockConfigService.get as any).mockReturnValue({
      maxConcurrentPerModel: 2,
      circuitBreaker: {
        failureThreshold: 5,
        cooldownPeriod: 60000,
        testRequestAfterCooldown: true,
      },
      rateLimit: {
        defaultRetryAfter: 60000,
        respectRetryAfterHeader: true,
        backoffMultiplier: 1.5,
        maxBackoff: 300000,
      },
      queue: {
        maxQueueSize: 100,
        queueTimeout: 300000,
        priorityLevels: {
          high: 10,
          normal: 0,
          low: -10,
        },
        skipRateLimited: true,
      },
      priorityFailover: true,
    });
    manager = new ModelPoolManager(mockConfigService, console);
  });

  afterEach(() => {
    // Clean up any pending timeouts
    vi.clearAllTimers();
  });

  describe('Slot Management', () => {
    it('should create a new slot when first accessing a model', () => {
      const hasCapacity = manager.hasCapacity('provider1', 'model1');
      expect(hasCapacity).toBe(true);

      const status = manager.getStatus();
      expect(status['provider1,model1']).toBeDefined();
      expect(status['provider1,model1'].activeRequests).toBe(0);
      expect(status['provider1,model1'].maxConcurrent).toBe(2);
    });

    it('should acquire slot when capacity is available', async () => {
      const acquired = await manager.acquireSlot('provider1', 'model1', 0);
      expect(acquired).toBe(true);

      const status = manager.getStatus();
      expect(status['provider1,model1'].activeRequests).toBe(1);
    });

    it('should not acquire slot when at capacity', async () => {
      // Acquire first slot
      await manager.acquireSlot('provider1', 'model1', 0);
      // Acquire second slot
      await manager.acquireSlot('provider1', 'model1', 0);
      // Try to acquire third slot (should fail)
      const acquired = await manager.acquireSlot('provider1', 'model1', 0);
      expect(acquired).toBe(false);

      const status = manager.getStatus();
      expect(status['provider1,model1'].activeRequests).toBe(2);
    });

    it('should release slot and update counters', () => {
      manager.acquireSlot('provider1', 'model1', 0);
      manager.releaseSlot('provider1', 'model1', true);

      const status = manager.getStatus();
      expect(status['provider1,model1'].activeRequests).toBe(0);
      expect(status['provider1,model1'].successCount).toBe(1);
    });

    it('should handle multiple provider+model combinations independently', async () => {
      await manager.acquireSlot('provider1', 'model1', 0);
      await manager.acquireSlot('provider1', 'model1', 0);
      await manager.acquireSlot('provider2', 'model1', 0);

      const status = manager.getStatus();
      expect(status['provider1,model1'].activeRequests).toBe(2);
      expect(status['provider2,model1'].activeRequests).toBe(1);
    });
  });

  describe('Request Queuing', () => {
    it('should queue request when at capacity', async () => {
      // Fill capacity
      await manager.acquireSlot('provider1', 'model1', 0);
      await manager.acquireSlot('provider1', 'model1', 0);

      // Enqueue a request
      const queuePromise = manager.enqueueRequest(
        'provider1',
        'model1',
        {},
        {},
        {},
        0
      );

      // Check queue status
      const queueStatus = manager.getQueueStatus();
      expect(queueStatus['provider1,model1']).toBeDefined();
      expect(queueStatus['provider1,model1'].queueLength).toBe(1);

      // Release a slot
      manager.releaseSlot('provider1', 'model1', true);

      // Wait for queued request to be processed
      await queuePromise;

      const status = manager.getStatus();
      expect(status['provider1,model1'].activeRequests).toBe(1);
    });

    it('should respect priority in queue ordering', async () => {
      // Fill capacity
      await manager.acquireSlot('provider1', 'model1', 0);
      await manager.acquireSlot('provider1', 'model1', 0);

      // Enqueue requests with different priorities
      const lowPriorityPromise = manager.enqueueRequest(
        'provider1',
        'model1',
        {},
        {},
        {},
        -10
      );

      const highPriorityPromise = manager.enqueueRequest(
        'provider1',
        'model1',
        {},
        {},
        {},
        10
      );

      const normalPriorityPromise = manager.enqueueRequest(
        'provider1',
        'model1',
        {},
        {},
        {},
        0
      );

      const queueStatus = manager.getQueueStatus();
      expect(queueStatus['provider1,model1'].queueLength).toBe(3);

      // Release slots one by one
      manager.releaseSlot('provider1', 'model1', true);
      await highPriorityPromise;

      manager.releaseSlot('provider1', 'model1', true);
      await normalPriorityPromise;

      manager.releaseSlot('provider1', 'model1', true);
      await lowPriorityPromise;
    });

    it('should timeout queued requests', async () => {
      vi.useFakeTimers();

      // Fill capacity
      await manager.acquireSlot('provider1', 'model1', 0);
      await manager.acquireSlot('provider1', 'model1', 0);

      // Enqueue a request
      const queuePromise = manager.enqueueRequest(
        'provider1',
        'model1',
        {},
        {},
        {},
        0
      );

      // Fast-forward past timeout
      vi.advanceTimersByTime(300001);

      await expect(queuePromise).rejects.toThrow('Request timeout');

      vi.useRealTimers();
    });

    it('should reject new requests when queue is full', async () => {
      // Set small queue size
      (mockConfigService.get as any).mockReturnValue({
        maxConcurrentPerModel: 2,
        circuitBreaker: { failureThreshold: 5, cooldownPeriod: 60000, testRequestAfterCooldown: true },
        rateLimit: { defaultRetryAfter: 60000, respectRetryAfterHeader: true },
        queue: { maxQueueSize: 2, queueTimeout: 300000, priorityLevels: { high: 10, normal: 0, low: -10 } },
      });
      manager = new ModelPoolManager(mockConfigService, console);

      // Fill capacity
      await manager.acquireSlot('provider1', 'model1', 0);
      await manager.acquireSlot('provider1', 'model1', 0);

      // Fill queue
      manager.enqueueRequest('provider1', 'model1', {}, {}, {}, 0);
      manager.enqueueRequest('provider1', 'model1', {}, {}, {}, 0);

      // Try to enqueue one more (should fail)
      await expect(
        manager.enqueueRequest('provider1', 'model1', {}, {}, {}, 0)
      ).rejects.toThrow('Queue full');
    });
  });

  describe('Circuit Breaker', () => {
    it('should open circuit breaker after failure threshold', () => {
      // Mark failures
      for (let i = 0; i < 5; i++) {
        manager.markFailure('provider1', 'model1');
      }

      const status = manager.getStatus();
      expect(status['provider1,model1'].circuitBreakerOpen).toBe(true);
      expect(status['provider1,model1'].failureCount).toBe(5);
    });

    it('should not allow requests when circuit breaker is open', () => {
      // Open circuit breaker
      for (let i = 0; i < 5; i++) {
        manager.markFailure('provider1', 'model1');
      }

      const hasCapacity = manager.hasCapacity('provider1', 'model1');
      expect(hasCapacity).toBe(false);
    });

    it('should close circuit breaker after cooldown', () => {
      vi.useFakeTimers();

      // Open circuit breaker
      for (let i = 0; i < 5; i++) {
        manager.markFailure('provider1', 'model1');
      }

      // Fast-forward past cooldown
      vi.advanceTimersByTime(60001);

      // Check capacity (should allow test request)
      const hasCapacity = manager.hasCapacity('provider1', 'model1');
      expect(hasCapacity).toBe(true);

      vi.useRealTimers();
    });

    it('should reset circuit breaker when reset is called', () => {
      // Open circuit breaker
      for (let i = 0; i < 5; i++) {
        manager.markFailure('provider1', 'model1');
      }

      manager.resetCircuitBreakers();

      const status = manager.getStatus();
      expect(status['provider1,model1'].circuitBreakerOpen).toBe(false);
      expect(status['provider1,model1'].failureCount).toBe(0);
    });

    it('should reduce failure count on success', () => {
      // Mark failures
      for (let i = 0; i < 4; i++) {
        manager.markFailure('provider1', 'model1');
      }

      // Mark success
      manager.markSuccess('provider1', 'model1');

      const status = manager.getStatus();
      expect(status['provider1,model1'].failureCount).toBe(3);
    });
  });

  describe('Rate Limit Tracking', () => {
    it('should mark provider as rate-limited', () => {
      const retryAfter = Date.now() + 60000;
      manager.markRateLimit('provider1', 'model1', retryAfter);

      const status = manager.getStatus();
      expect(status['provider1,model1'].rateLimitUntil).toBeDefined();
    });

    it('should not allow requests when rate-limited', () => {
      const retryAfter = Date.now() + 60000;
      manager.markRateLimit('provider1', 'model1', retryAfter);

      const hasCapacity = manager.hasCapacity('provider1', 'model1');
      expect(hasCapacity).toBe(false);
    });

    it('should allow requests after rate limit expires', () => {
      vi.useFakeTimers();

      const retryAfter = Date.now() + 60000;
      manager.markRateLimit('provider1', 'model1', retryAfter);

      // Fast-forward past retry after
      vi.advanceTimersByTime(60001);

      const hasCapacity = manager.hasCapacity('provider1', 'model1');
      expect(hasCapacity).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('Alternative Model Selection', () => {
    it('should return preferred model if available', () => {
      const alternatives = [
        { provider: 'provider2', model: 'model1' },
        { provider: 'provider3', model: 'model1' },
      ];

      const available = manager.getAvailableModel('provider1,model1', alternatives);
      expect(available).toBe('provider1,model1');
    });

    it('should return first available alternative if preferred is at capacity', async () => {
      // Fill capacity for preferred model
      await manager.acquireSlot('provider1', 'model1', 0);
      await manager.acquireSlot('provider1', 'model1', 0);

      const alternatives = [
        { provider: 'provider2', model: 'model1' },
        { provider: 'provider3', model: 'model1' },
      ];

      const available = manager.getAvailableModel('provider1,model1', alternatives);
      expect(available).toBe('provider2,model1');
    });

    it('should return null if all models are at capacity', async () => {
      // Fill capacity for all models
      await manager.acquireSlot('provider1', 'model1', 0);
      await manager.acquireSlot('provider1', 'model1', 0);
      await manager.acquireSlot('provider2', 'model1', 0);
      await manager.acquireSlot('provider2', 'model1', 0);
      await manager.acquireSlot('provider3', 'model1', 0);
      await manager.acquireSlot('provider3', 'model1', 0);

      const alternatives = [
        { provider: 'provider2', model: 'model1' },
        { provider: 'provider3', model: 'model1' },
      ];

      const available = manager.getAvailableModel('provider1,model1', alternatives);
      expect(available).toBe(null);
    });
  });

  describe('Status and Monitoring', () => {
    it('should return status for all models', async () => {
      await manager.acquireSlot('provider1', 'model1', 0);
      await manager.acquireSlot('provider2', 'model1', 0);

      const status = manager.getStatus();
      expect(Object.keys(status)).toHaveLength(2);
      expect(status['provider1,model1']).toBeDefined();
      expect(status['provider2,model1']).toBeDefined();
    });

    it('should calculate success rate correctly', () => {
      manager.markSuccess('provider1', 'model1');
      manager.markSuccess('provider1', 'model1');
      manager.markFailure('provider1', 'model1');

      const status = manager.getStatus();
      expect(status['provider1,model1'].successRate).toBe(66.67);
    });

    it('should return queue status for models with queued requests', async () => {
      // Fill capacity
      await manager.acquireSlot('provider1', 'model1', 0);
      await manager.acquireSlot('provider1', 'model1', 0);

      // Enqueue request
      manager.enqueueRequest('provider1', 'model1', {}, {}, {}, 0);

      const queueStatus = manager.getQueueStatus();
      expect(queueStatus['provider1,model1']).toBeDefined();
      expect(queueStatus['provider1,model1'].queueLength).toBe(1);
    });

    it('should return configuration', () => {
      const config = manager.getConfig();
      expect(config.maxConcurrentPerModel).toBe(2);
      expect(config.circuitBreaker.failureThreshold).toBe(5);
      expect(config.queue.maxQueueSize).toBe(100);
    });
  });

  describe('Queue Management', () => {
    it('should clear all queued requests', async () => {
      // Fill capacity
      await manager.acquireSlot('provider1', 'model1', 0);
      await manager.acquireSlot('provider1', 'model1', 0);

      // Enqueue requests
      const queuePromise = manager.enqueueRequest('provider1', 'model1', {}, {}, {}, 0);

      // Clear queue
      manager.clearQueue();

      // Queue should be empty
      const queueStatus = manager.getQueueStatus();
      expect(queueStatus['provider1,model1']).toBeUndefined();

      // Queued request should be rejected
      await expect(queuePromise).rejects.toThrow('Queue cleared');
    });
  });

  describe('Slot Reservation', () => {
    it('should reserve a slot when capacity is available', () => {
      const reserved = manager.reserveSlot('provider1', 'model1');
      expect(reserved).toBe(true);

      const status = manager.getStatus();
      expect(status['provider1,model1'].reservedRequests).toBe(1);
    });

    it('should not reserve a slot when at capacity', async () => {
      // Fill capacity
      await manager.acquireSlot('provider1', 'model1', 0);
      await manager.acquireSlot('provider1', 'model1', 0);

      // Try to reserve
      const reserved = manager.reserveSlot('provider1', 'model1');
      expect(reserved).toBe(false);

      const status = manager.getStatus();
      expect(status['provider1,model1'].reservedRequests).toBe(0);
    });

    it('should confirm a reserved slot', () => {
      manager.reserveSlot('provider1', 'model1');
      manager.confirmSlot('provider1', 'model1');

      const status = manager.getStatus();
      expect(status['provider1,model1'].reservedRequests).toBe(0);
      expect(status['provider1,model1'].activeRequests).toBe(1);
    });

    it('should release a reservation', () => {
      manager.reserveSlot('provider1', 'model1');
      manager.releaseReservation('provider1', 'model1');

      const status = manager.getStatus();
      expect(status['provider1,model1'].reservedRequests).toBe(0);
      expect(status['provider1,model1'].activeRequests).toBe(0);
    });
  });

  describe('Rate Limit Check', () => {
    it('should return true when rate-limited', () => {
      const retryAfter = Date.now() + 60000;
      manager.markRateLimit('provider1', 'model1', retryAfter);

      const isLimited = manager.isRateLimited('provider1', 'model1');
      expect(isLimited).toBe(true);
    });

    it('should return false when not rate-limited', () => {
      const isLimited = manager.isRateLimited('provider1', 'model1');
      expect(isLimited).toBe(false);
    });

    it('should return false after rate limit expires', () => {
      vi.useFakeTimers();

      const retryAfter = Date.now() + 60000;
      manager.markRateLimit('provider1', 'model1', retryAfter);

      // Fast-forward past retry after
      vi.advanceTimersByTime(60001);

      const isLimited = manager.isRateLimited('provider1', 'model1');
      expect(isLimited).toBe(false);

      vi.useRealTimers();
    });
  });

  describe('Circuit Breaker Check', () => {
    it('should return true when circuit breaker is open', () => {
      // Open circuit breaker
      for (let i = 0; i < 5; i++) {
        manager.markFailure('provider1', 'model1');
      }

      const isOpen = manager.isCircuitBreakerOpen('provider1', 'model1');
      expect(isOpen).toBe(true);
    });

    it('should return false when circuit breaker is closed', () => {
      const isOpen = manager.isCircuitBreakerOpen('provider1', 'model1');
      expect(isOpen).toBe(false);
    });

    it('should return false after cooldown period', () => {
      vi.useFakeTimers();

      // Open circuit breaker
      for (let i = 0; i < 5; i++) {
        manager.markFailure('provider1', 'model1');
      }

      // Fast-forward past cooldown
      vi.advanceTimersByTime(60001);

      const isOpen = manager.isCircuitBreakerOpen('provider1', 'model1');
      expect(isOpen).toBe(false);

      vi.useRealTimers();
    });
  });

  describe('Exponential Backoff for Rate Limits', () => {
    it('should increase backoff count on each rate limit', () => {
      manager.markRateLimit('provider1', 'model1');
      manager.markRateLimit('provider1', 'model1');
      manager.markRateLimit('provider1', 'model1');

      const status = manager.getStatus();
      expect(status['provider1,model1'].rateLimitBackoffCount).toBe(3);
    });

    it('should reset backoff count on success', () => {
      manager.markRateLimit('provider1', 'model1');
      manager.markRateLimit('provider1', 'model1');
      manager.markSuccess('provider1', 'model1');

      const status = manager.getStatus();
      expect(status['provider1,model1'].rateLimitBackoffCount).toBe(0);
    });

    it('should apply exponential backoff for retry duration', () => {
      vi.useFakeTimers();

      manager.markRateLimit('provider1', 'model1');
      const firstStatus = manager.getStatus();
      const firstRetryAfter = firstStatus['provider1,model1'].rateLimitUntil;

      manager.markRateLimit('provider1', 'model1');
      const secondStatus = manager.getStatus();
      const secondRetryAfter = secondStatus['provider1,model1'].rateLimitUntil;

      // Second retry should be longer (exponential backoff)
      expect(secondRetryAfter).toBeGreaterThan(firstRetryAfter!);

      vi.useRealTimers();
    });

    it('should cap backoff at maxBackoff', () => {
      // Mark rate limits multiple times to exceed max backoff
      for (let i = 0; i < 20; i++) {
        manager.markRateLimit('provider1', 'model1');
      }

      const status = manager.getStatus();
      const retryAfter = status['provider1,model1'].rateLimitUntil;
      const expectedMax = Date.now() + 300000; // maxBackoff is 300000ms

      // Should not exceed max backoff
      expect(retryAfter).toBeLessThanOrEqual(expectedMax);
    });
  });

  describe('Available Alternatives', () => {
    it('should return all available alternatives', () => {
      const alternatives = [
        { provider: 'provider1', model: 'model1' },
        { provider: 'provider2', model: 'model1' },
        { provider: 'provider3', model: 'model1' },
      ];

      const available = manager.getAvailableAlternatives(alternatives);
      expect(available).toHaveLength(3);
    });

    it('should filter out rate-limited alternatives', () => {
      // Mark provider2 as rate-limited
      manager.markRateLimit('provider2', 'model1');

      const alternatives = [
        { provider: 'provider1', model: 'model1' },
        { provider: 'provider2', model: 'model1' },
        { provider: 'provider3', model: 'model1' },
      ];

      const available = manager.getAvailableAlternatives(alternatives);
      expect(available).toHaveLength(2);
      expect(available.find(a => a.provider === 'provider2')).toBeUndefined();
    });

    it('should filter out circuit-open alternatives', () => {
      // Open circuit breaker for provider2
      for (let i = 0; i < 5; i++) {
        manager.markFailure('provider2', 'model1');
      }

      const alternatives = [
        { provider: 'provider1', model: 'model1' },
        { provider: 'provider2', model: 'model1' },
        { provider: 'provider3', model: 'model1' },
      ];

      const available = manager.getAvailableAlternatives(alternatives);
      expect(available).toHaveLength(2);
      expect(available.find(a => a.provider === 'provider2')).toBeUndefined();
    });

    it('should filter out at-capacity alternatives', async () => {
      // Fill capacity for provider2
      await manager.acquireSlot('provider2', 'model1', 0);
      await manager.acquireSlot('provider2', 'model1', 0);

      const alternatives = [
        { provider: 'provider1', model: 'model1' },
        { provider: 'provider2', model: 'model1' },
        { provider: 'provider3', model: 'model1' },
      ];

      const available = manager.getAvailableAlternatives(alternatives);
      expect(available).toHaveLength(2);
      expect(available.find(a => a.provider === 'provider2')).toBeUndefined();
    });
  });
});