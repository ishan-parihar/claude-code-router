# CCR Multi-Instance Failover Configuration

## Overview

CCR supports automatic failover across multiple provider instances. When a request encounters a rate limit (HTTP 429) or other errors, CCR automatically switches to alternative providers/models without requiring separate API calls or configuration changes.

## How It Works

### Automatic Failover Flow

```
Client Request → Primary Provider
                      ↓
                 Rate Limit/Error?
                      ↓ Yes
              Try Alternative 1
                      ↓
                 Success?
                      ↓ No
              Try Alternative 2
                      ↓
                 Success?
                      ↓ No
              Try Global Fallbacks
                      ↓
              Return Result or Error
```

### Trigger Conditions

Automatic failover triggers on:
- **HTTP 429** - Rate limit exceeded
- **HTTP 503** - Service unavailable
- **HTTP 502** - Bad gateway
- **Provider errors** - Any provider_response_error

## Configuration

### Multi-Instance Setup

Configure multiple provider instances in your `config.json`:

```json
{
  "providers": [
    {
      "name": "iflow-primary",
      "api_base_url": "https://api.iflow.com/v1",
      "api_key": "your-iflow-primary-key",
      "models": ["glm-4.7", "glm-4.6"],
      "headers": {
        "User-Agent": "iFlow-Cli",
        "X-Client-Type": "iflow-cli",
        "X-Client-Version": "0.3.26"
      }
    },
    {
      "name": "iflow-backup",
      "api_base_url": "https://api.iflow-backup.com/v1",
      "api_key": "your-iflow-backup-key",
      "models": ["glm-4.7", "glm-4.6"],
      "headers": {
        "User-Agent": "iFlow-Cli",
        "X-Client-Type": "iflow-cli",
        "X-Client-Version": "0.3.26"
      }
    },
    {
      "name": "openai",
      "api_base_url": "https://api.openai.com/v1",
      "api_key": "your-openai-key",
      "models": ["gpt-4", "gpt-3.5-turbo"]
    }
  ]
}
```

### Failover Configuration

Define failover chains in the `failover` section:

```json
{
  "failover": {
    "iflow-primary": [
      "iflow-backup",
      { "provider": "openai", "model": "gpt-4" }
    ],
    "iflow-backup": [
      { "provider": "openai", "model": "gpt-4" }
    ],
    "openai": [
      { "provider": "iflow-primary", "model": "glm-4.7" },
      { "provider": "iflow-backup", "model": "glm-4.7" }
    ],
    "global": [
      "iflow-backup"
    ]
  }
}
```

### Failover Configuration Format

**Per-Provider Failover:**
```json
{
  "failover": {
    "provider-name": [
      "alternate-provider-1",
      { "provider": "alternate-provider-2", "model": "specific-model" },
      "alternate-provider-3"
    ]
  }
}
```

**Global Failover:**
```json
{
  "failover": {
    "global": [
      "provider-1",
      "provider-2",
      { "provider": "provider-3", "model": "model-3" }
    ]
  }
}
```

### Alternative Formats

You can specify alternatives in two ways:

1. **String format** - Same model as original:
   ```json
   "iflow-backup"
   ```

2. **Object format** - Specify different model:
   ```json
   { "provider": "openai", "model": "gpt-4" }
   ```

## Usage Examples

### Example 1: Simple Multi-Instance Setup

**Configuration:**
```json
{
  "providers": [
    {
      "name": "iflow-1",
      "api_base_url": "https://api.iflow-1.com/v1",
      "api_key": "key-1",
      "models": ["glm-4.7"]
    },
    {
      "name": "iflow-2",
      "api_base_url": "https://api.iflow-2.com/v1",
      "api_key": "key-2",
      "models": ["glm-4.7"]
    }
  ],
  "failover": {
    "iflow-1": ["iflow-2"],
    "iflow-2": ["iflow-1"]
  }
}
```

