# System Architecture Audit Report
## 503 Service Unavailable Issues

**Date:** 2026-01-29
**Project:** Claude Code Router
**Version:** Post-parallel-implementation upgrade

---

## Executive Summary

The system is experiencing frequent 503 Service Unavailable errors with the message "No capacity and queue full". This audit has identified **8 critical architecture gaps** that are causing capacity exhaustion and cascading failures.

### Root Cause Analysis
The primary issue stems from **dual slot management systems** that operate independently without coordination:
1. **ModelPoolManager** manages capacity at provider+model level
2. **EndpointGroupManager** manages capacity at endpoint level
3. Both systems have separate queues, circuit breakers, and rate limiting

With 4 providers (iflow, iflowX, iflowY, iflowZ) sharing the same endpoint (`https://apis.iflow.cn/v1/chat/completions`), this creates:
- Overlapping capacity restrictions (endpoint limit + per-model limit)
- Confusing queue behavior
- Inefficient resource utilization
- Cascading failures when one system hits limits

---

## Critical Architecture Gaps

### 1. Dual Slot Management System

**Severity:** CRITICAL

**Problem:**
The system uses two independent slot management mechanisms:
- `ModelPoolManager`: Tracks capacity per `(provider, model)` pair
- `EndpointGroupManager`: Tracks capacity per `endpoint` URL

**Impact:**
```
Request Flow:
1. Check endpoint capacity (maxConcurrentPerEndpoint: 2)
2. Check provider+model capacity (maxConcurrentPerModel: 2)
3. If either fails, queue at that level
4. If both queues full → 503 error
```

**Current Configuration:**
```json
{
  "modelPool": {
    "maxConcurrentPerModel": 2
  },
  "endpointRateLimiting": {
    "maxConcurrentPerEndpoint": 2
  }
}
```

**Issue:**
With 4 providers (iflow, iflowX, iflowY, iflowZ) on the same endpoint:
- Each provider+model: 2 concurrent requests × 4 providers = 8 potential concurrent requests
- But endpoint limit: 2 concurrent requests total
- **Result:** Only 2 requests can actually be processed, but system thinks it can handle 8

**Evidence:**
- `routes.ts:146-148`: Checks endpoint capacity first
- `routes.ts:152-155`: Checks provider capacity second
- Both systems maintain separate queues
- Both systems can trigger 503 independently

**Recommendation:**
**Option A (Unified Slot Management):**
- Remove EndpointGroupManager
- Use only ModelPoolManager for all capacity tracking
- Set maxConcurrentPerModel based on endpoint limits
- Simpler, less confusing, easier to debug

**Option B (Hierarchical Slot Management):**
- Keep both systems but make them hierarchical
- EndpointGroupManager enforces global endpoint limits
- ModelPoolManager enforces per-model limits within endpoint capacity
- More complex but provides better isolation

---

### 2. Queue Processing Race Conditions

**Severity:** CRITICAL

**Problem:**
Queue processing is only triggered when slots are released, creating race conditions:

```typescript
// model-pool-manager.ts:501-519
releaseSlot(provider, model, success) {
  // Release slot
  slot.activeRequests--;

  // Process queue
  this.processQueueForSlot(key);
}
```

**Issue:**
- If a slot is reserved but never confirmed (timeout, error), queue doesn't process
- If all slots are in "reserved" state, queue grows indefinitely
- Queue processing is synchronous and can block slot release

**Evidence:**
- `model-pool-manager.ts:501-519`: Queue processing in releaseSlot
- `model-pool-manager.ts:237-272`: Reservation timeout handler
- No async queue processing
- No priority queue processing during high load

**Scenario:**
```
Time 0: 2 slots reserved (activeRequests: 0, reservedRequests: 2)
Time 1: Request comes in, no capacity, queued (queue: 1)
Time 2: Reservation timeout, both slots released (activeRequests: 0, reservedRequests: 0)
Time 3: Queue processing should trigger but might miss due to race condition
Result: Queued request hangs indefinitely
```

**Recommendation:**
- Implement async queue processing with background worker
- Add periodic queue health check (every 1 second)
- Implement queue priority processing for high-priority requests
- Add queue processing metrics and alerts

---

### 3. No Global Capacity Management

**Severity:** HIGH

**Problem:**
Each provider+model manages its own capacity without considering global system limits:

