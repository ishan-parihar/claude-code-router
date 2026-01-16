# OpenCode Integration with CCR Custom-Model

## Overview

This guide explains how to integrate OpenCode with Claude Code Router's custom-model functionality for automatic model routing with intelligent failover.

## How `ccr code` Works

### Environment Variables

When you run `ccr code`, the CLI automatically sets these environment variables:

```typescript
ANTHROPIC_AUTH_TOKEN: config.APIKEY || "test"
ANTHROPIC_BASE_URL: http://127.0.0.1:3456  // CCR server endpoint
NO_PROXY: 127.0.0.1
DISABLE_TELEMETRY: true
DISABLE_COST_WARNINGS: true
API_TIMEOUT_MS: 600000
```

### Key Point

**`ccr code` does NOT specify which model to use.** It relies entirely on CCR's router to determine the appropriate model based on:
- Request scenario (default/think/longContext/background/webSearch)
- Token count
- Custom router (if configured)
- For custom-model: Routes to `Router.default` configuration

### Request Flow

```
ccr code
  ↓
Sets environment variables (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN)
  ↓
Spawns claude command with these environment variables
  ↓
Claude Code sends API requests to ANTHROPIC_BASE_URL
  ↓
CCR receives request at http://127.0.0.1:3456/v1/messages
  ↓
CCR router processes request:
  - If model = "custom-model" → Routes to Router.default
  - If model = "provider,model" → Uses explicit model
  - If model missing → Uses Router.default
  ↓
For custom-model:
  - Routes to Router.default (iflow,glm-4.7)
  - Checks capacity via ModelPoolManager
  - If unavailable → Tries failover alternatives in parallel
  - Returns first successful response
```

## OpenCode Configuration

### Before (Explicit Model)

```json
{
  "model": "iflow/glm-4.7",
  "provider": {
    "iflow": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "iFlow Provider",
      "options": {
        "baseURL": "http://127.0.0.1:3456/v1",
        "apiKey": "dummy"
      },
      "models": {
        "glm-4.7": {
          "id": "iflow,glm-4.7",
          "limit": {
            "context": 200000,
            "output": 65536
          }
        }
      }
    }
  }
}
```

**Problem**: OpenCode sends `model: "iflow,glm-4.7"` explicitly, bypassing CCR's automatic routing and failover.

### After (Custom-Model)

```json
{
  "model": "iflow/custom-model",
  "provider": {
    "iflow": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "iFlow Provider (CCR with Custom-Model)",
      "options": {
        "baseURL": "http://127.0.0.1:3456/v1",
        "apiKey": "test"
      },
      "models": {
        "custom-model": {
          "id": "custom-model",
          "limit": {
            "context": 200000,
            "output": 65536
          }
        },
        "glm-4.7": {
          "id": "iflow,glm-4.7",
          "limit": {
            "context": 200000,
            "output": 65536
          }
        },
        "glm-4.6": {
          "id": "iflow,glm-4.6",
          "limit": {
            "context": 200000,
            "output": 65536
          }
        }
      }
    }
  }
}
```

**Benefits**:
- OpenCode sends `model: "custom-model"` to CCR
- CCR automatically routes to `Router.default` (iflow,glm-4.7)
- Failover is automatically triggered if iflow is rate-limited or at capacity
- Parallel execution of alternatives for faster failover

## CCR Configuration

### Required Configuration

```json
{
  "Providers": [
    {
      "name": "iflow",
      "api_base_url": "https://apis.iflow.cn/v1/chat/completions",
      "api_key": "your-iflow-api-key",
      "models": ["glm-4.6", "glm-4.7", "minimax-m2.1"],
      "headers": {
        "User-Agent": "iFlow-Cli",
        "X-Client-Type": "iflow-cli",
        "X-Client-Version": "0.3.26"
      }
    },
    {
      "name": "iflowX",
      "api_base_url": "https://apis.iflow.cn/v1/chat/completions",
      "api_key": "your-iflowx-api-key",
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
    "webSearch": "iflow,glm-4.7"
  }
}
```

### Recommended Failover Configuration

```json
{
  "failover": {
    "iflow": [
      "iflowX",
      { "provider": "iflow", "model": "minimax-m2.1" },
      { "provider": "iflowX", "model": "minimax-m2.1" }
    ],
    "iflowX": [
      "iflow",
      { "provider": "iflow", "model": "minimax-m2.1" },
      { "provider": "iflowX", "model": "minimax-m2.1" }
    ]
  },
  "modelPool": {
    "maxConcurrentPerModel": 2,
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
      "maxQueueSize": 100,
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

## Testing the Integration

### 1. Restart CCR

```bash
ccr restart
```

### 2. Verify CCR is Running

```bash
ccr status
```

### 3. Test Custom-Model with curl

```bash
curl -X POST http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "custom-model",
    "messages": [{"role": "user", "content": "Hello from custom-model!"}],
    "max_tokens": 100
  }'
