![](blog/images/claude-code-router-img.png)

[![](https://img.shields.io/badge/%F0%9F%87%A8%F0%9F%87%B3-%E4%B8%AD%E6%96%87%E7%89%88-ff0000?style=flat)](README_zh.md)
[![Discord](https://img.shields.io/badge/Discord-%235865F2.svg?&logo=discord&logoColor=white)](https://discord.gg/rdftVMaUcS)
[![](https://img.shields.io/github/license/musistudio/claude-code-router)](https://github.com/musistudio/claude-code-router/blob/main/LICENSE)

<hr>

> A powerful tool to route Claude Code requests to different models and customize any request.

![](blog/images/claude-code.png)

## 🍴 About This Fork

This is a fork of [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) by **[ishan-parihar](https://github.com/ishan-parihar)**.

### What's New in This Fork

This fork adds significant enhancements to the original project:

#### 🎯 Custom-Model Feature
- **Automatic model routing** without explicit provider specification
- Use `model: "custom-model"` to let CCR intelligently route to your configured default model
- Enables seamless integration with tools like OpenCode

#### ⚡ Intelligent Failover with Parallel Execution
- **Automatic provider switching** on rate limits, capacity limits, or failures
- **Parallel execution** of alternatives - 60-70% faster than sequential retry
- Configurable failover chains with provider-specific and global fallbacks

#### 🏊 Model Pool Management
- **Concurrent request management** with configurable capacity limits
- **Circuit breaker pattern** to prevent cascading failures
- **Rate limit tracking** with exponential backoff
- **Priority-based request queuing**

#### 📊 Enhanced Monitoring
- Real-time model pool status via API and Web UI
- Queue monitoring and management
- Circuit breaker controls
- Comprehensive metrics and logging

#### 🔌 OpenCode Integration
- Complete integration guide for OpenCode service
- Custom-model support for automatic routing
- Failover and parallel execution for improved reliability

---

## 🚀 Quick Start

### Installation

```shell
npm install -g @musistudio/claude-code-router
```

### Basic Configuration

Create `~/.claude-code-router/config.json`:

```json
{
  "Providers": [
    {
      "name": "iflow",
      "api_base_url": "https://apis.iflow.cn/v1/chat/completions",
      "api_key": "your-api-key",
      "models": ["glm-4.6", "glm-4.7"]
    }
  ],
  "Router": {
    "default": "iflow,glm-4.7",
    "background": "iflow,glm-4.6",
    "think": "iflow,glm-4.7"
  }
}
```

### Start the Router

```shell
ccr start
```

### Run Claude Code

```shell
ccr code
```

### Configuration UI

```shell
ccr ui
```

---

## ✨ New Features

### Custom-Model

Use automatic routing without specifying providers:

```bash
curl -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "custom-model",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

**Benefits:**
- Automatic routing to `Router.default`
- Intelligent failover when primary is unavailable
- Parallel execution of alternatives
- Perfect for integrations (OpenCode, Agent SDK)

**When to use:**
- ✅ Want automatic routing with failover
- ✅ Building integrations with tools
- ✅ Don't want to manage provider,model strings

**When NOT to use:**
- ❌ Need scenario-specific models (think, longContext, etc.)
- ❌ Want direct control over provider/model

### Intelligent Failover

Configure failover at the root level of `config.json`:

```json
{
  "failover": {
    "iflow": [
      "iflow-backup",
      { "provider": "openai", "model": "gpt-4" }
    ],
    "global": ["backup-provider"]
  }
}
```

**Triggers:**
- Rate limits (HTTP 429, 449)
- Circuit breaker open
- Model at capacity
- Provider errors (502, 503)

**Important:** Failover is **only enabled for custom-model** (default scenario). Other scenarios (think, longContext, background, webSearch) queue without failover.

### Parallel Execution

Multiple alternatives tried simultaneously:

```
Request → Primary (fails)
         → Alternative A & B & C (parallel)
         → First success wins (10s vs 30s sequential)
```

### Model Pool Management

```json
{
  "modelPool": {
    "maxConcurrentPerModel": 2,
    "circuitBreaker": {
      "failureThreshold": 5,
      "cooldownPeriod": 60000
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

**Features:**
- Run multiple `ccr code` instances simultaneously
- Each provider+model handles up to 2 concurrent requests
- Priority-based queuing
- Circuit breaker protection
- Rate limit tracking with exponential backoff

---

## 📊 Monitoring

### API Endpoints

```bash
# Model pool status
curl http://localhost:3456/model-pool/status

# Queue status
curl http://localhost:3456/model-pool/queue

# Reset circuit breakers
curl -X POST http://localhost:3456/model-pool/reset-circuit-breakers

# Clear queue
curl -X POST http://localhost:3456/model-pool/clear-queue
```

### Web UI

Run `ccr ui` to access:
- Model pool status dashboard
- Queue monitoring
- Circuit breaker controls
- Configuration management

### Key Metrics

Monitor:
- Active requests per model
- Queue length and wait times
- Circuit breaker status
- Rate limit status
- Success rates
- Failover rate

---

## 🔌 OpenCode Integration

Configure OpenCode to use CCR with custom-model:

```json
{
  "model": "iflow/custom-model",
  "provider": {
    "iflow": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "CCR with Custom-Model",
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
        }
      }
    }
  }
}
```

**Benefits:**
- Automatic routing to Router.default
- Intelligent failover when primary unavailable
- Parallel execution for faster recovery
- Circuit breaker protection

See [OPENCODE_CUSTOM_MODEL_INTEGRATION.md](OPENCODE_CUSTOM_MODEL_INTEGRATION.md) for details.

---

## 📚 Documentation

### Original Documentation

- [Project Motivation and How It Works](blog/en/project-motivation-and-how-it-works.md)
- [Maybe We Can Do More with the Router](blog/en/maybe-we-can-do-more-with-the-route.md)
- [GLM-4.6 Supports Reasoning and Interleaved Thinking](blog/en/glm-4.6-supports-reasoning.md)

---

## 🔧 Advanced Configuration

### Model Pool Management

The model pool system manages concurrent requests, rate limits, and circuit breakers:

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

**Features:**
- Run multiple `ccr code` instances simultaneously
- Each provider+model handles up to 2 concurrent requests (configurable)
- Priority-based queuing with configurable levels
- Circuit breaker protection to prevent cascading failures
- Rate limit tracking with exponential backoff
- Automatic queue processing when slots become available

### Model Selector Configuration

The model selector intelligently chooses the best model based on health, capacity, and performance:

```json
{
  "modelSelector": {
    "enableProactiveFailover": true,
    "enableHealthBasedRouting": true,
    "enablePerformanceBasedRouting": false,
    "preferHealthyModels": true,
    "maxParallelAlternatives": 3,
    "scoreWeights": {
      "capacity": 0.4,
      "health": 0.3,
      "performance": 0.2,
      "priority": 0.1
    }
  }
}
```

**Scoring Algorithm:**
- **Capacity** (40%): Available slots for concurrent requests
- **Health** (30%): Success rate and circuit breaker status
- **Performance** (20%): Response time metrics
- **Priority** (10%): Request priority level

### Request Priority

Set request priority using the `x-ccr-priority` header:

```bash
curl -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-ccr-priority: high" \
  -d '{
    "model": "custom-model",
    "messages": [{"role": "user", "content": "Urgent request"}]
  }'
```

**Priority Levels:**
- `high`: +10 score, processed first
- `normal`: 0 score, default processing
- `low`: -10 score, processed last

---

## 🐛 Troubleshooting

### Common Issues

**Service fails to start:**
```bash
# Check logs
cat ~/.claude-code-router/claude-code-router.log

# Check server logs
cat ~/.claude-code-router/logs/ccr-*.log

# Verify configuration
ccr model test
```

**Rate limit errors:**
- Model pool automatically handles rate limits with exponential backoff
- Configure `modelPool.rateLimit` to adjust retry behavior
- Use failover to switch to alternative providers

**Circuit breaker open:**
- Circuit breaker opens after `failureThreshold` consecutive failures
- Waits `cooldownPeriod` before testing again
- Reset manually: `curl -X POST http://localhost:3456/model-pool/reset-circuit-breakers`

**Queue full:**
- Increase `modelPool.queue.maxQueueSize`
- Reduce request rate
- Add more providers/models

---

## 🚀 Systemd Service

### Setup

Create `~/.config/systemd/user/ccr.service`:

```ini
[Unit]
Description=Claude Code Router Service
After=network.target

[Service]
Type=forking
PIDFile=%h/.claude-code-router/.claude-code-router.pid
WorkingDirectory=%h/claude-code-router
ExecStart=%h/.npm-global/bin/ccr start
ExecStop=%h/.npm-global/bin/ccr stop
ExecReload=%h/.npm-global/bin/ccr restart
Restart=always
RestartSec=10
StartLimitInterval=60
StartLimitBurst=3

# Resource limits
LimitNOFILE=65536
MemoryMax=2G

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ccr
```

### Usage

```bash
# Reload systemd configuration
systemctl --user daemon-reload

# Enable autostart (starts on login)
systemctl --user enable ccr

# Start service immediately
systemctl --user start ccr

# Check status
systemctl --user status ccr

# View logs
journalctl --user -u ccr -f

# Stop service
systemctl --user stop ccr

# Restart service
systemctl --user restart ccr
```

### Benefits

- ✅ Automatic restart on crash
- ✅ Process health monitoring
- ✅ Log aggregation via journald
- ✅ Resource limits (memory, file descriptors)
- ✅ Clean shutdown on signal
- ✅ Startup ordering (after network)

---

## 🔄 Request Lifecycle

### Flow Diagram

```
Request
  ↓
[Request Tracker] - Generate unique request ID
  ↓
[Router] - Determine routing scenario
  ↓
[Model Selector] - Select best model
  ↓
[Model Pool] - Reserve slot or enqueue
  ↓
[Execute] - Send request to provider
  ↓
[Response]
  ↓
[Release Slot] - Trigger queue processing
  ↓
[Request Tracker] - Record metrics
```

### Logging

Each request generates structured logs:

```
[RequestTracker] Request started (requestId: xxx, sessionId: xxx, priority: 0)
[RequestTracker] Stage started: routing (requestId: xxx)
[RequestTracker] Routing completed (requestId: xxx, provider: xxx, model: xxx, routingTime: 5ms)
[RequestTracker] Slot reservation (requestId: xxx, provider: xxx, model: xxx, immediate: true, reserved: true)
[RequestTracker] API call started (requestId: xxx, provider: xxx, model: xxx)
[RequestTracker] API call completed (requestId: xxx, provider: xxx, model: xxx, success: true, duration: 1500ms)
[RequestTracker] Request completed (requestId: xxx, success: true, totalTime: 1510ms)
```

---

## 📊 Performance Metrics

### Monitoring Endpoints

```bash
# Model pool status
curl http://localhost:3456/model-pool/status

# Queue status
curl http://localhost:3456/model-pool/queue

# Model selector configuration
curl http://localhost:3456/model-selector/config
```

### Key Metrics

- **Active requests**: Current concurrent requests per model
- **Queue length**: Number of pending requests
- **Queue wait time**: Average time in queue
- **Circuit breaker status**: Open/closed state per model
- **Rate limit status**: Cooldown periods
- **Success rate**: Per-model success percentage
- **Response time**: Average response time
- **Failover rate**: Percentage of requests that failed over

---

## 🎯 Implementation Details

### Parallel Execution

**Reactive vs Proactive:**

**Reactive (Old):**
```
Request → Primary (fails after 10s)
         → Alternative A (10s)
         → Alternative B (10s)
Total: 30s
```

**Proactive (New):**
```
Request → Primary + Alternative A + B (parallel)
         → First success wins (10s)
Total: 10s (67% faster)
```

### Failover Logic

Failover is **only enabled for custom-model** (default scenario):

- ✅ **custom-model**: Intelligent failover with parallel execution
- ❌ **think**: Queues without failover (thinking-intensive)
- ❌ **longContext**: Queues without failover (requires specific model)
- ❌ **background**: Queues without failover (lightweight tasks)
- ❌ **webSearch**: Queues without failover (requires specific capabilities)
- ❌ **image**: Queues without failover (requires image support)

This design ensures scenario-specific models are always used, while custom-model benefits from intelligent failover.

### Circuit Breaker Pattern

The circuit breaker prevents cascading failures:

1. **Closed**: Normal operation, requests go through
2. **Open**: After `failureThreshold` failures, rejects requests
3. **Half-Open**: After `cooldownPeriod`, allows test request
4. **Back to Closed**: If test succeeds, closes circuit
5. **Back to Open**: If test fails, stays open

**Configuration:**
```json
{
  "circuitBreaker": {
    "failureThreshold": 5,
    "cooldownPeriod": 60000,
    "testRequestAfterCooldown": true
  }
}
```

### Rate Limit Handling

The system handles rate limits intelligently:

1. **Detects rate limit errors** (HTTP 429, 449, 439)
2. **Parses Retry-After header** if available
3. **Applies exponential backoff** with configurable multiplier
4. **Skips rate-limited models** in selection
5. **Respects provider-specific limits**

**Configuration:**
```json
{
  "rateLimit": {
    "defaultRetryAfter": 60000,
    "respectRetryAfterHeader": true,
    "backoffMultiplier": 1.5,
    "maxBackoff": 300000
  }
}
```

---

## 🔒 Security Best Practices

1. **Never commit config.json** with API keys
2. **Use environment variables** for sensitive data: `$API_KEY`
3. **Set APIKEY** in config.json to protect your endpoint
4. **Use strong API keys** (32+ characters)
5. **Regularly rotate API keys**
6. **Monitor access logs** for unauthorized requests
7. **Use HTTPS** for production deployments

---

## 🛠️ Configuration Reference

### Complete Configuration Example

```json
{
  "LOG": true,
  "LOG_LEVEL": "debug",
  "CLAUDE_PATH": "",
  "HOST": "127.0.0.1",
  "PORT": 3456,
  "APIKEY": "your-secret-key",
  "API_TIMEOUT_MS": 600000,
  "PROXY_URL": "",
  "transformers": [],
  "Providers": [
    {
      "name": "iflow",
      "api_base_url": "https://apis.iflow.cn/v1/chat/completions",
      "api_key": "your-api-key",
      "models": ["glm-4.6", "glm-4.7"],
      "headers": {
        "User-Agent": "iFlow-Cli",
        "X-Client-Type": "iflow-cli",
        "X-Client-Version": "0.3.26"
      }
    },
    {
      "name": "iflow-backup",
      "api_base_url": "https://apis.iflow-backup.com/v1/chat/completions",
      "api_key": "your-api-key",
      "models": ["glm-4.6", "glm-4.7"]
    }
  ],
  "Router": {
    "default": "iflow,glm-4.7",
    "background": "iflow,glm-4.6",
    "think": "iflow,glm-4.7",
    "longContext": "iflow,glm-4.7",
    "longContextThreshold": 60000,
    "webSearch": "iflow,glm-4.7",
    "image": "iflow-backup,glm-4.7"
  },
  "failover": {
    "iflow": ["iflow-backup"],
    "iflow-backup": ["iflow"],
    "global": ["iflow-backup"]
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
  },
  "modelSelector": {
    "enableProactiveFailover": true,
    "enableHealthBasedRouting": true,
    "enablePerformanceBasedRouting": false,
    "preferHealthyModels": true,
    "maxParallelAlternatives": 3,
    "scoreWeights": {
      "capacity": 0.4,
      "health": 0.3,
      "performance": 0.2,
      "priority": 0.1
    }
  },
  "StatusLine": {
    "enabled": false,
    "currentStyle": "default",
    "default": {
      "modules": []
    },
    "powerline": {
      "modules": []
    }
  }
}
```

### Configuration Options

**Basic Settings:**
- `LOG`: Enable logging (boolean)
- `LOG_LEVEL`: Log level (fatal/error/warn/info/debug/trace)
- `HOST`: Server host address (default: 127.0.0.1)
- `PORT`: Server port (default: 3456)
- `APIKEY`: API key for authentication (optional)
- `API_TIMEOUT_MS`: API request timeout in milliseconds (default: 600000)
- `PROXY_URL`: Proxy URL for outgoing requests (optional)

**Providers:**
- `name`: Unique provider identifier
- `api_base_url`: API endpoint URL
- `api_key`: API key for the provider
- `models`: List of available models
- `headers`: Custom headers (optional)

**Router:**
- `default`: Default provider,model for custom-model
- `background`: Model for background tasks
- `think`: Model for thinking-intensive tasks
- `longContext`: Model for long context requests
- `longContextThreshold`: Token threshold (default: 60000)
- `webSearch`: Model for web search tasks
- `image`: Model for image-related tasks

**Failover:**
- Provider-specific failover chains
- `global`: Global fallback providers

**Model Pool:**
- `maxConcurrentPerModel`: Max concurrent requests per provider+model
- `circuitBreaker`: Circuit breaker configuration
- `rateLimit`: Rate limit handling configuration
- `queue`: Queue configuration
- `priorityFailover`: Enable priority-based failover

**Model Selector:**
- `enableProactiveFailover`: Enable proactive parallel execution
- `enableHealthBasedRouting`: Consider model health in selection
- `enablePerformanceBasedRouting`: Consider response time in selection
- `preferHealthyModels`: Prioritize healthy models
- `maxParallelAlternatives`: Max parallel alternatives
- `scoreWeights`: Scoring algorithm weights

---

## 📜 Scripts

 Included helper scripts for development and deployment:

### Build Scripts
- `scripts/build-cli.js`: Build CLI package
- `scripts/build-core.js`: Build core package
- `scripts/build-server.js`: Build server package
- `scripts/build-shared.js`: Build shared package

### Setup Scripts
- `setup-systemd.sh`: Setup systemd service for automatic restarts

### Usage

```bash
# Build all packages
pnpm build

# Build individual packages
pnpm build:cli
pnpm build:server
pnpm build:shared

# Setup systemd service
./setup-systemd.sh
```

---

## 🔧 CLI Commands

```bash
# Service management
ccr start        # Start the router service
ccr stop         # Stop the router service
ccr restart      # Restart the router service
ccr status       # Show service status

# Run Claude Code
ccr code         # Run Claude Code with router

# Model management
ccr model        # Interactive model selector

# Preset management
ccr preset export <name>      # Export current config as preset
ccr preset install <source>   # Install a preset
ccr preset list               # List installed presets
ccr preset info <name>        # Show preset info
ccr preset delete <name>      # Delete a preset

# Environment setup
eval "$(ccr activate)"        # Set environment variables for direct claude command

# UI
ccr ui           # Open web configuration interface
```

---

## 🎯 Key Differences from Original

| Feature | Original | This Fork |
|---------|----------|-----------|
| Custom-Model | ❌ No | ✅ Automatic routing with failover |
| Failover | ❌ No | ✅ Intelligent failover with parallel execution |
| Model Pool | ❌ No | ✅ Concurrent request management |
| Circuit Breaker | ❌ No | ✅ Prevents cascading failures |
| Rate Limit Tracking | ❌ No | ✅ Exponential backoff |
| Request Queuing | ❌ No | ✅ Priority-based queuing |
| Parallel Execution | ❌ No | ✅ 60-70% faster failover |
| Monitoring API | ❌ Limited | ✅ Comprehensive endpoints |
| OpenCode Integration | ❌ No | ✅ Complete guide |
| Failover Scope | N/A | ✅ Only for custom-model (intentional) |

---

## 🤝 Contributing

This is a personal fork. For contributing to the original project, please visit:
https://github.com/musistudio/claude-code-router

---

## 📄 License

[MIT License](https://github.com/musistudio/claude-code-router/blob/main/LICENSE)

---

## ❤️ Support Original Project

The original project by [musistudio](https://github.com/musistudio) provides the foundation for this fork. Please consider supporting the original development:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/F1F31GN2GM)

[Paypal](https://paypal.me/musistudio1999)
