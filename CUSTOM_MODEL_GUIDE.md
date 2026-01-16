# Custom-Model Implementation Guide

## Overview

The custom-model feature enables automatic model routing without requiring clients to explicitly specify which provider and model to use. When a client sends `model: "custom-model"`, CCR automatically routes the request to the configured `Router.default` model with intelligent failover support.

## How It Works

### Request Flow

```
Client Request (model: "custom-model")
    ↓
preHandler Middleware recognizes "custom-model"
    ↓
Router resolves to Router.default (e.g., "iflow,glm-4.7")
    ↓
ModelPoolManager checks capacity
    ↓
If unavailable → Failover to alternatives (only for default scenario)
    ↓
Execute request with parallel alternatives
    ↓
Return response
```

### Key Features

1. **Automatic Routing**: Clients don't need to know which provider/model to use
2. **Failover Support**: Only enabled for custom-model (default scenario)
3. **Parallel Execution**: Multiple alternatives tried simultaneously for faster failover
4. **Capacity Management**: Respects concurrent request limits and queues requests
5. **Circuit Breaker**: Prevents cascading failures from problematic providers

## Configuration

### Required Configuration

```json
{
  "Router": {
    "default": "iflow,glm-4.7"
  }
}
```

### Failover Configuration (Optional but Recommended)

```json
{
  "failover": {
    "iflow": ["iflow-backup"],
    "iflow-backup": ["iflow"]
  }
}
```

### Model Pool Configuration (Optional)

```json
{
  "modelPool": {
    "maxConcurrentPerModel": 2,
    "circuitBreaker": {
      "failureThreshold": 5,
      "cooldownPeriod": 60000
    }
  }
}
```

## API Usage

### Using custom-model

```bash
curl -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "custom-model",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Listing Available Models

```bash
curl http://localhost:3456/v1/models
```

Response:
```json
{
  "object": "list",
  "data": [
    {
      "id": "custom-model",
      "object": "model",
      "owned_by": "claude-code-router",
      "description": "Automatic model routing using Router.default with intelligent failover",
      "capabilities": {
        "automatic_routing": true,
        "failover": true,
        "parallel_execution": true
      }
    },
    {
      "id": "glm-4.7",
      "object": "model",
      "owned_by": "iflow",
      "provider": "iflow"
    },
    {
      "id": "iflow,glm-4.7",
      "object": "model",
      "owned_by": "iflow",
      "provider": "iflow"
    }
  ]
}
```

## Failover Behavior

### When Failover is Triggered

Failover is only triggered for custom-model requests when:
- Rate limit detected (HTTP 429, 449)
- Circuit breaker open
- Model at capacity (max concurrent requests reached)

### Failover Process

1. **Primary Unavailable**: Router.default model is rate-limited or at capacity
2. **Build Alternatives**: Get alternatives from failover configuration
3. **Filter Available**: Remove rate-limited and circuit-open alternatives
4. **Parallel Execution**: Try all available alternatives simultaneously
5. **First Success Wins**: Return response from first successful alternative
6. **Cancel Others**: Abort remaining parallel requests

### Non-Default Scenarios

**Important**: Failover is NOT applied to other scenarios:
- `think`: Router.think model (no failover)
- `longContext`: Router.longContext model (no failover)
- `background`: Router.background model (no failover)
- `webSearch`: Router.webSearch model (no failover)

These scenarios will be queued if unavailable, but will not use failover.

## Example Configurations

### Simple Setup

```json
{
  "providers": [
    {
      "name": "iflow",
      "api_base_url": "https://api.iflow.com/v1",
      "api_key": "your-api-key",
      "models": ["glm-4.7"]
    }
  ],
  "Router": {
    "default": "iflow,glm-4.7"
  }
}
```

### With Failover

```json
{
  "providers": [
    {
      "name": "iflow",
      "api_base_url": "https://api.iflow.com/v1",
      "api_key": "key-1",
      "models": ["glm-4.7"]
    },
    {
      "name": "iflow-backup",
      "api_base_url": "https://api.iflow-backup.com/v1",
      "api_key": "key-2",
      "models": ["glm-4.7"]
    }
  ],
  "failover": {
    "iflow": ["iflow-backup"],
    "iflow-backup": ["iflow"]
  },
  "Router": {
    "default": "iflow,glm-4.7"
  }
}
```

### Cross-Provider Failover

```json
{
  "providers": [
    {
      "name": "iflow",
      "api_base_url": "https://api.iflow.com/v1",
      "api_key": "iflow-key",
      "models": ["glm-4.7"]
    },
    {
      "name": "openai",
      "api_base_url": "https://api.openai.com/v1",
      "api_key": "openai-key",
      "models": ["gpt-4"]
    }
  ],
  "failover": {
    "iflow": [
      { "provider": "openai", "model": "gpt-4" }
    ],
    "openai": [
      { "provider": "iflow", "model": "glm-4.7" }
    ]
  },
  "Router": {
    "default": "iflow,glm-4.7"
  }
}
```

## Monitoring

### Model Pool Status

```bash
curl http://localhost:3456/model-pool/status
```

### Queue Status

```bash
curl http://localhost:3456/model-pool/queue
```

### Reset Circuit Breakers

```bash
curl -X POST http://localhost:3456/model-pool/reset-circuit-breakers
```

## Integration with Claude Code and OpenCode

### Claude Code Usage

When using `ccr code`, the system automatically sets the environment variables:
- `ANTHROPIC_BASE_URL`: `http://127.0.0.1:3456`
- `ANTHROPIC_AUTH_TOKEN`: Your API key