**Request:**
```bash
curl -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "iflow-1,glm-4.7",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

**Behavior:**
- If `iflow-1` hits rate limit → automatically tries `iflow-2`
- Client receives response seamlessly

### Example 2: Cross-Provider Failover

**Configuration:**
```json
{
  "providers": [
    {
      "name": "iflow",
      "api_base_url": "https://api.iflow.com/v1",
      "api_key": "your-iflow-key",
      "models": ["glm-4.7", "glm-4.6"]
    },
    {
      "name": "openai",
      "api_base_url": "https://api.openai.com/v1",
      "api_key": "your-openai-key",
      "models": ["gpt-4", "gpt-3.5-turbo"]
    },
    {
      "name": "anthropic",
      "api_base_url": "https://api.anthropic.com/v1",
      "api_key": "your-anthropic-key",
      "models": ["claude-3-opus", "claude-3-sonnet"]
    }
  ],
  "failover": {
    "iflow": [
      { "provider": "openai", "model": "gpt-4" },
      { "provider": "anthropic", "model": "claude-3-opus" }
    ],
    "openai": [
      { "provider": "anthropic", "model": "claude-3-opus" },
      { "provider": "iflow", "model": "glm-4.7" }
    ],
    "anthropic": [
      { "provider": "openai", "model": "gpt-4" },
      { "provider": "iflow", "model": "glm-4.7" }
    ]
  }
}
```

**Request:**
```bash
curl -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "iflow,glm-4.7",
    "messages": [{"role": "user", "content": "Explain quantum computing"}]
  }'
```

**Behavior:**
1. Try `iflow,glm-4.7`
2. If rate limited → try `openai,gpt-4`
3. If still rate limited → try `anthropic,claude-3-opus`
4. Return first successful response

### Example 3: Global Fallbacks

**Configuration:**
```json
{
  "providers": [
    {
      "name": "provider-a",
      "api_base_url": "https://api-a.com/v1",
      "api_key": "key-a",
      "models": ["model-1"]
    },
    {
      "name": "provider-b",
      "api_base_url": "https://api-b.com/v1",
      "api_key": "key-b",
      "models": ["model-1"]
    },
    {
      "name": "provider-c",
      "api_base_url": "https://api-c.com/v1",
      "api_key": "key-c",
      "models": ["model-1"]
    }
  ],
  "failover": {
    "global": [
      "provider-b",
      "provider-c"
    ]
  }
}
```

**Behavior:**
- Any provider failure tries `provider-b`, then `provider-c`
- Useful for having a "last resort" backup

## Best Practices

### 1. Provider Naming

Use descriptive names for multiple instances:

```json
{
  "providers": [
    {
      "name": "iflow-primary",
      "api_base_url": "https://api.iflow.com/v1",
      "api_key": "primary-key"
    },
    {
      "name": "iflow-secondary",
      "api_base_url": "https://api.iflow-backup.com/v1",
      "api_key": "secondary-key"
    },
    {
      "name": "iflow-tertiary",
      "api_base_url": "https://api.iflow-emergency.com/v1",
      "api_key": "tertiary-key"
    }
  ]
}
```

### 2. Rate Limit Awareness

Configure alternatives with different rate limits:

```json
{
  "failover": {
    "iflow-primary": [
      "iflow-secondary",  // Same provider, different endpoint
      { "provider": "openai", "model": "gpt-4" },  // Different provider
      { "provider": "anthropic", "model": "claude-3-sonnet" }  // Cheaper fallback
    ]
  }
}
```

### 3. Model Compatibility

Ensure alternative models have similar capabilities:

```json
{
  "failover": {
    "iflow": [
      // Good: similar capabilities
      { "provider": "openai", "model": "gpt-4" }
      
      // Bad: significantly different capabilities
      // { "provider": "openai", "model": "gpt-3.5-turbo" }
    ]
  }
}
```

### 4. Failover Chain Length

Keep failover chains reasonable (3-5 alternatives):

```json
{
  "failover": {
    "iflow": [
      "iflow-backup",      // 1st alternative
      "openai",             // 2nd alternative
      "anthropic"           // 3rd alternative
      // Avoid too many alternatives
    ]
  }
}
```

### 5. Global vs Provider-Specific

Use global fallbacks for common backups:

```json
{
  "failover": {
    "iflow": ["iflow-backup", "openai"],
    "openai": ["iflow-primary", "anthropic"],
    "anthropic": ["iflow-primary", "openai"],
    "global": ["emergency-backup-provider"]
  }
}
```

## Monitoring and Logging

### Log Messages

CCR logs failover attempts:

```
[WARN] Request failed for iflow,glm-4.7 (429), trying 2 alternatives
[INFO] Trying alternative: iflow-backup,glm-4.7
[INFO] Alternative iflow-backup,glm-4.7 succeeded
```

### Monitoring Metrics

Track these metrics:

1. **Failover Rate** - Percentage of requests using alternatives
2. **Provider Success Rate** - Success rate per provider
3. **Average Response Time** - With and without failover
4. **Rate Limit Frequency** - How often 429 errors occur

### Example Monitoring Script

```bash
#!/bin/bash
# Monitor failover usage

