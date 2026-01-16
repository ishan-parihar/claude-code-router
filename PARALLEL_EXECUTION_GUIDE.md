# Parallel Execution and Intelligent Failover Guide

## Overview

Claude Code Router (CCR) now supports intelligent parallel execution with automatic failover for multiple `ccr code` instances. This feature enables:

- **Multiple concurrent `ccr code` instances** running simultaneously
- **Intelligent model sharing** across instances (2 concurrent requests per provider+model)
- **Automatic failover** when models are at capacity or encounter errors
- **Request queuing** with priority support
- **Circuit breaker pattern** for failing providers
- **Rate limit tracking** to avoid hitting provider limits repeatedly

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Multiple ccr code Instances               │
│  (Instance 1)  (Instance 2)  (Instance 3)  (Instance 4)     │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    CCR Server (Single Instance)              │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐   │
│  │         Model Pool Manager                           │   │
│  │  - Tracks active requests per provider+model         │   │
│  │  - Enforces 2 concurrent request limit              │   │
│  │  - Manages request queue with priority              │   │
│  │  - Circuit breaker for rate-limited providers       │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                  │
│                           ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │         Intelligent Router                          │   │
│  │  - Checks model capacity before routing             │   │
│  │  - Routes to failover models if at capacity         │   │
│  │  - Handles priority-based allocation                │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                  │
│                           ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │         Failover System                             │   │
│  │  - Triggers on capacity OR errors                   │   │
│  │  - Tracks rate limit headers                        │   │
│  │  - Parallel execution of alternatives               │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Configuration

### Model Pool Configuration

Add the `modelPool` section to your `config.json`:

```json
{
  "modelPool": {
    "maxConcurrentPerModel": 2,
    "circuitBreaker": {
      "failureThreshold": 5,
      "cooldownPeriod": 60000,
      "testRequestAfterCooldown": true
    },
    "rateLimit": {
      "defaultRetryAfter": 60000,
      "respectRetryAfterHeader": true
    },
    "queue": {
      "maxQueueSize": 100,
      "queueTimeout": 300000,
      "priorityLevels": {
        "high": 10,
        "normal": 0,
        "low": -10
      }
    }
  }
}
```

### Configuration Options

#### `maxConcurrentPerModel`
- **Type**: `number`
- **Default**: `2`
- **Description**: Maximum number of concurrent requests per provider+model combination

#### `circuitBreaker.failureThreshold`
- **Type**: `number`
- **Default**: `5`
- **Description**: Number of consecutive failures before opening circuit breaker

#### `circuitBreaker.cooldownPeriod`
- **Type**: `number` (milliseconds)
- **Default**: `60000` (60 seconds)
- **Description**: How long to keep circuit breaker open after threshold is reached

#### `circuitBreaker.testRequestAfterCooldown`
- **Type**: `boolean`
- **Default**: `true`
- **Description**: Whether to allow one test request after cooldown period to check if provider recovered

#### `rateLimit.defaultRetryAfter`
- **Type**: `number` (milliseconds)
- **Default**: `60000` (60 seconds)
- **Description**: Default retry time when rate limit is detected without Retry-After header

#### `rateLimit.respectRetryAfterHeader`
- **Type**: `boolean`
- **Default**: `true`
- **Description**: Whether to respect the Retry-After header from provider responses

#### `queue.maxQueueSize`
- **Type**: `number`
- **Default**: `100`
- **Description**: Maximum number of requests to queue per model

#### `queue.queueTimeout`
- **Type**: `number` (milliseconds)
- **Default**: `300000` (5 minutes)
- **Description**: How long to keep queued requests before timing out

#### `queue.priorityLevels`
- **Type**: `object`
- **Description**: Priority values for different priority levels
  - `high`: Priority value for high-priority requests (default: 10)
  - `normal`: Priority value for normal-priority requests (default: 0)
  - `low`: Priority value for low-priority requests (default: -10)

