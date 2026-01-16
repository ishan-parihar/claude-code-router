![](blog/images/claude-code-router-img.png)

[![](https://img.shields.io/badge/%F0%9F%87%A8%F0%9F%87%B3-%E4%B8%AD%E6%96%87%E7%89%88-ff0000?style=flat)](README_zh.md)
[![Discord](https://img.shields.io/badge/Discord-%235865F2.svg?&logo=discord&logoColor=white)](https://discord.gg/rdftVMaUcS)
[![](https://img.shields.io/github/license/musistudio/claude-code-router)](https://github.com/musistudio/claude-code-router/blob/main/LICENSE)

<hr>

> A powerful tool to route Claude Code requests to different models and customize any request.

![](blog/images/claude-code.png)

## ✨ Features

- **Model Routing**: Route requests to different models based on your needs (e.g., background tasks, thinking, long context).
- **Multi-Provider Support**: Supports various model providers like OpenRouter, DeepSeek, Ollama, Gemini, Volcengine, and SiliconFlow.
- **Request/Response Transformation**: Customize requests and responses for different providers using transformers.
- **Dynamic Model Switching**: Switch models on-the-fly within Claude Code using the `/model` command.
- **CLI Model Management**: Manage models and providers directly from the terminal with `ccr model`.
- **Custom-Model**: Automatic model routing without explicit provider specification - use `model: "custom-model"` to let CCR intelligently route to your configured default model.
- **Intelligent Failover**: Automatic provider switching on rate limits, capacity limits, or failures with parallel execution for faster recovery.
- **Parallel Execution**: Multiple failover alternatives tried simultaneously, reducing latency by 60-70% compared to sequential retry.
- **Model Pool Management**: Intelligent concurrent request management with configurable capacity limits, circuit breakers, and rate limit tracking.
- **Request Queuing**: Priority-based request queuing when models are at capacity.
- **Circuit Breaker Pattern**: Prevents cascading failures by temporarily disabling problematic providers.
- **Rate Limit Tracking**: Automatic detection of rate limits with exponential backoff to avoid hitting provider limits repeatedly.
- **GitHub Actions Integration**: Trigger Claude Code tasks in your GitHub workflows.
- **Plugin System**: Extend functionality with custom transformers.
- **Web UI**: Intuitive web-based configuration interface with real-time monitoring.

## 🚀 Getting Started

### 1. Installation

First, ensure you have [Claude Code](https://docs.anthropic.com/en/docs/claude-code/quickstart) installed:

```shell
npm install -g @anthropic-ai/claude-code
```

Then, install Claude Code Router:

```shell
npm install -g @musistudio/claude-code-router
```

### 2. Configuration

Create and configure your `~/.claude-code-router/config.json` file. For more details, you can refer to `config.example.json`.

The `config.json` file has several key sections:

- **`PROXY_URL`** (optional): You can set a proxy for API requests, for example: `"PROXY_URL": "http://127.0.0.1:7890"`.
- **`LOG`** (optional): You can enable logging by setting it to `true`. When set to `false`, no log files will be created. Default is `true`.
- **`LOG_LEVEL`** (optional): Set the logging level. Available options are: `"fatal"`, `"error"`, `"warn"`, `"info"`, `"debug"`, `"trace"`. Default is `"debug"`.
- **Logging Systems**: The Claude Code Router uses two separate logging systems:
  - **Server-level logs**: HTTP requests, API calls, and server events are logged using pino in the `~/.claude-code-router/logs/` directory with filenames like `ccr-*.log`
  - **Application-level logs**: Routing decisions and business logic events are logged in `~/.claude-code-router/claude-code-router.log`
- **`APIKEY`** (optional): You can set a secret key to authenticate requests. When set, clients must provide this key in the `Authorization` header (e.g., `Bearer your-secret-key`) or the `x-api-key` header. Example: `"APIKEY": "your-secret-key"`.
- **`HOST`** (optional): You can set the host address for the server. If `APIKEY` is not set, the host will be forced to `127.0.0.1` for security reasons to prevent unauthorized access. Example: `"HOST": "0.0.0.0"`.
- **`NON_INTERACTIVE_MODE`** (optional): When set to `true`, enables compatibility with non-interactive environments like GitHub Actions, Docker containers, or other CI/CD systems. This sets appropriate environment variables (`CI=true`, `FORCE_COLOR=0`, etc.) and configures stdin handling to prevent the process from hanging in automated environments. Example: `"NON_INTERACTIVE_MODE": true`.

- **`Providers`**: Used to configure different model providers.
- **`Router`**: Used to set up routing rules. `default` specifies the default model, which will be used for all requests if no other route is configured.
- **`failover`**: Configure automatic failover to alternative providers when the primary model encounters errors or capacity limits.
- **`modelPool`**: Configure concurrent request limits, circuit breaker settings, rate limit tracking, and queue management.
- **`API_TIMEOUT_MS`**: Specifies the timeout for API calls in milliseconds.

#### Environment Variable Interpolation

Claude Code Router supports environment variable interpolation for secure API key management. You can reference environment variables in your `config.json` using either `$VAR_NAME` or `${VAR_NAME}` syntax:

```json
{
  "OPENAI_API_KEY": "$OPENAI_API_KEY",
  "GEMINI_API_KEY": "${GEMINI_API_KEY}",
  "Providers": [
    {
      "name": "openai",
      "api_base_url": "https://api.openai.com/v1/chat/completions",
      "api_key": "$OPENAI_API_KEY",
      "models": ["gpt-5", "gpt-5-mini"]
    }
  ]
}
```

This allows you to keep sensitive API keys in environment variables instead of hardcoding them in configuration files. The interpolation works recursively through nested objects and arrays.

Here is a comprehensive example:

```json
{
  "APIKEY": "your-secret-key",
  "PROXY_URL": "http://127.0.0.1:7890",
  "LOG": true,
  "API_TIMEOUT_MS": 600000,
  "NON_INTERACTIVE_MODE": false,
  "Providers": [
    {
      "name": "openrouter",
      "api_base_url": "https://openrouter.ai/api/v1/chat/completions",
      "api_key": "sk-xxx",
      "models": [
        "google/gemini-2.5-pro-preview",
        "anthropic/claude-sonnet-4",
        "anthropic/claude-3.5-sonnet",
        "anthropic/claude-3.7-sonnet:thinking"
      ],
      "transformer": {
        "use": ["openrouter"]
      }
    },
    {
      "name": "deepseek",
      "api_base_url": "https://api.deepseek.com/chat/completions",
      "api_key": "sk-xxx",
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "transformer": {
        "use": ["deepseek"],
        "deepseek-chat": {
          "use": ["tooluse"]
        }
      }
    },
    {
      "name": "ollama",
      "api_base_url": "http://localhost:11434/v1/chat/completions",
      "api_key": "ollama",
      "models": ["qwen2.5-coder:latest"]
    },
    {
      "name": "gemini",
      "api_base_url": "https://generativelanguage.googleapis.com/v1beta/models/",
      "api_key": "sk-xxx",
      "models": ["gemini-2.5-flash", "gemini-2.5-pro"],
      "transformer": {
        "use": ["gemini"]
      }
    },
    {
      "name": "volcengine",
      "api_base_url": "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
      "api_key": "sk-xxx",
      "models": ["deepseek-v3-250324", "deepseek-r1-250528"],
      "transformer": {
        "use": ["deepseek"]
      }
    },
    {
      "name": "modelscope",
      "api_base_url": "https://api-inference.modelscope.cn/v1/chat/completions",
      "api_key": "",
      "models": ["Qwen/Qwen3-Coder-480B-A35B-Instruct", "Qwen/Qwen3-235B-A22B-Thinking-2507"],
      "transformer": {
        "use": [
          [
            "maxtoken",
            {
              "max_tokens": 65536
            }
          ],
          "enhancetool"
        ],
        "Qwen/Qwen3-235B-A22B-Thinking-2507": {
          "use": ["reasoning"]
        }
      }
    },
    {
      "name": "dashscope",
      "api_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      "api_key": "",
      "models": ["qwen3-coder-plus"],
      "transformer": {
        "use": [
          [
            "maxtoken",
            {
              "max_tokens": 65536
            }
          ],
          "enhancetool"
        ]
      }
    },
    {
      "name": "aihubmix",
      "api_base_url": "https://aihubmix.com/v1/chat/completions",
      "api_key": "sk-",
      "models": [
        "Z/glm-4.5",
        "claude-opus-4-20250514",
        "gemini-2.5-pro"
      ]
    }
  ],
  "Router": {
    "default": "deepseek,deepseek-chat",
    "background": "ollama,qwen2.5-coder:latest",
    "think": "deepseek,deepseek-reasoner",
    "longContext": "openrouter,google/gemini-2.5-pro-preview",
    "longContextThreshold": 60000,
    "webSearch": "gemini,gemini-2.5-flash"
  },
  "failover": {
    "deepseek": [
      "openrouter",
      { "provider": "gemini", "model": "gemini-2.5-pro" }
    ],
    "openrouter": [
      "deepseek"
    ],
    "global": ["ollama"]
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

### 3. Running Claude Code with the Router

Start Claude Code using the router:

```shell
ccr code
```

> **Note**: After modifying the configuration file, you need to restart the service for the changes to take effect:
>
> ```shell
> ccr restart
> ```

### 4. UI Mode

For a more intuitive experience, you can use the UI mode to manage your configuration:

```shell
ccr ui
```

This will open a web-based interface where you can easily view and edit your `config.json` file, monitor model pool status, and manage failover configuration.

![UI](/blog/images/ui.png)

### 5. CLI Model Management

For users who prefer terminal-based workflows, you can use the interactive CLI model selector:

```shell
ccr model
```
![](blog/images/models.gif)

This command provides an interactive interface to:

- View current configuration:
- See all configured models (default, background, think, longContext, webSearch, image)
- Switch models: Quickly change which model is used for each router type
- Add new models: Add models to existing providers
- Create new providers: Set up complete provider configurations including:
   - Provider name and API endpoint
   - API key
   - Available models
   - Transformer configuration with support for:
     - Multiple transformers (openrouter, deepseek, gemini, etc.)
     - Transformer options (e.g., maxtoken with custom limits)
     - Provider-specific routing (e.g., OpenRouter provider preferences)

The CLI tool validates all inputs and provides helpful prompts to guide you through the configuration process, making it easy to manage complex setups without editing JSON files manually.

### 6. Presets Management

Presets allow you to save, share, and reuse configurations easily. You can export your current configuration as a preset and install presets from files or URLs.

```shell
# Export current configuration as a preset
ccr preset export my-preset

# Export with metadata
ccr preset export my-preset --description "My OpenAI config" --author "Your Name" --tags "openai,production"

# Install a preset from local directory
ccr preset install /path/to/preset

# List all installed presets
ccr preset list

# Show preset information
ccr preset info my-preset

# Delete a preset
ccr preset delete my-preset
```

**Preset Features:**
- **Export**: Save your current configuration as a preset directory (with manifest.json)
- **Install**: Install presets from local directories
- **Sensitive Data Handling**: API keys and other sensitive data are automatically sanitized during export (marked as `{{field}}` placeholders)
- **Dynamic Configuration**: Presets can include input schemas for collecting required information during installation
- **Version Control**: Each preset includes version metadata for tracking updates

**Preset File Structure:**
```
~/.claude-code-router/presets/
├── my-preset/
│   └── manifest.json    # Contains configuration and metadata
```

### 7. Activate Command (Environment Variables Setup)

The `activate` command allows you to set up environment variables globally in your shell, enabling you to use the `claude` command directly or integrate Claude Code Router with applications built using the Agent SDK.

To activate the environment variables, run:

```shell
eval "$(ccr activate)"
```

This command outputs the necessary environment variables in shell-friendly format, which are then set in your current shell session. After activation, you can:

- **Use `claude` command directly**: Run `claude` commands without needing to use `ccr code`. The `claude` command will automatically route requests through Claude Code Router.
- **Integrate with Agent SDK applications**: Applications built with the Anthropic Agent SDK will automatically use the configured router and models.

The `activate` command sets the following environment variables:

- `ANTHROPIC_AUTH_TOKEN`: API key from your configuration
- `ANTHROPIC_BASE_URL`: The local router endpoint (default: `http://127.0.0.1:3456`)
- `NO_PROXY`: Set to `127.0.0.1` to prevent proxy interference
- `DISABLE_TELEMETRY`: Disables telemetry
- `DISABLE_COST_WARNINGS`: Disables cost warnings
- `API_TIMEOUT_MS`: API timeout from your configuration

> **Note**: Make sure the Claude Code Router service is running (`ccr start`) before using the activated environment variables. The environment variables are only valid for the current shell session. To make them persistent, you can add `eval "$(ccr activate)"` to your shell configuration file (e.g., `~/.zshrc` or `~/.bashrc`).

## 🎯 Custom-Model Feature

The custom-model feature enables automatic model routing without requiring clients to explicitly specify which provider and model to use.

### How It Works

When a client sends `model: "custom-model"`, CCR automatically:

1. Recognizes the custom-model identifier
2. Routes the request to your configured `Router.default` model
3. Checks model capacity via ModelPoolManager
4. Triggers intelligent failover if the primary model is unavailable
5. Executes requests with parallel alternatives for faster recovery

### API Usage

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

Response includes custom-model with capabilities:
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
    }
  ]
}
```

### When to Use Custom-Model

**Use custom-model when:**
- You want automatic routing to your default model
- You want intelligent failover on rate limits or failures
- You're building integration with tools like OpenCode
- You don't want to manage provider,model strings in your application

**Use explicit provider,model when:**
- You need to use a specific model for a specific task
- You're using scenario-specific models (think, longContext, background, webSearch)
- You want direct control over which provider/model is used

### Important Notes

- **ccr code does NOT automatically inject custom-model**: You must explicitly specify `model: "custom-model"` in your requests or configuration
- **Failover only works for custom-model**: Other scenarios (think, longContext, background, webSearch) do not use failover by design
- **Router.default is required**: Without `Router.default` configured, custom-model will fail with an error

For detailed documentation, see [CUSTOM_MODEL_GUIDE.md](CUSTOM_MODEL_GUIDE.md).

## 🔄 Failover Configuration

Configure automatic failover to alternative providers when the primary model encounters errors or capacity limits.

### Configuration Structure

Failover configuration is now at the **root level** of `config.json`:

```json
{
  "failover": {
    "iflow": [
      "iflowX",
      { "provider": "openai", "model": "gpt-4" }
    ],
    "global": ["backup-provider"]
  }
}
```

### Configuration Options

#### Provider-Specific Failover

Define alternatives for specific providers:

```json
{
  "failover": {
    "iflow": [
      "iflowX",                           // Same provider, different model
      { "provider": "openai", "model": "gpt-4" },  // Different provider
      { "provider": "iflow", "model": "minimax-m2.1" }  // Same provider, different model
    ]
  }
}
```

#### Global Failover

Define fallback alternatives that work for any provider:

```json
{
  "failover": {
    "global": ["backup-provider", "another-backup"]
  }
}
```

#### String vs Object Format

You can use either format:

```json
{
  "failover": {
    "iflow": [
      "iflowX"                           // String: use same model
    ],
    "openai": [
      { "provider": "anthropic", "model": "claude-3-opus" }  // Object: specify both provider and model
    ]
  }
}
```

### Failover Behavior

**Failover is triggered when:**
- Rate limit detected (HTTP 429, 449)
- Circuit breaker open
- Model at capacity (max concurrent requests reached)
- Provider errors (HTTP 502, 503)

**Failover process:**
1. Primary model unavailable
2. Build alternatives from failover configuration
3. Filter out rate-limited and circuit-open alternatives
4. Try remaining alternatives in parallel
5. Return first successful response
6. Cancel remaining parallel requests

### Important: Failover Scope

**Failover is ONLY enabled for custom-model (default scenario):**
- ✅ custom-model → Router.default → Failover enabled
- ❌ Router.think → No failover (queues if unavailable)
- ❌ Router.longContext → No failover (queues if unavailable)
- ❌ Router.background → No failover (queues if unavailable)
- ❌ Router.webSearch → No failover (queues if unavailable)

This is by design to preserve scenario-specific behavior. Thinking tasks should use the thinking model, long context tasks should use the long context model, etc.

### UI Configuration

You can configure failover in the web UI:

1. Run `ccr ui`
2. Navigate to Router section
3. Expand "Failover Configuration"
4. Add provider-specific or global failover alternatives
5. Save and restart

## ⚡ Parallel Execution & Model Pool Management

### Overview

CCR supports intelligent parallel execution with automatic failover for multiple concurrent requests:

- **Multiple concurrent instances**: Run multiple `ccr code` instances simultaneously
- **Intelligent model sharing**: Each provider+model handles up to 2 concurrent requests (configurable)
- **Automatic failover**: Switch to alternatives when models are at capacity or encounter errors
- **Request queuing**: Priority-based queue when models are at capacity
- **Circuit breaker pattern**: Prevent cascading failures from problematic providers
- **Rate limit tracking**: Exponential backoff to avoid hitting provider limits repeatedly
- **Parallel execution**: Multiple alternatives tried simultaneously (60-70% faster than sequential)

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

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxConcurrentPerModel` | number | 2 | Maximum concurrent requests per provider+model |
| `circuitBreaker.failureThreshold` | number | 5 | Failures before opening circuit breaker |
| `circuitBreaker.cooldownPeriod` | number | 60000 | Cooldown period in milliseconds |
| `circuitBreaker.testRequestAfterCooldown` | boolean | true | Allow test request after cooldown |
| `rateLimit.defaultRetryAfter` | number | 60000 | Default retry after rate limit |
| `rateLimit.respectRetryAfterHeader` | boolean | true | Respect provider's Retry-After header |
| `rateLimit.backoffMultiplier` | number | 1.5 | Exponential backoff multiplier |
| `rateLimit.maxBackoff` | number | 300000 | Maximum backoff duration |
| `queue.maxQueueSize` | number | 100 | Maximum queued requests per model |
| `queue.queueTimeout` | number | 300000 | Queue timeout in milliseconds |
| `queue.priorityLevels.high` | number | 10 | High priority value |
| `queue.priorityLevels.normal` | number | 0 | Normal priority value |
| `queue.priorityLevels.low` | number | -10 | Low priority value |
| `priorityFailover` | boolean | true | Enable priority-based failover |

### Circuit Breaker Pattern

Prevents cascading failures by temporarily disabling problematic providers:

1. **Normal**: Requests flow normally
2. **Failure Detection**: Each failure increments counter
3. **Circuit Opens**: After `failureThreshold` failures
4. **Cooldown**: Requests blocked for `cooldownPeriod`
5. **Test Request**: One request allowed to test recovery
6. **Circuit Closes**: If test succeeds, normal flow resumes

### Rate Limit Tracking

Automatically tracks rate limits and avoids hitting limits repeatedly:

- Detects HTTP 429/449 responses
- Respects `Retry-After` header from providers
- Uses exponential backoff for repeated rate limits
- Redirects requests to available alternatives

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

Each instance intelligently shares the model pool, with each provider+model handling up to 2 concurrent requests (configurable).

### Request Priority

Set request priority using the `X-CCR-Priority` header:

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
- **High**: 10 (processed first)
- **Normal**: 0 (default)
- **Low**: -10 (processed last)

For detailed documentation, see [PARALLEL_EXECUTION_GUIDE.md](PARALLEL_EXECUTION_GUIDE.md).

## 🔌 OpenCode Integration

### Overview

OpenCode can be integrated with CCR's custom-model functionality for automatic model routing with intelligent failover.

### Configuration

Configure OpenCode to use CCR with custom-model:

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
        }
      }
    }
  }
}
```

### Benefits

- **Automatic routing**: OpenCode sends `model: "custom-model"` and CCR routes to Router.default
- **Intelligent failover**: Automatically switches to alternatives when primary is unavailable
- **Parallel execution**: Multiple alternatives tried simultaneously for faster recovery
- **Circuit breaker protection**: Prevents cascading failures
- **Rate limit tracking**: Exponential backoff for rate-limited providers

### How It Works

```
OpenCode → CCR (model: custom-model)
  ↓