```typescript
// model-pool-manager.ts:114-118
private getOrCreateSlot(provider: string, model: string): ModelSlot {
  if (!this.slots.has(key)) {
    this.slots.set(key, {
      maxConcurrent: this.config.maxConcurrentPerModel,  // Always uses default
      ...
    });
  }
}
```

**Issue:**
- No system-wide view of total capacity
- Can't dynamically redistribute load across providers
- No awareness of endpoint-level limits when allocating slots
- Can't make intelligent routing decisions

**Evidence:**
- `model-pool-manager.ts:114-118`: Each slot created independently
- `model-pool-manager.ts:201`: Capacity calculated per-slot only
- `model-selector.ts:211-212`: Score based on individual slot capacity only

**Scenario:**
```
4 providers on same endpoint, each with 2 slots = 8 total slots
But endpoint only supports 2 concurrent requests

Request 1-2: iflow,glm-4.7 (2 slots used)
Request 3-4: iflowX,glm-4.7 (2 slots used)
Request 5-6: iflowY,glm-4.7 (2 slots used)
Request 7-8: iflowZ,glm-4.7 (2 slots used)

Result: 8 requests in flight but endpoint can only handle 2
→ High failure rate, rate limits, cascading failures
```

**Recommendation:**
- Implement global capacity manager
- Track total system capacity and usage
- Dynamic slot allocation based on endpoint limits
- Load-aware routing decisions

---

### 4. Failover Capacity Exhaustion

**Severity:** HIGH

**Problem:**
Failover happens after primary fails, but alternatives might also be at capacity:

```typescript
// routes.ts:627-632
async function handleFallback(req, reply, fastify, transformer, error, reason) {
  const alternatives = req.alternatives || [];

  // Filter out rate-limited and circuit-open alternatives
  const availableAlternatives = alternatives.filter(alt => {
    const hasCapacity = fastify.modelPoolManager.hasCapacity(alt.provider, alt.model);
    return !isRateLimited && !isCircuitOpen && hasCapacity;
  });
}
```

**Issue:**
- Failover only checked at time of error
- Alternatives might be at capacity when failover attempts
- No proactive failover capacity reservation
- Failover competes with new requests for queue space

**Evidence:**
- `routes.ts:627-632`: Failover capacity check happens after error
- `routes.ts:638-640`: No available alternatives = failover fails
- `routes.ts:643-646`: Parallel failover attempts but no capacity guarantee

**Scenario:**
```
Time 0: Primary request starts (iflow,glm-4.7)
Time 1: All alternatives at capacity (iflowX, iflowY, iflowZ)
Time 2: Primary fails (503)
Time 3: Failover attempts but no alternatives available
Time 4: Request fails completely

Result: User sees 503 even though system has capacity (just not for this specific model)
```

**Recommendation:**
- Implement failover capacity reservation
- Pre-reserve slots for failover candidates
- Implement failover priority queue
- Proactive failover capacity monitoring

---

### 5. No Dynamic Load Balancing

**Severity:** HIGH

**Problem:**
The system doesn't proactively redistribute load across providers:

```typescript
// model-selector.ts:127-165
selectModel(preferredModel, alternatives, scenarioType, requestPriority) {
  const allCandidates = this.buildCandidates(...);

  // Sort by score (static calculation)
  const sortedCandidates = availableCandidates.sort((a, b) => b.score - a.score);
  const selected = sortedCandidates[0];
}
```

**Issue:**
- Load distribution based on static configuration
- No awareness of real-time load patterns
- Can't respond to sudden load spikes
- No load shedding under extreme conditions

**Evidence:**
- `model-selector.ts:127-165`: Static score-based selection
- `model-selector.ts:211-227`: Score calculation based on current state only
- No load prediction or forecasting
- No adaptive routing based on historical data

**Scenario:**
```
Load Spike: 100 requests arrive simultaneously

Current behavior:
- 50% go to iflow (Router.default)
- 25% go to iflowX (failover)
- 25% go to iflowY (failover)
- iflowZ gets 0 requests

iflow becomes overloaded → all failover to iflowX
iflowX becomes overloaded → all failover to iflowY
iflowY becomes overloaded → all failover to iflowZ
iflowZ has no capacity → all fail

Result: Cascading failures instead of balanced load
```

**Recommendation:**
- Implement load-aware routing
- Add real-time load monitoring
- Implement adaptive routing algorithms
- Add load shedding under extreme conditions

---

### 6. Queue Priority Not Enforced