## Failover Configuration

The failover system now supports both capacity-based and error-based failover:

```json
{
  "failover": {
    "iflow": [
      "iflow-backup",
      { "provider": "openai", "model": "gpt-4" },
      { "provider": "anthropic", "model": "claude-3-opus" }
    ],
    "global": ["iflow-backup"]
  }
}
```

### Failover Triggers

Failover is triggered when:

1. **Capacity-based**: A model reaches its concurrent request limit (2 by default)
2. **Error-based**: A request fails with:
   - HTTP 429 (Rate limit)
   - HTTP 502 (Bad gateway)
   - HTTP 503 (Service unavailable)
   - Any provider response error

### Parallel Failover

When failover is triggered, the system tries multiple alternatives **in parallel** and uses the first successful response. This significantly reduces latency compared to sequential retry.

## API Endpoints

### Model Pool Monitoring

#### Get Model Pool Status
```http
GET /api/model-pool/status
```

Returns status of all model slots:

```json
{
  "iflow,glm-4.7": {
    "activeRequests": 1,
    "maxConcurrent": 2,
    "queuedRequests": 3,
    "circuitBreakerOpen": false,
    "circuitBreakerOpenUntil": null,
    "rateLimitUntil": null,
    "failureCount": 2,
    "successCount": 98,
    "successRate": 98.0,
    "lastUsed": "2026-01-12T10:30:45.123Z"
  }
}
```

#### Get Queue Status
```http
GET /api/model-pool/queue
```

Returns queue status for models with queued requests:

```json
{
  "iflow,glm-4.7": {
    "queueLength": 3,
    "oldestRequestTimestamp": 1705057845123,
    "oldestRequestAge": 15000,
    "priorityRange": {
      "min": 0,
      "max": 10
    }
  }
}
```

#### Get Model Pool Configuration
```http
GET /api/model-pool/config
```

Returns current model pool configuration.

#### Reset Circuit Breakers
```http
POST /api/model-pool/reset-circuit-breakers
```

Resets all circuit breakers, allowing requests to flow again.

#### Clear Queue
```http
POST /api/model-pool/clear-queue
```

Clears all queued requests (rejected with error).

## Usage

### Multiple ccr code Instances

You can now run multiple `ccr code` instances simultaneously:

```bash
# Terminal 1
ccr code

# Terminal 2
ccr code

# Terminal 3
ccr code
```

Each instance will intelligently share the model pool, with each provider+model combination handling up to 2 concurrent requests.

### Request Priority

Set request priority using the UI or by sending the `X-CCR-Priority` header:

```javascript
const response = await fetch('http://localhost:3456/v1/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-CCR-Priority': '10'  // High priority
  },
  body: JSON.stringify({
    model: 'iflow,glm-4.7',
    messages: [{ role: 'user', content: 'Hello' }]
  })
});
```

Priority values:
- **High**: 10
- **Normal**: 0
- **Low**: -10

### Monitoring Model Pool Status

Use the UI to monitor model pool status in real-time:

1. Navigate to the Model Pool Status page
2. View active requests per model
3. Monitor queue length and wait times
4. Check circuit breaker status
5. See rate limit status
6. Reset circuit breakers if needed

## Circuit Breaker Pattern

The circuit breaker pattern prevents cascading failures by temporarily disabling providers that are experiencing issues.

### How It Works

1. **Normal State**: Requests flow normally to the provider
2. **Failure Detection**: Each failed request increments the failure counter
3. **Circuit Opens**: After `failureThreshold` consecutive failures, circuit opens
4. **Cooldown Period**: Requests are blocked for `cooldownPeriod`
5. **Test Request**: After cooldown, one request is allowed to test recovery
6. **Circuit Closes**: If test succeeds, circuit closes and normal flow resumes

### Example