Claude Code will automatically use the configured default model.

### OpenCode Usage

Configure OpenCode to use CCR:

```json
{
  "providers": [
    {
      "id": "opencode",
      "name": "CCR",
      "type": "openai",
      "baseUrl": "http://127.0.0.1:3456/v1",
      "apiKey": "your-api-key",
      "models": ["custom-model"]
    }
  ]
}
```

OpenCode will now use `custom-model` which automatically routes to your configured default model with failover.

## Best Practices

### 1. Always Configure Router.default

```json
{
  "Router": {
    "default": "iflow,glm-4.7"
  }
}
```

Without `Router.default`, custom-model will fail with an error.

### 2. Set Up Failover Chains

```json
{
  "failover": {
    "iflow": ["iflow-backup", { "provider": "openai", "model": "gpt-4" }]
  }
}
```

Provides high availability for custom-model requests.

### 3. Configure Appropriate Concurrency Limits

```json
{
  "modelPool": {
    "maxConcurrentPerModel": 2
  }
}
```

Match your provider's rate limits.

### 4. Monitor Model Pool Status

Regularly check:
- Active requests per model
- Queue length
- Circuit breaker status
- Success rates

### 5. Use Fast Alternatives First

```json
{
  "failover": {
    "iflow": [
      "iflow-backup",        // Same provider, different endpoint (fast)
      { "provider": "openai", "model": "gpt-4" }  // Different provider (slower)
    ]
  }
}
```

## Troubleshooting

### Issue: "Router.default not configured for custom-model"

**Cause**: Missing `Router.default` configuration.

**Solution**: Add `Router.default` to your config.json:
```json
{
  "Router": {
    "default": "provider,model"
  }
}
```

### Issue: Failover not working

**Cause**: Missing failover configuration or no available alternatives.

**Solution**: 
1. Check failover configuration exists
2. Verify alternatives are configured
3. Check model pool status for rate-limited providers

### Issue: All requests queued

**Cause**: All models at capacity or circuit breakers open.

**Solution**:
1. Increase `maxConcurrentPerModel`
2. Reset circuit breakers
3. Add more providers

### Issue: Requests failing without failover

**Cause**: Using explicit provider,model instead of custom-model.

**Solution**: Use `model: "custom-model"` for automatic routing with failover.

## Implementation Details

### Modified Files

1. **packages/core/src/server.ts**
   - Added recognition of "custom-model" identifier in preHandler middleware
   - Sets `req.provider = "custom-model"` for custom-model requests

2. **packages/core/src/utils/router.ts**
   - Added handling for custom-model in router function
   - Routes custom-model to Router.default
   - Sets `req.isCustomModel = true` flag
   - Only applies failover for custom-model (default scenario)

3. **packages/core/src/api/routes.ts**
   - Added /v1/models endpoint listing custom-model
   - Updated FastifyRequest interface with new properties
   - Modified handleFallback to only apply for custom-model requests

### Request Properties

When using custom-model, the following properties are set:
- `req.provider = "custom-model"` (initially)
- `req.model = "custom-model"` (initially)
- `req.isCustomModel = true` (after routing)
- `req.scenarioType = "default"`
- `req.provider = <resolved provider>` (after routing)
- `req.model = <resolved model>` (after routing)

### Failover Scope

**Enabled for:**
- ✅ custom-model (Router.default)

**Disabled for:**
- ❌ Router.think
- ❌ Router.longContext
- ❌ Router.background
- ❌ Router.webSearch
- ❌ Explicit provider,model requests

## Summary

The custom-model feature provides:
- ✅ Automatic routing to Router.default
- ✅ Intelligent failover only for default scenario
- ✅ Parallel execution of alternatives
- ✅ Model pool capacity management
- ✅ Circuit breaker protection
- ✅ Rate limit tracking
- ✅ Seamless integration with Claude Code and OpenCode

Use `model: "custom-model"` for automatic routing with failover, or use explicit `provider,model` for direct access to specific models.