echo "=== Failover Report (Last 1000 lines) ==="

echo ""
echo "Failover attempts:"
grep "trying.*alternatives" /var/log/ccr.log | tail -20

echo ""
echo "Successful alternatives:"
grep "Alternative.*succeeded" /var/log/ccr.log | tail -20

echo ""
echo "Failed alternatives:"
grep "Alternative.*failed" /var/log/ccr.log | tail -20

echo ""
echo "By provider:"
for provider in iflow openai anthropic; do
  SUCCESS=$(grep "Trying alternative: ${provider}," /var/log/ccr.log | wc -l)
  echo "${provider}: ${SUCCESS} attempts"
done
```

## Troubleshooting

### Issue: Failover not triggering

**Check:**
1. Failover configuration exists
2. Error code matches trigger conditions
3. Alternative providers are registered

```bash
# Check configuration
curl http://localhost:3456/providers

# Check logs
tail -f /var/log/ccr.log | grep -E "failover|alternative|429"
```

### Issue: All alternatives failing

**Check:**
1. All providers accessible
2. API keys valid
3. Models exist in configurations

```bash
# Test each provider
for provider in iflow openai anthropic; do
  echo "Testing $provider..."
  curl -X POST http://localhost:3456/v1/messages \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${provider},model-1\",\"messages\":[{\"role\":\"user\",\"content\":\"test\"}]}"
done
```

### Issue: Slow responses with failover

**Possible causes:**
1. Many alternatives with high latency
2. Network issues
3. All providers hitting rate limits

**Solution:**
- Reduce number of alternatives
- Use faster alternatives first
- Distribute load across multiple endpoints

## Advanced Configuration

### Weighted Failover

Implement weighted selection:

```json
{
  "failover": {
    "iflow": [
      { "provider": "iflow-backup", "weight": 5 },
      { "provider": "openai", "weight": 3 },
      { "provider": "anthropic", "weight": 1 }
    ]
  }
}
```

### Conditional Failover

Based on error type:

```json
{
  "failover": {
    "iflow": {
      "429": ["iflow-backup", "openai"],
      "503": ["anthropic"],
      "502": ["iflow-backup"]
    },
    "openai": {
      "429": ["anthropic", "iflow"]
    }
  }
}
```

### Geographic Failover

Configure by region:

```json
{
  "providers": [
    {
      "name": "iflow-us-east",
      "api_base_url": "https://us-east.api.iflow.com/v1"
    },
    {
      "name": "iflow-eu-west",
      "api_base_url": "https://eu-west.api.iflow.com/v1"
    },
    {
      "name": "iflow-asia",
      "api_base_url": "https://asia.api.iflow.com/v1"
    }
  ],
  "failover": {
    "iflow-us-east": [
      "iflow-eu-west",
      "iflow-asia"
    ],
    "iflow-eu-west": [
      "iflow-us-east",
      "iflow-asia"
    ]
  }
}
```

## Migration from Old Fallback API

If you were using the old fallback API:

**Old Configuration:**
```json
{
  "fallback": {
    "default": ["iflow,glm-4.7", "openai,gpt-4"]
  }
}
```

**New Configuration:**
```json
{
  "failover": {
    "iflow": [
      { "provider": "openai", "model": "gpt-4" }
    ]
  }
}
```

**Key Changes:**
1. Use `failover` instead of `fallback`
2. Configure per-provider alternatives
3. No separate API endpoints needed
4. Automatic failover on rate limits

## API Compatibility

### Client-Side

No changes needed! Clients continue using the same API:

```javascript
// Client code - no changes required
const response = await fetch('http://localhost:3456/v1/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'iflow,glm-4.7',
    messages: [{ role: 'user', content: 'Hello' }]
  })
});

// If iflow hits rate limit, CCR automatically tries alternatives
// Client receives response seamlessly
```

### Response Headers

CCR adds headers to indicate failover:

```
X-CCR-Original-Provider: iflow
X-CCR-Original-Model: glm-4.7
X-CCR-Actual-Provider: openai
X-CCR-Actual-Model: gpt-4
X-CCR-Failover: true
X-CCR-Failover-Reason: rate_limit
```

## Configuration Examples

### Example 1: Simple Two-Instance Setup

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
      "api_base_url": "https://backup.iflow.com/v1",
      "api_key": "key-2",
      "models": ["glm-4.7"]
    }
  ],
  "failover": {
    "iflow": ["iflow-backup"],
    "iflow-backup": ["iflow"]
  }
}
```