```javascript
// 5 consecutive failures occur
// Circuit breaker opens

try {
  await fetch('http://localhost:3456/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'failing-provider,model',
      messages: [{ role: 'user', content: 'Test' }]
    })
  });
} catch (error) {
  // Circuit is open, requests are blocked
  console.error('Circuit breaker is open');
}

// After 60 seconds, one test request is allowed
// If successful, circuit closes
```

## Rate Limit Tracking

The system automatically tracks rate limits from provider responses and avoids hitting limits repeatedly.

### Rate Limit Headers

When a provider returns a 429 status, the system:

1. Checks for `Retry-After` header
2. Parses the retry-after time
3. Marks the provider as rate-limited
4. Redirects new requests to alternatives

### Example

```javascript
// Provider returns 429 with Retry-After header
HTTP/1.1 429 Too Many Requests
Retry-After: 60

// System marks provider as rate-limited for 60 seconds
// New requests automatically routed to alternatives
```

## Request Queuing

When all models are at capacity, requests are queued and processed when slots become available.

### Queue Behavior

- **Priority-based**: Higher priority requests are processed first
- **Timeout**: Queued requests timeout after `queueTimeout` (default: 5 minutes)
- **Capacity limit**: Queue size limited by `maxQueueSize` (default: 100)

### Queue Status

Monitor queue status via API or UI:

```json
{
  "iflow,glm-4.7": {
    "queueLength": 3,
    "oldestRequestAge": 15000,
    "priorityRange": {
      "min": 0,
      "max": 10
    }
  }
}
```

## Best Practices

### 1. Configure Appropriate Concurrency Limits

```json
{
  "modelPool": {
    "maxConcurrentPerModel": 2  // Adjust based on provider limits
  }
}
```

### 2. Set Up Failover Chains

```json
{
  "failover": {
    "iflow": [
      "iflow-backup",           // Same provider, different endpoint
      { "provider": "openai", "model": "gpt-4" },  // Different provider
      { "provider": "anthropic", "model": "claude-3-sonnet" }  // Cheaper fallback
    ]
  }
}
```

### 3. Use Priority for Important Requests

```javascript
// High priority for urgent requests
headers: { 'X-CCR-Priority': '10' }

// Normal priority for regular requests
headers: { 'X-CCR-Priority': '0' }

// Low priority for background tasks
headers: { 'X-CCR-Priority': '-10' }
```

### 4. Monitor Model Pool Status

Regularly check:
- Active requests per model
- Queue length and wait times
- Circuit breaker status
- Rate limit status
- Success rates

### 5. Adjust Circuit Breaker Settings

```json
{
  "modelPool": {
    "circuitBreaker": {
      "failureThreshold": 5,      // Open after 5 failures
      "cooldownPeriod": 60000,    // Wait 60 seconds
      "testRequestAfterCooldown": true  // Test after cooldown
    }
  }
}
```

### 6. Configure Queue Settings

```json
{
  "modelPool": {
    "queue": {
      "maxQueueSize": 100,         // Max 100 queued requests
      "queueTimeout": 300000,      // 5 minute timeout
      "priorityLevels": {
        "high": 10,
        "normal": 0,
        "low": -10
      }
    }
  }
}
```

## Troubleshooting

### Issue: All requests are queued

**Check:**
1. Model pool status: `GET /api/model-pool/status`
2. Verify `maxConcurrentPerModel` is appropriate
3. Check if circuit breakers are open
4. Verify providers are healthy

**Solution:**
- Increase `maxConcurrentPerModel` if provider allows
- Reset circuit breakers: `POST /api/model-pool/reset-circuit-breakers`
- Add more providers to failover chain

### Issue: Circuit breaker keeps opening

**Check:**
1. Provider health and error rate
2. `failureThreshold` setting
3. Network connectivity

**Solution:**
- Increase `failureThreshold` if provider is flaky
- Check provider API status
- Verify network connectivity
- Consider using a different provider

### Issue: Requests timing out in queue