**Severity:** MEDIUM

**Problem:**
Priority levels exist but aren't effectively enforced:

```typescript
// model-pool-manager.ts:444-447
slot.queuedRequests.sort((a, b) => b.priority - a.priority);
```

**Issue:**
- Priority only affects queue order
- High-priority requests still wait for slot release
- No preemption of low-priority requests
- No priority-based slot allocation

**Evidence:**
- `model-pool-manager.ts:444-447`: Queue sorted by priority
- `model-pool-manager.ts:489`: Next request processed FIFO
- No priority-based slot reservation
- No preemption mechanism

**Scenario:**
```
Queue state:
- Request 1 (priority: 0) - 10s elapsed
- Request 2 (priority: 0) - 8s elapsed
- Request 3 (priority: 10) - 2s elapsed

Slot released:
Request 1 gets slot (FIFO) even though Request 3 has higher priority

Result: High-priority requests wait unnecessarily
```

**Recommendation:**
- Implement priority-based slot allocation
- Add preemption mechanism for high-priority requests
- Implement priority queue with aging
- Add priority metrics and monitoring

---

### 7. Circuit Breaker Recovery Issues

**Severity:** MEDIUM

**Problem:**
Circuit breakers might not recover properly:

```typescript
// model-pool-manager.ts:184-197
if (slot.circuitBreakerOpen) {
  if (slot.circuitBreakerOpenUntil && Date.now() < slot.circuitBreakerOpenUntil) {
    return false;  // Still in cooldown
  }

  if (this.config.circuitBreaker.testRequestAfterCooldown) {
    slot.circuitBreakerOpen = false;
    slot.failureCount = 0;
  } else {
    return false;  // Never recovers!
  }
}
```

**Issue:**
- Circuit breaker stays open if `testRequestAfterCooldown: false`
- Test request might fail, keeping circuit open
- No gradual recovery mechanism
- No health check integration

**Evidence:**
- `model-pool-manager.ts:184-197`: Circuit breaker logic
- `model-pool-manager.ts:649-665`: Failure marking
- No health check endpoint
- No gradual recovery (50%, 75%, 100% capacity)

**Scenario:**
```
Circuit breaker opens (5 failures)
Cooldown period: 60s
Test request: Fails (still degraded)
Circuit breaker stays open
Next test request: 60s later, still fails
Result: Circuit breaker never recovers, provider permanently unavailable
```

**Recommendation:**
- Implement gradual recovery mechanism
- Add health check endpoint
- Implement success rate monitoring for recovery
- Add circuit breaker metrics and alerts

---

### 8. Insufficient Monitoring and Alerting

**Severity:** MEDIUM

**Problem:**
Limited visibility into system health and capacity:

**Current Monitoring:**
- Request tracking per-request
- Slot status via `/model-pool/status`
- Basic logging

**Missing Monitoring:**
- No aggregate metrics (success rate, avg response time, etc.)
- No capacity trend analysis
- No queue depth monitoring
- No rate limit trend analysis
- No circuit breaker health monitoring
- No alerting for critical conditions

**Evidence:**
- `request-tracker.ts`: Per-request metrics only
- `model-pool-manager.ts:670-690`: getStatus() returns snapshot
- No metrics aggregation
- No alerting system

**Scenario:**
```
Queue depth: 80/100 (80% full)
No alert triggered
Queue depth: 95/100 (95% full)
No alert triggered
Queue depth: 100/100 (100% full)
→ 503 errors start occurring
Result: No proactive warning, reactive response only
```

**Recommendation:**
- Implement metrics aggregation
- Add trend analysis
- Implement alerting system
- Add dashboard for real-time monitoring
- Add capacity forecasting

---

## Configuration Analysis

### Current Configuration (config-fixed.json)

```json
{
  "Providers": [
    {
      "name": "iflow",
      "api_base_url": "https://apis.iflow.cn/v1/chat/completions",
      "models": ["glm-4.6", "glm-4.7", "minimax-m2.1"]
    },
    {
      "name": "iflowX",
      "api_base_url": "https://apis.iflow.cn/v1/chat/completions",
      "models": ["glm-4.6", "glm-4.7", "minimax-m2.1"]
    },
    {
      "name": "iflowY",
      "api_base_url": "https://apis.iflow.cn/v1/chat/conversations",
      "models": ["glm-4.6", "glm-4.7", "minimax-m2.1"]
    },
    {
      "name": "iflowZ",
      "api_base_url": "https://apis.iflow.cn/v1/chat/conversations",
      "models": ["glm-4.6", "glm-4.7", "minimax-m2.1"]
    }
  ],
  "Router": {
    "default": "iflow,glm-4.7"
  },
  "failover": {
    "iflow": ["iflowX", "iflowY", "iflowZ"],
    "iflowX": ["iflowY", "iflowZ", "iflow"],
    "iflowY": ["iflowZ", "iflow", "iflowX"],
    "iflowZ": ["iflow", "iflowX", "iflowY"]
  }
}
```