CCR routes to Router.default (iflow,glm-4.7)
  ↓
Checks capacity via ModelPoolManager
  ↓
If unavailable → Tries failover alternatives in parallel
  ↓
Returns first successful response to OpenCode
```

### Testing

1. Restart CCR: `ccr restart`
2. Test with curl:
```bash
curl -X POST http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "custom-model",
    "messages": [{"role": "user", "content": "Hello from custom-model!"}],
    "max_tokens": 100
  }'
```
3. Use OpenCode with the iflow provider and custom-model

For detailed documentation, see [OPENCODE_CUSTOM_MODEL_INTEGRATION.md](OPENCODE_CUSTOM_MODEL_INTEGRATION.md).

## 📊 Monitoring & Observability

### API Endpoints

#### Get Model Pool Status

```bash
curl http://localhost:3456/model-pool/status
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
    "lastUsed": "2026-01-16T10:30:45.123Z"
  }
}
```

#### Get Queue Status

```bash
curl http://localhost:3456/model-pool/queue
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

```bash
curl http://localhost:3456/model-pool/config
```

Returns current model pool configuration.

#### Reset Circuit Breakers

```bash
curl -X POST http://localhost:3456/model-pool/reset-circuit-breakers
```

Resets all circuit breakers, allowing requests to flow again.