### Example 2: Multi-Provider with Global Fallback

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
    },
    {
      "name": "anthropic",
      "api_base_url": "https://api.anthropic.com/v1",
      "api_key": "anthropic-key",
      "models": ["claude-3-opus"]
    },
    {
      "name": "emergency",
      "api_base_url": "https://emergency-api.com/v1",
      "api_key": "emergency-key",
      "models": ["generic-model"]
    }
  ],
  "failover": {
    "iflow": [
      { "provider": "openai", "model": "gpt-4" },
      { "provider": "anthropic", "model": "claude-3-opus" }
    ],
    "openai": [
      { "provider": "anthropic", "model": "claude-3-opus" },
      { "provider": "iflow", "model": "glm-4.7" }
    ],
    "anthropic": [
      { "provider": "openai", "model": "gpt-4" },
      { "provider": "iflow", "model": "glm-4.7" }
    ],
    "global": ["emergency"]
  }
}
```

### Example 3: Geographic Distribution

```json
{
  "providers": [
    {
      "name": "iflow-us",
      "api_base_url": "https://us.api.iflow.com/v1",
      "api_key": "us-key",
      "models": ["glm-4.7"]
    },
    {
      "name": "iflow-eu",
      "api_base_url": "https://eu.api.iflow.com/v1",
      "api_key": "eu-key",
      "models": ["glm-4.7"]
    },
    {
      "name": "iflow-asia",
      "api_base_url": "https://asia.api.iflow.com/v1",
      "api_key": "asia-key",
      "models": ["glm-4.7"]
    }
  ],
  "failover": {
    "iflow-us": ["iflow-eu", "iflow-asia"],
    "iflow-eu": ["iflow-us", "iflow-asia"],
    "iflow-asia": ["iflow-us", "iflow-eu"]
  }
}
```

## Performance Considerations

### Latency Impact

- **No failover**: 1 request
- **With failover (1st attempt fails)**: 2 requests
- **With failover (2 attempts fail)**: 3 requests

### Optimization Strategies

1. **Fast Alternatives First**: Put fastest alternatives first in chain
2. **Parallel Failover**: Try top 2-3 alternatives in parallel (future feature)
3. **Caching**: Cache successful alternative selections
4. **Health Checks**: Monitor provider health and adjust chains

### Memory Usage

- Configuration stored in memory
- No additional memory per request
- Failover chains are pre-configured

## Security Considerations

### API Key Management

- Store API keys securely in config.json
- Use environment variables for sensitive keys
- Rotate keys regularly

### Failover Security

- All providers must be trusted
- Failover doesn't bypass authentication
- Each provider uses its own API key

```json
{
  "providers": [
    {
      "name": "iflow",
      "api_key": "iflow-api-key"  // Separate key for each instance
    },
    {
      "name": "iflow-backup",
      "api_key": "iflow-backup-key"  // Different key
    }
  ]
}
```

## Testing Failover

### Test Rate Limit Handling

```bash
# Test with rate limited provider (simulate 429)
curl -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "iflow,glm-4.7",
    "messages": [{"role": "user", "content": "test"}]
  }'

# Should automatically try alternatives if iflow is rate limited
```

### Test All Providers

```bash
# Test each provider individually
for provider in iflow iflow-backup openai anthropic; do
  echo "Testing $provider..."
  curl -X POST http://localhost:3456/v1/messages \
    -H "Content-Type: application/json" \
    -d "{
      \"model\":\"${provider},glm-4.7\",
      \"messages\":[{\"role\":\"user\",\"content\":\"test\"}]
    }"
  echo "---"
done
```

## Support

For issues or questions:
- Check logs: `/var/log/ccr.log`
- Review this guide
- Check provider status
- Verify configuration format

## Summary

- **Automatic failover** - No API calls needed
- **Rate limit handling** - Automatic on HTTP 429
- **Multi-instance support** - Configure multiple provider instances
- **Flexible configuration** - Per-provider and global failover chains
- **Seamless client experience** - No changes to client code

The multi-instance failover system ensures high availability and reliability without requiring separate fallback APIs or manual intervention.
