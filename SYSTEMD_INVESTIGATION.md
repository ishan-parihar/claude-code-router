# CCR Systemd Service Investigation Summary

## Problem Statement

Implemented a systemd user service for CCR with auto-restart capabilities, but the service fails to start with exit code 1 (FAILURE).

## Current Status

### Service Configuration
**File**: `~/.config/systemd/user/ccr.service`

```ini
[Unit]
Description=Claude Code Router Service
Documentation=https://github.com/your-repo/claude-code-router
After=network.target

[Service]
Type=forking
PIDFile=%h/.claude-code-router/.claude-code-router.pid
WorkingDirectory=%h/claude-code-router
ExecStart=/home/ishanp/.npm-global/bin/ccr start
ExecStop=/home/ishanp/.npm-global/bin/ccr stop
ExecReload=/home/ishanp/.npm-global/bin/ccr restart
Restart=always
RestartSec=10
StartLimitInterval=60
StartLimitBurst=3

# Environment
Environment=NODE_ENV=production
Environment=NODE_PATH=/home/linuxbrew/.linuxbrew/Cellar/node/25.5.0/lib/node_modules
Environment=PATH=/home/linuxbrew/.linuxbrew/Cellar/node/25.5.0/bin:/home/linuxbrew/.linuxbrew/bin:/home/ishanp/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

# Resource limits
LimitNOFILE=65536
MemoryMax=2G

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ccr
```

### Error Analysis

**Systemd Logs**:
```
Feb 04 19:26:26 cachyos-x8664 ccr[517799]: Loaded JSON config from: /home/ishanp/.claude-code-router/config.json
Feb 04 19:26:27 cachyos-x8664 systemd[950]: ccr.service: Control process exited, code=exited, status=1/FAILURE
```

**Key Observations**:
1. ✅ Config file loads successfully
2. ✅ Environment variables are set correctly
3. ❌ Process exits with status 1
4. ❌ PID file is created but process doesn't stay running

### Root Cause Analysis

The issue is with the **Type=forking** configuration and how `ccr start` behaves:

1. **Current CCR Start Behavior**:
   - `ccr start` calls `run()` function
   - `run()` checks if service is already running
   - If not running, it starts the server and writes PID file
   - The process stays in foreground (doesn't detach)

2. **Systemd Type=forking Expectation**:
   - Expects the process to fork into background
   - Parent process should exit cleanly
   - Child process should continue running
   - PID file should be created by the parent before exiting

3. **The Mismatch**:
   - `ccr start` doesn't properly fork when called by systemd
   - The process exits immediately instead of staying daemonized
   - Systemd sees this as a failure

### Manual vs Systemd Behavior

**Manual Start** (Works):
```bash
$ ccr start
Loaded JSON config from: /home/ishanp/.claude-code-router/config.json
# Process continues running in background
```

**Systemd Start** (Fails):
```bash
$ systemctl --user start ccr
# Process exits with status 1
```

## Investigation Findings

### 1. CCR Process Management
- **PID File**: `~/.claude-code-router/.claude-code-router.pid`
- **Start Command**: `ccr start`
- **Status Check**: Uses PID file + `process.kill(pid, 0)`
- **Stop Command**: Reads PID file and kills process

### 2. Code Analysis
From `packages/cli/src/utils/index.ts`:
```typescript
export const run = async (args: string[] = []) => {
  const isRunning = isServiceRunning()
  if (isRunning) {
    console.log('claude-code-router server is running');
    return;
  }
  const server = await getServer();
  const app = server.app;
  // Save the PID of the background process
  writeFileSync(PID_FILE, process.pid.toString());

  // ... server setup ...

  // await server.start() to ensure it starts successfully and keep process alive
  await server.start();
}
```

The `run()` function:
- Writes the PID file
- Starts the server
- Keeps the process alive (doesn't fork)

### 3. Desktop Autostart Comparison
The desktop autostart file works because:
```ini
Exec=/home/ishanp/.npm-global/bin/ccr restart
```
- `ccr restart` spawns the process in background using `spawn()` with `detached: true`
- This creates a proper daemonized process

## Potential Solutions

### Option 1: Use Type=simple (Easiest)
Change service type from `forking` to `simple`:

```ini
[Service]
Type=simple
# Remove PIDFile directive
ExecStart=/home/ishanp/.npm-global/bin/ccr start
ExecStop=/home/ishanp/.npm-global/bin/ccr stop
```

**Pros**:
- No code changes required
- Simple configuration
- Works with current CCR implementation

**Cons**:
- Systemd tracks the main process directly
- Less traditional for daemon services
- Manual `ccr stop` might cause issues

### Option 2: Modify ExecStart to Use Background Spawn
Change ExecStart to properly spawn in background:

```ini
[Service]
Type=forking
ExecStart=/bin/sh -c 'nohup /home/ishanp/.npm-global/bin/ccr start > /dev/null 2>&1 &'
```

**Pros**:
- Uses Type=forking as intended
- Properly daemonizes the process
- No code changes required

**Cons**:
- Uses shell wrapper
- May have signal handling issues

### Option 3: Add Daemon Mode to CCR (Best Long-term)
Modify CCR to support proper daemonization:

```typescript
// Add --daemon flag
if (process.argv.includes('--daemon')) {
  const child = spawn('node', [cliPath, 'start'], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  process.exit(0);
}
```

Then update service:
```ini
ExecStart=/home/ishanp/.npm-global/bin/ccr start --daemon
```

**Pros**:
- Clean implementation
- Proper signal handling
- Follows best practices
- Works with Type=forking

**Cons**:
- Requires code changes
- More complex implementation

### Option 4: Use Wrapper Script
Create a wrapper script that properly daemonizes:

```bash
#!/bin/bash
# /home/ishanp/.npm-global/bin/ccr-daemon
nohup /home/ishanp/.npm-global/bin/ccr start > /tmp/ccr.log 2>&1 &
echo $! > ~/.claude-code-router/.claude-code-router.pid
```

Service:
```ini
ExecStart=/home/ishanp/.npm-global/bin/ccr-daemon
```

**Pros**:
- No CCR code changes
- Works immediately
- Easy to test

**Cons**:
- Additional file to maintain
- Shell dependency

## Recommended Solution

**Phase 1: Quick Fix (Option 1)**
Change to Type=simple to get it working immediately:

```ini
[Service]
Type=simple
ExecStart=/home/ishanp/.npm-global/bin/ccr start
ExecStop=/home/ishanp/.npm-global/bin/ccr stop
```

**Phase 2: Proper Implementation (Option 3)**
Add daemon mode to CCR for better integration:

1. Add `--daemon` flag to CCR
2. Implement proper forking logic
3. Update service to use daemon mode
4. Test thoroughly

## Testing Plan

### Phase 1 Testing
1. Update service to Type=simple
2. Reload systemd: `systemctl --user daemon-reload`
3. Start service: `systemctl --user start ccr`
4. Check status: `systemctl --user status ccr`
5. Test auto-restart: Kill process and verify restart
6. Check logs: `journalctl --user -u ccr -f`

### Phase 2 Testing
1. Implement daemon mode in CCR
2. Update service configuration
3. Test all scenarios:
   - Normal start/stop
   - Auto-restart
   - System reboot
   - Manual `ccr` commands
4. Verify signal handling
5. Check resource limits

## Files Created

1. **Service File**: `~/.config/systemd/user/ccr.service`
2. **Documentation**: `SYSTEMD_IMPLEMENTATION.md`
3. **Setup Script**: `setup-systemd.sh`
4. **Investigation Summary**: `SYSTEMD_INVESTIGATION.md` (this file)

## Next Steps

1. **Immediate**: Implement Option 1 (Type=simple) to get basic functionality
2. **Short-term**: Test auto-restart with Type=simple
3. **Medium-term**: Implement Option 3 (daemon mode) for proper integration
4. **Long-term**: Add health checks and monitoring

## Conclusion

The systemd service configuration is correct, but the CCR `start` command doesn't properly daemonize when called by systemd with Type=forking. The quickest solution is to use Type=simple, which will work with the current CCR implementation. For a production-ready solution, implementing proper daemon mode in CCR is recommended.