#### Clear Queue

```bash
curl -X POST http://localhost:3456/model-pool/clear-queue
```

Clears all queued requests (rejected with error).

### Web UI Monitoring

Run `ccr ui` and navigate to Model Pool Status page to:
- View active requests per model
- Monitor queue length and wait times
- Check circuit breaker status
- See rate limit status
- Reset circuit breakers if needed

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

Watch for these log messages:

```
[INFO] custom-model resolved to Router.default: iflow,glm-4.7
[INFO] Acquired slot for iflow,glm-4.7 (1/2 active)
[INFO] Request queued for iflow,glm-4.7 (queue position: 3)
[WARN] Primary model iflow,glm-4.7 is rate-limited, looking for alternative
[INFO] Using alternative model iflowX,glm-4.7 instead of iflow,glm-4.7
[INFO] Alternative iflowX,glm-4.7 succeeded
[WARN] Circuit breaker opened for iflow,glm-4.7 (5 consecutive failures)
[INFO] Circuit breaker closed for iflow,glm-4.7 (recovered after cooldown)
[INFO] Rate limit detected for iflow,glm-4.7 (retry after: 60s)
```

## 🛠️ Providers

The `Providers` array is where you define the different model providers you want to use. Each provider object requires:

- `name`: A unique name for the provider.
- `api_base_url`: The full API endpoint for chat completions.
- `api_key`: Your API key for the provider.
- `models`: A list of model names available from this provider.
- `transformer` (optional): Specifies transformers to process requests and responses.