### Issues:

1. **4 Providers on 2 Endpoints:**
   - `iflow`, `iflowX` → `https://apis.iflow.cn/v1/chat/completions`
   - `iflowY`, `iflowZ` → `https://apis.iflow.cn/v1/chat/conversations`
   - Creates endpoint-level contention

2. **Default Capacity Limits:**
   - `maxConcurrentPerModel: 2` (default)
   - `maxConcurrentPerEndpoint: 2` (default)
   - With 4 providers, this creates artificial capacity limits

3. **No Explicit Capacity Configuration:**
   - No `modelPool` section in config
   - No `endpointRateLimiting` section in config
   - Using defaults which may not be optimal

4. **Router Configuration:**
   - `Router.default: iflow,glm-4.7` - All traffic goes to iflow
   - No load balancing across providers
   - Failover only after iflow fails

---

## Refactor Plan

### Phase 1: Immediate Fixes (1-2 days)

**Goal:** Eliminate 503 errors caused by dual slot management

#### 1.1 Unified Slot Management

**Action:**
- Remove EndpointGroupManager or make it read-only
- Use only ModelPoolManager for capacity tracking
- Adjust `maxConcurrentPerModel` based on endpoint limits

**Files to modify:**
- `packages/core/src/api/routes.ts`
- `packages/core/src/server.ts`
- `packages/core/src/services/endpoint-group-manager.ts`

**Changes:**
```typescript
// routes.ts
async function handleSinglePath(req, reply, fastify, transformer) {
  // Remove endpoint capacity check
  // const hasEndpointCapacity = fastify.endpointGroupManager.hasCapacity(endpoint);

  // Only check provider+model capacity
  const slotReserved = await reserveSlotWithRetry(...);
}
```

**Configuration:**
```json
{
  "modelPool": {
    "maxConcurrentPerModel": 10,  // Increased to handle more load
    "circuitBreaker": {
      "failureThreshold": 5,
      "cooldownPeriod": 60000,
      "testRequestAfterCooldown": true
    },
    "rateLimit": {
      "defaultRetryAfter": 60000,
      "respectRetryAfterHeader": true,
      "backoffMultiplier": 1.5,
      "maxBackoff": 300000
    },
    "queue": {
      "maxQueueSize": 500,  // Increased queue size
      "queueTimeout": 300000,
      "priorityLevels": {
        "high": 10,
        "normal": 0,
        "low": -10
      },
      "skipRateLimited": true
    },
    "priorityFailover": true
  }
}
```

#### 1.2 Fix Queue Processing

**Action:**
- Implement async queue processing
- Add periodic queue health check
- Add queue processing metrics

**Files to modify:**
- `packages/core/src/services/model-pool-manager.ts`

**Changes:**
```typescript
export class ModelPoolManager {
  private queueProcessingInterval?: NodeJS.Timeout;

  constructor(configService: ConfigService, logger: any = console) {
    // ... existing code ...

    // Start periodic queue processing
    this.startQueueProcessing();
  }

  private startQueueProcessing(): void {
    this.queueProcessingInterval = setInterval(() => {
      this.processAllQueues();
    }, 1000);  // Process all queues every second
  }

  private processAllQueues(): void {
    for (const [key, slot] of this.slots.entries()) {
      this.processQueueForSlot(key);
    }
  }

  destroy(): void {
    if (this.queueProcessingInterval) {
      clearInterval(this.queueProcessingInterval);
    }
  }
}
```

---

### Phase 2: Load Balancing (3-5 days)

**Goal:** Distribute load evenly across providers

#### 2.1 Implement Load-Aware Routing

**Action:**
- Modify ModelSelector to consider current load
- Implement weighted round-robin routing
- Add load metrics

**Files to modify:**
- `packages/core/src/services/model-selector.ts`
- `packages/core/src/utils/router.ts`

