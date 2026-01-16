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

### New Documentation (This Fork)

- [CUSTOM_MODEL_GUIDE.md](CUSTOM_MODEL_GUIDE.md) - Complete custom-model guide
- [CUSTOM_MODEL_IMPLEMENTATION_SUMMARY.md](CUSTOM_MODEL_IMPLEMENTATION_SUMMARY.md) - Implementation details
- [OPENCODE_CUSTOM_MODEL_INTEGRATION.md](OPENCODE_CUSTOM_MODEL_INTEGRATION.md) - OpenCode integration
- [PARALLEL_EXECUTION_GUIDE.md](PARALLEL_EXECUTION_GUIDE.md) - Parallel execution and failover

### Original Documentation

- [Project Motivation and How It Works](blog/en/project-motivation-and-how-it-works.md)
- [Maybe We Can Do More with the Router](blog/en/maybe-we-can-do-more-with-the-route.md)
- [GLM-4.6 Supports Reasoning and Interleaved Thinking](blog/en/glm-4.6-supports-reasoning.md)

---

## 🛠️ Configuration Reference

### Complete Configuration Example

```json
{
  "LOG": true,
  "LOG_LEVEL": "debug",
  "HOST": "127.0.0.1",
  "PORT": 3456,
  "APIKEY": "your-secret-key",
  "API_TIMEOUT_MS": 600000,
  "Providers": [
    {
      "name": "iflow",
      "api_base_url": "https://apis.iflow.cn/v1/chat/completions",
      "api_key": "key-1",
      "models": ["glm-4.6", "glm-4.7"]
    },
    {
      "name": "iflow-backup",
      "api_base_url": "https://apis.iflow-backup.com/v1/chat/completions",
      "api_key": "key-2",
      "models": ["glm-4.6", "glm-4.7"]
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
      }
    },
    "priorityFailover": true
  }
}
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