## 🔄 Transformers

Transformers allow you to modify the request and response payloads to ensure compatibility with different provider APIs.

- **Global Transformer**: Apply a transformer to all models from a provider. In this example, the `openrouter` transformer is applied to all models under the `openrouter` provider.
  ```json
  {
    "name": "openrouter",
    "api_base_url": "https://openrouter.ai/api/v1/chat/completions",
    "api_key": "sk-xxx",
    "models": [
      "google/gemini-2.5-pro-preview",
      "anthropic/claude-sonnet-4",
      "anthropic/claude-3.5-sonnet"
    ],
    "transformer": { "use": ["openrouter"] }
  }
  ```
- **Model-Specific Transformer**: Apply a transformer to a specific model. In this example, the `deepseek` transformer is applied to all models, and an additional `tooluse` transformer is applied only to the `deepseek-chat` model.

  ```json
  {
    "name": "deepseek",
    "api_base_url": "https://api.deepseek.com/chat/completions",
    "api_key": "sk-xxx",
    "models": ["deepseek-chat", "deepseek-reasoner"],
    "transformer": {
      "use": ["deepseek"],
      "deepseek-chat": { "use": ["tooluse"] }
    }
  }
  ```

- **Passing Options to a Transformer**: Some transformers, like `maxtoken`, accept options. To pass options, use a nested array where the first element is the transformer name and the second is an options object.
  ```json
  {
    "name": "siliconflow",
    "api_base_url": "https://api.siliconflow.cn/v1/chat/completions",
    "api_key": "sk-xxx",
    "models": ["moonshotai/Kimi-K2-Instruct"],
    "transformer": {
      "use": [
        [
          "maxtoken",
          {
            "max_tokens": 16384
          }
        ]
      ]
    }
  }
  ```