**Changes:**
```typescript
export class ModelSelector {
  selectModel(preferredModel, alternatives, scenarioType, requestPriority) {
    const allCandidates = this.buildCandidates(...);

    // Load-aware selection
    const loadAwareCandidates = allCandidates.map(candidate => {
      const status = this.modelPoolManager.getStatus();
      const key = `${candidate.provider},${candidate.model}`;
      const slotStatus = status[key];

      // Calculate load score
      const loadScore = this.calculateLoadScore(slotStatus);

      return {
        ...candidate,
        loadScore,
        combinedScore: (candidate.score * 0.7) + (loadScore * 0.3)
      };
    });

    // Select based on combined score
    const sortedCandidates = loadAwareCandidates.sort((a, b) => b.combinedScore - a.combinedScore);
    const selected = sortedCandidates[0];

    return {
      selected,
      shouldParallelExecute: this.shouldUseParallelExecution(...),
      parallelCandidates: sortedCandidates.slice(1, this.config.maxParallelAlternatives + 1),
      reason: selected.reason
    };
  }

  private calculateLoadScore(slotStatus: any): number {
    const activeRequests = slotStatus.activeRequests;
    const maxConcurrent = slotStatus.maxConcurrent;
    const queuedRequests = slotStatus.queuedRequests;

    // Lower score = less loaded
    const loadScore = 100 - ((activeRequests / maxConcurrent) * 50) - (queuedRequests * 5);
    return Math.max(0, loadScore);
  }
}
```

#### 2.2 Implement Weighted Round-Robin

**Action:**
- Add provider weights to configuration
- Implement weighted selection algorithm
- Update ModelSelector to use weights

**Configuration:**
```json
{
  "modelSelector": {
    "enableProactiveFailover": true,
    "enableHealthBasedRouting": true,
    "enablePerformanceBasedRouting": false,
    "preferHealthyModels": true,
    "maxParallelAlternatives": 3,
    "scoreWeights": {
      "capacity": 0.3,
      "health": 0.2,
      "performance": 0.2,
      "priority": 0.1,
      "load": 0.2  // New weight
    },
    "providerWeights": {
      "iflow": 1.0,
      "iflowX": 1.0,
      "iflowY": 1.0,
      "iflowZ": 1.0
    }
  }
}
```

---

### Phase 3: Failover Improvements (2-3 days)

**Goal:** Improve failover reliability and capacity guarantees

#### 3.1 Implement Failover Capacity Reservation

**Action:**
- Pre-reserve slots for failover candidates
- Implement failover priority queue
- Add failover metrics

**Files to modify:**
- `packages/core/src/services/model-pool-manager.ts`
- `packages/core/src/api/routes.ts`

**Changes:**
```typescript
export class ModelPoolManager {
  private failoverReservedSlots: Map<string, string> = new Map();

  reserveFailoverSlot(
    provider: string,
    model: string,
    requestId: string
  ): string | boolean {
    const key = `${provider},${model}`;

    // Reserve 10% of capacity for failover
    const slot = this.getOrCreateSlot(provider, model);
    const failoverCapacity = Math.max(1, Math.floor(slot.maxConcurrent * 0.1));

    const currentUsage = slot.activeRequests + slot.reservedRequests;
    const availableForFailover = failoverCapacity - (this.failoverReservedSlots.size || 0);

    if (availableForFailover > 0) {
      const reservationId = `${key}-failover-${requestId}`;
      this.failoverReservedSlots.set(reservationId, requestId);
      return reservationId;
    }

    return false;
  }

  releaseFailoverSlot(reservationId: string): void {
    this.failoverReservedSlots.delete(reservationId);
  }
}
```

#### 3.2 Improve Failover Selection

**Action:**
- Prioritize failover candidates with capacity
- Implement failover timeout
- Add failover retry logic

**Files to modify:**
- `packages/core/src/api/routes.ts`