```

Expected response:
- CCR routes to `iflow,glm-4.7`
- If iflow is unavailable, tries `iflowX,glm-4.7` or alternatives

### 4. List Available Models

```bash
curl http://127.0.0.1:3456/v1/models
```

You should see `custom-model` in the list:
```json
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
}
```

### 5. Check Model Pool Status

```bash
curl http://127.0.0.1:3456/model-pool/status
```

### 6. Use OpenCode with Custom-Model

Start OpenCode and use the iflow provider with custom-model:
```
Model: iflow/custom-model
```

## How Failover Works

### Scenario 1: Normal Operation

```
OpenCode → CCR (model: custom-model)
  ↓
CCR routes to Router.default (iflow,glm-4.7)
  ↓
Request sent to iflow API
  ↓
Response returned to OpenCode
```

### Scenario 2: iflow Rate-Limited

```
OpenCode → CCR (model: custom-model)
  ↓
CCR routes to Router.default (iflow,glm-4.7)
  ↓
iflow returns 429 (rate limit)
  ↓
CCR marks iflow as rate-limited
  ↓
CCR builds alternatives from failover config:
  - iflowX,glm-4.7
  - iflow,minimax-m2.1
  - iflowX,minimax-m2.1
  ↓
CCR tries alternatives in parallel
  ↓
First successful response wins
  ↓
Response returned to OpenCode
```

### Scenario 3: All Alternatives Failed

```
OpenCode → CCR (model: custom-model)
  ↓
CCR routes to Router.default (iflow,glm-4.7)
  ↓
iflow returns 429 (rate limit)
  ↓
CCR tries alternatives in parallel
  ↓
All alternatives fail (429/502/503)
  ↓
Request queued for retry
  ↓
When iflow becomes available, request is processed
```

## Monitoring

### Check Active Failover

Look for these log messages in CCR logs:

```
[INFO] custom-model resolved to Router.default: iflow,glm-4.7
[WARN] Primary model iflow,glm-4.7 is rate-limited, looking for alternative
[INFO] Using alternative model iflowX,glm-4.7 instead of iflow,glm-4.7 (filtered from 3 total alternatives)
[INFO] Alternative iflowX,glm-4.7 succeeded
```

### Check Model Pool Status

```bash
curl http://127.0.0.1:3456/model-pool/status | jq
```

Response example:
```json
{
  "iflow,glm-4.7": {
    "activeRequests": 1,
    "maxConcurrent": 2,
    "queuedRequests": 0,
    "circuitBreakerOpen": false,
    "rateLimitUntil": null,
    "failureCount": 0,
    "successCount": 98,
    "successRate": 98.0
  },
  "iflowX,glm-4.7": {
    "activeRequests": 0,
    "maxConcurrent": 2,
    "queuedRequests": 0,
    "circuitBreakerOpen": false,
    "rateLimitUntil": "2026-01-16T12:30:00.000Z",
    "failureCount": 3,
    "successCount": 5,
    "successRate": 62.5
  }
}
```

## Troubleshooting

### Issue: OpenCode fails with "Provider undefined not found"

**Cause**: Using wrong model identifier format.

**Solution**: Use `"iflow/custom-model"` instead of `"custom-model"` or `"iflow,glm-4.7"`.

### Issue: No failover happening

**Cause**: Missing or incorrect failover configuration.

**Solution**: Check CCR config.json has `failover` section at root level:
```json
{
  "failover": {
    "iflow": ["iflowX"]
  }
}
```

### Issue: All requests queued

**Cause**: All models at capacity or circuit breakers open.

**Solution**:
1. Check model pool status: `curl http://127.0.0.1:3456/model-pool/status`
2. Reset circuit breakers: `curl -X POST http://127.0.0.1:3456/model-pool/reset-circuit-breakers`
3. Increase `maxConcurrentPerModel` in modelPool config

### Issue: "Router.default not configured for custom-model"

**Cause**: Missing Router.default configuration.

**Solution**: Add Router.default to CCR config.json:
```json
{
  "Router": {
    "default": "iflow,glm-4.7"
  }
}
```

## Summary

### Key Changes

1. **OpenCode Configuration**:
   - Change model from `"iflow/glm-4.7"` to `"iflow/custom-model"`
   - Add `"custom-model"` to models list
   - Keep explicit models for direct access if needed

2. **CCR Configuration**:
   - Ensure `Router.default` is configured
   - Add `failover` configuration at root level
   - Add `modelPool` configuration for capacity management

3. **Benefits**:
   - Automatic routing to Router.default
   - Intelligent failover when primary is unavailable
   - Parallel execution of alternatives
   - Circuit breaker protection
   - Rate limit tracking

### Files Modified

- `/home/ishanp/.config/opencode/opencode.json` - Updated to use custom-model
- `/home/ishanp/.claude-code-router/config.json` - Added failover and modelPool config

### Next Steps

1. Apply the refactored OpenCode configuration
2. Restart CCR: `ccr restart`
3. Test with OpenCode
4. Monitor model pool status
5. Adjust failover configuration based on your needs
