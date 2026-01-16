# Custom-Model Implementation Summary

## Implementation Complete

The custom-model functionality has been successfully implemented in CCR. This enables automatic model routing with intelligent failover for the default model scenario only.

## Files Modified

### 1. `packages/core/src/server.ts`
- Added recognition of "custom-model" identifier in preHandler middleware
- Extended FastifyRequest interface with new properties: `isCustomModel`, `priority`, `needsQueue`, `queueModel`, `sessionId`, `resolvedModel`

### 2. `packages/core/src/utils/router.ts`
- Added handling for custom-model in router function
- Routes custom-model to `Router.default` configuration
- Sets `req.isCustomModel = true` flag
- Only applies failover for custom-model (default scenario)
- Other scenarios (think, longContext, background, webSearch) are queued without failover

### 3. `packages/core/src/api/routes.ts`
- Added `/v1/models` endpoint to list custom-model with capabilities
- Updated FastifyRequest interface
- Modified `handleFallback()` to only apply failover for custom-model requests

## Key Features

### ✅ What Works
1. **Automatic Routing**: Clients send `model: "custom-model"` and CCR routes to `Router.default`
2. **Failover Support**: Only enabled for custom-model (default scenario)
3. **Parallel Execution**: Alternatives tried simultaneously for faster failover
4. **Capacity Management**: Respects concurrent request limits and queues requests
5. **Circuit Breaker**: Prevents cascading failures
6. **Rate Limit Tracking**: Exponential backoff for rate-limited providers

### ❌ What Doesn't Work
- Failover is **NOT** applied to other scenarios (think, longContext, background, webSearch)
- These scenarios will be queued if unavailable, but won't use failover

## Configuration Requirements

### Minimum Required
```json
{
  "Router": {
    "default": "provider,model"
  }
}
```

### Recommended for Failover
```json
{
  "providers": [
    {
      "name": "iflow",
      "api_base_url": "https://api.iflow.com/v1",
      "api_key": "your-key",
      "models": ["glm-4.7"]
    },
    {
      "name": "iflow-backup",
      "api_base_url": "https://api.iflow-backup.com/v1",
      "api_key": "your-backup-key",
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

### Listing available models
```bash
curl http://localhost:3456/v1/models
```

Response includes:
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

## Integration with Claude Code and OpenCode

### Claude Code
When using `ccr code`, the system automatically sets:
- `ANTHROPIC_BASE_URL`: `http://127.0.0.1:3456`
- `ANTHROPIC_AUTH_TOKEN`: Your API key

Claude Code will automatically use the configured default model.

### OpenCode
Configure OpenCode:
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

## Testing

To test the implementation:

1. Start CCR with custom-model configuration:
```bash
ccr restart
```

2. Test with curl:
```bash
curl -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "custom-model",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100
  }'
```

3. Check model pool status:
```bash
curl http://localhost:3456/model-pool/status
```

## Documentation

See `CUSTOM_MODEL_GUIDE.md` for detailed documentation including:
- Configuration examples
- Troubleshooting guide
- Best practices
- API reference

## Build Status

✅ Core package built successfully
✅ All TypeScript changes compiled without errors
✅ Custom-model functionality integrated into built artifacts

## Next Steps

1. Update your `config.json` with proper Router.default configuration
2. Restart CCR: `ccr restart`
3. Test with your preferred client (Claude Code, OpenCode, or curl)
4. Monitor model pool status via `/model-pool/status` endpoint
5. Adjust failover configuration based on your needs

## Notes

- Failover is only applied to custom-model requests (default scenario)
- Other scenarios (think, longContext, background, webSearch) do not use failover
- This is by design as per your requirement to only configure custom-model failover for the default model
- The implementation is backward compatible - existing explicit provider,model requests continue to work as before