**Changes:**
```typescript
async function handleFallback(req, reply, fastify, transformer, error, reason) {
  const alternatives = req.alternatives || [];

  // Sort by capacity and health
  const sortedAlternatives = alternatives
    .map(alt => {
      const status = fastify.modelPoolManager.getStatus();
      const key = `${alt.provider},${alt.model}`;
      const slotStatus = status[key];

      return {
        ...alt,
        hasCapacity: fastify.modelPoolManager.hasCapacity(alt.provider, alt.model),
        successRate: slotStatus?.successRate || 100,
        queuedRequests: slotStatus?.queuedRequests || 0
      };
    })
    .sort((a, b) => {
      // Priority: capacity > success rate > queue depth
      if (a.hasCapacity !== b.hasCapacity) return b.hasCapacity ? 1 : -1;
      if (a.successRate !== b.successRate) return b.successRate - a.successRate;
      return a.queuedRequests - b.queuedRequests;
    });

  // Try alternatives in order
  for (const alternative of sortedAlternatives) {
    if (!alternative.hasCapacity) continue;

    // Reserve failover slot
    const failoverReservation = fastify.modelPoolManager.reserveFailoverSlot(
      alternative.provider,
      alternative.model,
      req.requestId
    );

    if (failoverReservation) {
      try {
        const result = await tryFailoverAlternative(...);
        return result;
      } finally {
        fastify.modelPoolManager.releaseFailoverSlot(failoverReservation as string);
      }
    }
  }

  return null;
}
```

---

### Phase 4: Monitoring and Alerting (2-3 days)

**Goal:** Improve visibility and proactive issue detection

#### 4.1 Implement Metrics Aggregation

**Action:**
- Add metrics collection
- Implement metrics endpoint
- Add trend analysis

**Files to create:**
- `packages/core/src/services/metrics.ts`

**New File:**
```typescript
export class MetricsService {
  private metrics: Map<string, Metric[]> = new Map();
  private logger: any;

  constructor(logger: any = console) {
    this.logger = logger;
  }

  recordMetric(name: string, value: number, tags: Record<string, string> = {}): void {
    const metric: Metric = {
      name,
      value,
      tags,
      timestamp: Date.now()
    };

    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }

    const metrics = this.metrics.get(name)!;
    metrics.push(metric);

    // Keep last 1000 data points
    if (metrics.length > 1000) {
      metrics.shift();
    }
  }

  getMetricStats(name: string, windowMs: number = 60000): MetricStats {
    const metrics = this.metrics.get(name) || [];
    const now = Date.now();
    const windowMetrics = metrics.filter(m => now - m.timestamp < windowMs);

    if (windowMetrics.length === 0) {
      return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
    }

    const values = windowMetrics.map(m => m.value).sort((a, b) => a - b);
    const count = values.length;
    const min = values[0];
    const max = values[count - 1];
    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / count;

    return {
      count,
      min,
      max,
      avg,
      p50: values[Math.floor(count * 0.5)],
      p95: values[Math.floor(count * 0.95)],
      p99: values[Math.floor(count * 0.99)]
    };
  }
}
```

#### 4.2 Implement Alerting System

**Action:**
- Add alert rules
- Implement alert notification
- Add alert history

**Files to create:**
- `packages/core/src/services/alerting.ts`

**New File:**
```typescript
export class AlertingService {
  private alerts: Map<string, Alert> = new Map();
  private alertRules: AlertRule[] = [];
  private logger: any;

  constructor(logger: any = console) {
    this.logger = logger;
    this.loadAlertRules();
  }

  private loadAlertRules(): void {
    this.alertRules = [
      {
        name: 'queue_depth_high',
        condition: (metrics) => {
          const queueDepth = metrics.getMetricStats('queue_depth');
          return queueDepth.max > 80;  // Alert if queue depth > 80
        },
        severity: 'warning',
        message: 'Queue depth exceeding 80% capacity'
      },
      {
        name: 'success_rate_low',
        condition: (metrics) => {
          const successRate = metrics.getMetricStats('success_rate');
          return successRate.avg < 90;  // Alert if success rate < 90%
        },
        severity: 'error',
        message: 'Success rate below 90%'
      },
      {
        name: 'circuit_breaker_open',
        condition: (metrics) => {
          const circuitBreakerOpen = metrics.getMetricStats('circuit_breaker_open');
          return circuitBreakerOpen.max > 0;  // Alert if any circuit breaker open
        },
        severity: 'warning',
        message: 'Circuit breaker opened'
      }
    ];
  }

  checkAlerts(metrics: MetricsService): void {
    for (const rule of this.alertRules) {
      const shouldAlert = rule.condition(metrics);

      if (shouldAlert && !this.alerts.has(rule.name)) {
        this.triggerAlert(rule);
      }
    }
  }

  private triggerAlert(rule: AlertRule): void {
    const alert: Alert = {
      name: rule.name,
      severity: rule.severity,
      message: rule.message,
      timestamp: Date.now()
    };

    this.alerts.set(rule.name, alert);

    this.logger.error(`[Alert] ${rule.severity.toUpperCase()}: ${rule.message}`);

    // Send notification (email, Slack, etc.)
    // TODO: Implement notification channels
  }
}
```

