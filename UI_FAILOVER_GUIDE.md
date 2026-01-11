# CCR UI Failover Configuration Guide

## Overview

The CCR UI now supports configuring multi-instance failover through a visual interface. This allows you to set up automatic model switching when rate limits (HTTP 429) or server errors (503, 502) occur.

## Features

### 1. Failover Configuration Section
- Located in the Router tab
- Collapsible accordion-style interface
- Shows description of failover behavior

### 2. Failover Instance Management
- **Add instances**: Select any available provider/model combination
- **Remove instances**: Click trash icon to delete
- **Reorder instances**: Use up/down arrows to change priority
- **Visual display**: Shows provider and model name in badges

### 3. Failover Behavior
When configured, CCR will:
1. Try the primary model (configured in Router settings)
2. If HTTP 429, 503, or 502 error occurs
3. Automatically switch to the first failover instance
4. Continue through the list if all failover instances fail
5. Return error if all models fail

## Configuration Example

### Via UI
1. Open CCR UI
2. Navigate to Router tab
3. Scroll to bottom
4. Click "▶ Failover Configuration" to expand
5. Click the combobox and select a provider/model
6. Repeat to add multiple failover instances
7. Use up/down arrows to reorder as needed
8. Save configuration

### Resulting Config
```json
{
  "Router": {
    "default": "openai,gpt-4",
    "background": "openai,gpt-3.5-turbo",
    "failover": [
      { "provider": "anthropic", "model": "claude-3-opus" },
      { "provider": "openai", "model": "gpt-4-turbo" },
      { "provider": "deepseek", "model": "deepseek-chat" }
    ]
  }
}
```

## UI Components

### FailoverConfig Component
**Location**: `packages/ui/src/components/FailoverConfig.tsx`

**Props**:
- `failover`: Array of FailoverInstance objects
- `providers`: Array of available Provider objects
- `onChange`: Callback function when failover list changes

**Features**:
- Dynamic model option generation from providers
- Drag-free reordering with button controls
- Visual badges for each instance
- Empty state with helpful message

### Router Integration
**Location**: `packages/ui/src/components/Router.tsx`

**Changes**:
- Added `useState` for collapsible section
- Integrated `FailoverConfig` component
- Added `handleFailoverChange` for state management
- Styled with border separator and collapsible header

## Internationalization

### English (en.json)
```json
{
  "router": {
    "failover_config": "Failover Configuration",
    "failover_instances": "Failover Instances",
    "failover_description": "When the primary model encounters errors (HTTP 429, 503, 502), CCR will automatically switch to the next model in this list. Models are tried in order from top to bottom.",
    "add_failover_instance": "Add failover instance...",
    "no_failover_instances": "No failover instances configured"
  }
}
```

### Chinese (zh.json)
```json
{
  "router": {
    "failover_config": "故障转移配置",
    "failover_instances": "故障转移实例",
    "failover_description": "当主模型遇到错误（HTTP 429、503、502）时，CCR 将自动切换到此列表中的下一个模型。模型按从上到下的顺序尝试。",
    "add_failover_instance": "添加故障转移实例...",
    "no_failover_instances": "未配置故障转移实例"
  }
}
```

## Testing

### Build Test
```bash
cd /home/ishanp/claude-code-router/packages/ui
bun run build
```

Expected output:
```
✓ built in 2.84s
```

### Manual UI Test
1. Start CCR UI: `ccr ui`
2. Login with API key
3. Navigate to Router tab
4. Expand "Failover Configuration"
5. Add a failover instance
6. Reorder instances
7. Remove an instance
8. Save configuration
9. Verify config.json contains failover array

## Future Enhancements

Potential improvements:
- [ ] Drag-and-drop reordering
- [ ] Visual indicator of active failover in logs
- [ ] Failover statistics dashboard
- [ ] Test failover button to simulate errors
- [ ] Per-route failover configuration
- [ ] Export/import failover configurations

## Technical Details

### Type Definitions
```typescript
export interface FailoverInstance {
  provider: string;
  model: string;
}

export interface RouterConfig {
  // ... existing fields
  failover?: FailoverInstance[];
}
```

### State Management
- Uses React hooks (`useState`) for local UI state
- Config changes propagate through `ConfigProvider`
- Failover array stored in `Router.failover` config field

### Backend Integration
The UI writes to the same `Router.failover` configuration that the backend reads. The backend implementation (in `packages/core/src/api/routes.ts`) automatically uses this configuration when the `handleFallback` function is triggered.

## Troubleshooting

### Issue: Failover instances not showing
**Solution**: Ensure providers are configured with models before adding failover instances

### Issue: Changes not persisting
**Solution**: Click "Save" button in the UI after modifying failover configuration

### Issue: Failover not triggering
**Solution**: Verify you're experiencing HTTP 429, 503, or 502 errors. Check logs for error details

## Related Documentation

- [Multi-Instance Guide](./MULTI_INSTANCE_GUIDE.md) - Backend implementation details
- [Config Example](./config.example.json) - Sample configuration with failover
- [CLAUDE.md](./CLAUDE.md) - General project documentation