**Available Built-in Transformers:**

- `Anthropic`:If you use only the `Anthropic` transformer, it will preserve the original request and response parameters(you can use it to connect directly to an Anthropic endpoint).
- `deepseek`: Adapts requests/responses for DeepSeek API.
- `gemini`: Adapts requests/responses for Gemini API.
- `openrouter`: Adapts requests/responses for OpenRouter API. It can also accept a `provider` routing parameter to specify which underlying providers OpenRouter should use. For more details, refer to the [OpenRouter documentation](https://openrouter.ai/docs/features/provider-routing). See an example below:
  ```json
    "transformer": {
      "use": ["openrouter"],
      "moonshotai/kimi-k2": {
        "use": [
          [
            "openrouter",
            {
              "provider": {
                "only": ["moonshotai/fp8"]
              }
            }
          ]
        ]
      }
    }
  ```
- `groq`: Adapts requests/responses for groq API.
- `maxtoken`: Sets a specific `max_tokens` value.
- `tooluse`: Optimizes tool usage for certain models via `tool_choice`.
- `gemini-cli` (experimental): Unofficial support for Gemini via Gemini CLI [gemini-cli.js](https://gist.github.com/musistudio/1c13a65f35916a7ab690649d3df8d1cd).
- `reasoning`: Used to process the `reasoning_content` field.
- `sampling`: Used to process sampling information fields such as `temperature`, `top_p`, `top_k`, and `repetition_penalty`.
- `enhancetool`: Adds a layer of error tolerance to the tool call parameters returned by the LLM (this will cause the tool call information to no longer be streamed).
- `cleancache`: Clears the `cache_control` field from requests.
- `vertex-gemini`: Handles the Gemini API using Vertex authentication.
- `chutes-glm` Unofficial support for GLM 4.5 model via Chutes [chutes-glm-transformer.js](https://gist.github.com/vitobotta/2be3f33722e05e8d4f9d2b0138b8c863).
- `qwen-cli` (experimental): Unofficial support for qwen3-coder-plus model via Qwen CLI [qwen-cli.js](https://gist.github.com/musistudio/f5a67841ced39912fd99e42200d5ca8b).
- `rovo-cli` (experimental): Unofficial support for gpt-5 via Atlassian Rovo Dev CLI [rovo-cli.js](https://gist.github.com/SaseQ/c2a20a38b11276537ec5332d1f7a5e53).

**Custom Transformers:**

You can also create your own transformers and load them via the `transformers` field in `config.json`.

```json
{
  "transformers": [
    {
      "path": "/User/xxx/.claude-code-router/plugins/gemini-cli.js",
      "options": {
        "project": "xxx"
      }
    }
  ]
}
```

## 🧭 Router

The `Router` object defines which model to use for different scenarios:

- `default`: The default model for general tasks. Used by custom-model.
- `background`: A model for background tasks. This can be a smaller, local model to save costs.
- `think`: A model for reasoning-heavy tasks, like Plan Mode.
- `longContext`: A model for handling long contexts (e.g., > 60K tokens).
- `longContextThreshold` (optional): The token count threshold for triggering the long context model. Defaults to 60000 if not specified.
- `webSearch`: Used for handling web search tasks and this requires the model itself to support the feature. If you're using openrouter, you need to add the `:online` suffix after the model name.
- `image` (beta): Used for handling image-related tasks (supported by CCR's built-in agent). If the model does not support tool calling, you need to set the `config.forceUseImageAgent` property to `true`.

- You can also switch models dynamically in Claude Code with the `/model` command:
`/model provider_name,model_name`
Example: `/model openrouter,anthropic/claude-3.5-sonnet`

### Custom Router

For more advanced routing logic, you can specify a custom router script via the `CUSTOM_ROUTER_PATH` in your `config.json`. This allows you to implement complex routing rules beyond the default scenarios.

In your `config.json`:

```json
{
  "CUSTOM_ROUTER_PATH": "/User/xxx/.claude-code-router/custom-router.js"
}
```

The custom router file must be a JavaScript module that exports an `async` function. This function receives the request object and the config object as arguments and should return the provider and model name as a string (e.g., `"provider_name,model_name"`), or `null` to fall back to the default router.

Here is an example of a `custom-router.js` based on `custom-router.example.js`:

```javascript
// /User/xxx/.claude-code-router/custom-router.js

/**
 * A custom router function to determine which model to use based on the request.
 *
 * @param {object} req - The request object from Claude Code, containing the request body.
 * @param {object} config - The application's config object.
 * @returns {Promise<string|null>} - A promise that resolves to the "provider,model_name" string, or null to use the default router.
 */
module.exports = async function router(req, config) {
  const userMessage = req.body.messages.find((m) => m.role === "user")?.content;

  if (userMessage && userMessage.includes("explain this code")) {
    // Use a powerful model for code explanation
    return "openrouter,anthropic/claude-3.5-sonnet";
  }

  // Fallback to the default router configuration
  return null;
};
```

### Subagent Routing

For routing within subagents, you must specify a particular provider and model by including `<CCR-SUBAGENT-MODEL>provider,model</CCR-SUBAGENT-MODEL>` at the **beginning** of the subagent's prompt. This allows you to direct specific subagent tasks to designated models.

**Example:**

```
<CCR-SUBAGENT-MODEL>openrouter,anthropic/claude-3.5-sonnet</CCR-SUBAGENT-MODEL>
Please help me analyze this code snippet for potential optimizations...
```

## 📈 Status Line (Beta)

To better monitor the status of claude-code-router at runtime, version v1.0.40 includes a built-in statusline tool, which you can enable in the UI.
![statusline-config.png](/blog/images/statusline-config.png)

The effect is as follows:
![statusline](/blog/images/statusline.png)

## 🤖 GitHub Actions

Integrate Claude Code Router into your CI/CD pipeline. After setting up [Claude Code Actions](https://docs.anthropic.com/en/docs/claude-code/github-actions), modify your `.github/workflows/claude.yaml` to use the router:

```yaml
name: Claude Code

on:
  issue_comment:
    types: [created]
  # ... other triggers

jobs:
  claude:
    if: |
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@claude')) ||
      # ... other conditions
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      issues: read
      id-token: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: Prepare Environment
        run: |
          curl -fsSL https://bun.sh/install | bash
          mkdir -p $HOME/.claude-code-router
          cat << 'EOF' > $HOME/.claude-code-router/config.json
          {
            "log": true,
            "NON_INTERACTIVE_MODE": true,
            "OPENAI_API_KEY": "${{ secrets.OPENAI_API_KEY }}",
            "OPENAI_BASE_URL": "https://api.deepseek.com",
            "OPENAI_MODEL": "deepseek-chat"
          }
          EOF
        shell: bash

      - name: Start Claude Code Router
        run: |
          nohup ~/.bun/bin/bunx @musistudio/claude-code-router@1.0.8 start &
        shell: bash

      - name: Run Claude Code
        id: claude
        uses: anthropics/claude-code-action@beta
        env:
          ANTHROPIC_BASE_URL: http://localhost:3456
        with:
          anthropic_api_key: "any-string-is-ok"
```

> **Note**: When running in GitHub Actions or other automation environments, make sure to set `"NON_INTERACTIVE_MODE": true` in your configuration to prevent the process from hanging due to stdin handling issues.

This setup allows for interesting automations, like running tasks during off-peak hours to reduce API costs.

## 📚 Further Reading

- [Project Motivation and How It Works](blog/en/project-motivation-and-how-it-works.md)
- [Maybe We Can Do More with the Router](blog/en/maybe-we-can-do-more-with-the-route.md)
- [GLM-4.6 Supports Reasoning and Interleaved Thinking](blog/en/glm-4.6-supports-reasoning.md)
- [Custom-Model Implementation Guide](CUSTOM_MODEL_GUIDE.md)
- [Custom-Model Implementation Summary](CUSTOM_MODEL_IMPLEMENTATION_SUMMARY.md)
- [Parallel Execution Guide](PARALLEL_EXECUTION_GUIDE.md)
- [OpenCode Integration Guide](OPENCODE_CUSTOM_MODEL_INTEGRATION.md)

## ❤️ Support & Sponsoring

If you find this project helpful, please consider sponsoring its development. Your support is greatly appreciated!

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/F1F31GN2GM)

[Paypal](https://paypal.me/musistudio1999)

<table>
  <tr>
    <td><img src="/blog/images/alipay.jpg" width="200" alt="Alipay" /></td>
    <td><img src="/blog/images/wechat.jpg" width="200" alt="WeChat Pay" /></td>
  </tr>
</table>

### Our Sponsors

A huge thank you to all our sponsors for their generous support!

- [AIHubmix](https://aihubmix.com/)
- [BurnCloud](https://ai.burncloud.com)
- [302.AI](https://share.302.ai/ZGVF9w)
- [Z智谱](https://www.bigmodel.cn/claude-code?ic=FPF9IVAGFJ)
- @Simon Leischnig
- [@duanshuaimin](https://github.com/duanshuaimin)
- [@vrgitadmin](https://github.com/vrgitadmin)
- @\*o
- [@ceilwoo](https://github.com/ceilwoo)
- @\*说
- @\*更
- @K\*g
- @R\*R
- [@bobleer](https://github.com/bobleer)
- @\*苗
- @\*划
- [@Clarence-pan](https://github.com/Clarence-pan)
- [@carter003](https://github.com/carter003)
- @S\*r
- @\*晖
- @\*敏
- @Z\*z
- @\*然
- [@cluic](https://github.com/cluic)
- @\*苗
- [@PromptExpert](https://github.com/PromptExpert)
- @\*应
- [@yusnake](https://github.com/yusnake)
- @\*飞
- @董\*
- @\*汀
- @\*涯
- @\*:-）
- @\*\*磊
- @\*琢
- @\*成
- @Z\*o
- @\*琨
- [@congzhangzh](https://github.com/congzhangzh)
- @\*\_
- @Z\*m
- @*鑫
- @c\*y
- @\*昕
- [@witsice](https://github.com/witsice)
- @b\*g
- @\*亿
- @\*辉
- @JACK
- @\*光
- @W\*l
- [@kesku](https://github.com/kesku)
- [@biguncle](https://github.com/biguncle)
- @二吉吉
- @a\*g
- @\*林
- @\*咸
- @\*明
- @S\*y
- @f\*o
- @\*智
- @F\*t
- @r\*c
- [@qierkang](http://github.com/qierkang)
- @\*军
- [@snrise-z](http://github.com/snrise-z)
- @\*王
- [@greatheart1000](http://github.com/greatheart1000)
- @\*王
- @zcutlip
- [@Peng-YM](http://github.com/Peng-YM)
- @\*更
- @\*.
- @F\*t
- @\*政
- @\*铭
- @\*叶
- @七\*o
- @\*青
- @\*\*晨
- @\*远
- @\*霄
- @\*\*吉
- @\*\*飞
- @\*\*驰
- @x\*g
- @\*\*东
- @\*落
- @哆\*k
- @\*涛
- [@苗大](https://github.com/WitMiao)
- @\*呢
- @\\d*u
- @crizcraig
- s\*s
- \\*火
- \\*勤
- \\*\*锟
- \\*涛
- \\*\*明
- \\*知
- \\*语
- \\*瓜

(If your name is masked, please contact me via my homepage email to update it with your GitHub username.)