#### 4.3 Add Monitoring Endpoints

**Action:**
- Add `/metrics` endpoint
- Add `/alerts` endpoint
- Add `/health` endpoint

**Files to modify:**
- `packages/core/src/api/routes.ts`

**Changes:**
```typescript
async function registerApiRoutes(fastify: FastifyInstance) {
  // ... existing routes ...

  // Metrics endpoint
  fastify.get('/metrics', async (request, reply) => {
    const metrics = fastify.metricsService.getAllMetrics();
    return { metrics };
  });

  // Alerts endpoint
  fastify.get('/alerts', async (request, reply) => {
    const alerts = fastify.alertingService.getActiveAlerts();
    return { alerts };
  });

  // Health endpoint
  fastify.get('/health', async (request, reply) => {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      checks: {
        modelPool: fastify.modelPoolManager.getHealth(),
        endpointGroup: fastify.endpointGroupManager.getHealth(),
        requestTracker: fastify.requestTracker.getHealth()
      }
    };

    // Check if any health check failed
    const hasFailures = Object.values(health.checks).some(check => check.status !== 'healthy');
    if (hasFailures) {
      health.status = 'unhealthy';
      reply.code(503);
    }

    return health;
  });
}
```

---

### Phase 5: Testing and Validation (2-3 days)

**Goal:** Ensure all changes work correctly

#### 5.1 Unit Tests

**Action:**
- Add unit tests for new features
- Add integration tests
- Add load tests

**Files to create:**
- `packages/core/src/services/__tests__/metrics.test.ts`
- `packages/core/src/services/__tests__/alerting.test.ts`
- `packages/core/src/services/__tests__/load-balancer.test.ts`

#### 5.2 Load Testing

**Action:**
- Run load tests with various scenarios
- Validate capacity limits
- Validate failover behavior
- Validate queue processing

**Scenarios:**
1. Normal load (50 concurrent requests)
2. High load (200 concurrent requests)
3. Spike load (500 requests in 10 seconds)
4. Failover scenario (primary fails, alternatives available)
5. No capacity scenario (all providers at capacity)

#### 5.3 Performance Testing

**Action:**
- Measure response times
- Measure queue wait times
- Measure failover times
- Validate no performance regression

**Metrics:**
- Average response time < 5s
- P95 response time < 10s
- P99 response time < 20s
- Queue wait time < 30s
- Failover time < 3s

---

## Estimated Timeline

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| Phase 1: Immediate Fixes | 1-2 days | None |
| Phase 2: Load Balancing | 3-5 days | Phase 1 |
| Phase 3: Failover Improvements | 2-3 days | Phase 1, Phase 2 |
| Phase 4: Monitoring and Alerting | 2-3 days | Phase 1, Phase 2, Phase 3 |
| Phase 5: Testing and Validation | 2-3 days | All previous phases |
| **Total** | **10-16 days** | |

---

## Success Criteria

### Primary Goals
- ✅ Eliminate 503 "No capacity and queue full" errors under normal load
- ✅ Achieve 95%+ success rate under normal load
- ✅ Maintain < 5s average response time under normal load
- ✅ Queue wait time < 30s for 95% of requests

### Secondary Goals
- ✅ Implement unified slot management
- ✅ Implement load-aware routing
- ✅ Implement failover capacity reservation
- ✅ Implement comprehensive monitoring and alerting
- ✅ Add health check endpoint
- ✅ Add metrics endpoint
- ✅ Add alerts endpoint

---

## Risk Assessment

### High Risk
- **Unified slot management**: May require significant refactoring
- **Load balancing**: May affect existing routing behavior
- **Failover improvements**: May introduce new edge cases

### Medium Risk
- **Queue processing**: May require careful testing to avoid race conditions
- **Monitoring and alerting**: May require additional infrastructure

### Low Risk
- **Testing and validation**: No production impact

### Mitigation Strategies
1. **Gradual rollout**: Deploy changes in phases with thorough testing
2. **Feature flags**: Use feature flags to enable/disable new features
3. **Monitoring**: Monitor metrics closely after each deployment
4. **Rollback plan**: Have rollback plan ready for each phase