**Check:**
1. `queueTimeout` setting
2. Model capacity and usage
3. Number of concurrent `ccr code` instances

**Solution:**
- Increase `queueTimeout` for long-running requests
- Reduce number of concurrent instances
- Add more providers to pool
- Increase `maxConcurrentPerModel`

### Issue: Rate limits being hit frequently

**Check:**
1. Rate limit tracking status
2. Provider rate limits
3. Request volume

**Solution:**
- Reduce request volume
- Add more providers with different rate limits
- Implement client-side rate limiting
- Use priority to prioritize important requests

## Monitoring and Observability

### Key Metrics

Monitor these metrics for optimal performance:

1. **Active Requests**: Current requests per model
2. **Queue Length**: Number of queued requests per model
3. **Queue Wait Time**: Average time requests spend in queue
4. **Circuit Breaker Status**: Open/closed state per provider
5. **Rate Limit Status**: Rate-limited providers
6. **Success Rate**: Percentage of successful requests per provider
7. **Failover Rate**: Percentage of requests using alternatives

### Log Messages

```
[INFO] Acquired slot for iflow,glm-4.7 (1/2 active)
[INFO] Request queued for iflow,glm-4.7 (queue position: 3)
[INFO] Released slot for iflow,glm-4.7 (0/2 active)
[WARN] Model iflow,glm-4.7 at capacity, using alternative openai,gpt-4
[WARN] Circuit breaker opened for iflow,glm-4.7 (5 consecutive failures)
[INFO] Circuit breaker closed for iflow,glm-4.7 (recovered after cooldown)
[INFO] Rate limit detected for iflow,glm-4.7 (retry after: 60s)
```

## Migration Guide

### From Sequential Failover

If you were using the old sequential failover:

**Old Behavior:**
```
Request → Provider A (fails)
         → Provider B (fails)
         → Provider C (succeeds)
Total time: 30 seconds
```

**New Behavior:**
```
Request → Provider A (fails)
         → Provider B & C (parallel)
         → First success wins
Total time: 10 seconds
```

### Configuration Changes

No configuration changes required! The system is backward compatible.

**Optional Enhancements:**
1. Add `modelPool` configuration for fine-tuning
2. Adjust failover chains for better parallel execution
3. Set up priority levels for different request types

## Performance Considerations

### Latency Impact

- **No failover**: 1 request
- **With failover (1st attempt fails)**: Parallel failover reduces latency by ~60-70%
- **Queue wait**: Depends on queue length and capacity

### Resource Usage

- **Memory**: Minimal overhead for slot tracking (in-memory Map)
- **CPU**: Minimal overhead for queue processing
- **Network**: No additional network calls for failover (parallel execution)

### Optimization Strategies

1. **Fast Alternatives First**: Put fastest alternatives first in failover chain
2. **Appropriate Concurrency**: Match `maxConcurrentPerModel` to provider limits
3. **Priority Levels**: Use priority to ensure important requests are processed first
4. **Monitor and Adjust**: Regularly review metrics and adjust configuration

## Security Considerations

### API Key Management

- Each provider uses its own API key
- Failover doesn't bypass authentication
- Rate limit tracking is per provider

### Request Isolation

- Each `ccr code` instance has its own session
- Queued requests are isolated by provider+model
- Circuit breaker is per provider+model

## Summary

The parallel execution and intelligent failover system provides:

✅ **Multiple concurrent `ccr code` instances**  
✅ **Intelligent model sharing** (2 concurrent per provider+model)  
✅ **Automatic failover** on capacity and errors  
✅ **Request queuing** with priority support  
✅ **Circuit breaker pattern** for failing providers  
✅ **Rate limit tracking** to avoid hitting limits  
✅ **Parallel failover** for reduced latency  
✅ **Comprehensive monitoring** via API and UI  
✅ **Backward compatible** with existing configurations  

For questions or issues, check the logs and monitoring endpoints for detailed information.