---

## Next Steps

1. **Review and approve** this audit report and refactor plan
2. **Prioritize phases** based on business impact and resource availability
3. **Set up staging environment** for testing
4. **Begin Phase 1** implementation
5. **Monitor progress** and adjust plan as needed

---

## Appendix

### A. Configuration Template

```json
{
  "Providers": [
    {
      "name": "iflow",
      "api_base_url": "https://apis.iflow.cn/v1/chat/completions",
      "api_key": "your-api-key",
      "models": ["glm-4.6", "glm-4.7", "minimax-m2.1"],
      "headers": {
        "User-Agent": "iFlow-Cli",
        "X-Client-Type": "iflow-cli",
        "X-Client-Version": "0.3.26"
      }
    }
  ],
  "Router": {
    "default": "iflow,glm-4.7",
    "background": "iflow,glm-4.6",
    "think": "iflow,glm-4.7",
    "longContext": "iflow,glm-4.7",
    "longContextThreshold": 60000,
    "webSearch": "iflow,glm-4.7"
  },
  "failover": {
    "iflow": ["iflowX", "iflowY", "iflowZ"],
    "global": ["iflowX", "iflowY", "iflowZ"]
  },
  "modelPool": {
    "maxConcurrentPerModel": 10,
    "circuitBreaker": {
      "failureThreshold": 5,
      "cooldownPeriod": 60000,
      "testRequestAfterCooldown": true
    },
    "rateLimit": {
      "defaultRetryAfter": 60000,
      "respectRetryAfterHeader": true,
      "backoffMultiplier": 1.5,
      "maxBackoff": 300000
    },
    "queue": {
      "maxQueueSize": 500,
      "queueTimeout": 300000,
      "priorityLevels": {
        "high": 10,
        "normal": 0,
        "low": -10
      },
      "skipRateLimited": true
    },
    "priorityFailover": true
  },
  "modelSelector": {
    "enableProactiveFailover": true,
    "enableHealthBasedRouting": true,
    "enablePerformanceBasedRouting": false,
    "preferHealthyModels": true,
    "maxParallelAlternatives": 3,
    "scoreWeights": {
      "capacity": 0.3,
      "health": 0.2,
      "performance": 0.2,
      "priority": 0.1,
      "load": 0.2
    },
    "providerWeights": {
      "iflow": 1.0,
      "iflowX": 1.0,
      "iflowY": 1.0,
      "iflowZ": 1.0
    }
  },
  "alerting": {
    "enabled": true,
    "rules": [
      {
        "name": "queue_depth_high",
        "threshold": 80,
        "severity": "warning"
      },
      {
        "name": "success_rate_low",
        "threshold": 90,
        "severity": "error"
      },
      {
        "name": "circuit_breaker_open",
        "severity": "warning"
      }
    ]
  }
}
```

### B. Monitoring Dashboard Metrics

**Real-time Metrics:**
- Request rate (requests/second)
- Success rate (%)
- Error rate (%)
- Average response time (ms)
- P95 response time (ms)
- P99 response time (ms)
- Queue depth (requests)
- Average queue wait time (ms)
- Active requests (count)
- Circuit breakers open (count)
- Rate-limited endpoints (count)

**Historical Metrics:**
- Request rate trend (last hour, 24 hours, 7 days)
- Success rate trend (last hour, 24 hours, 7 days)
- Response time trend (last hour, 24 hours, 7 days)
- Queue depth trend (last hour, 24 hours, 7 days)

**Per-Provider Metrics:**
- Request count per provider
- Success rate per provider
- Average response time per provider
- Active requests per provider
- Queue depth per provider

**Per-Model Metrics:**
- Request count per model
- Success rate per model
- Average response time per model
- Active requests per model
- Queue depth per model

---

## Conclusion

This audit has identified 8 critical architecture gaps that are causing 503 Service Unavailable errors. The refactor plan provides a structured approach to addressing these issues in 5 phases over 10-16 days.

The primary issue is the dual slot management system that creates artificial capacity limits and confusing queue behavior. By unifying slot management and implementing load-aware routing, we can eliminate most 503 errors.

Secondary improvements to failover, monitoring, and alerting will provide better reliability and visibility into system health.

We recommend proceeding with Phase 1 immediately to address the most critical issues, then iterating through the remaining phases based on available resources and business priorities.