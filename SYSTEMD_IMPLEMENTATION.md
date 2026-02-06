# CCR Systemd Service Implementation

## Overview
This document describes the implementation of a systemd user service for Claude Code Router (CCR) that provides automatic restart capabilities and better process management.

## Architecture Analysis

### Current CCR Process Management
- **PID File**: `~/.claude-code-router/.claude-code-router.pid`
- **Start Command**: `node dist/cli.js start`
- **Stop Command**: `ccr stop`
- **Restart Command**: `ccr restart`
- **Process Detection**: Uses PID file validation with `process.kill(pid, 0)`

### Why Systemd?

**Benefits over current approach:**
1. ✅ **Automatic Restart**: Built-in restart policy (Restart=always)
2. ✅ **Process Supervision**: Monitors process health and restarts if crashed
3. ✅ **Resource Limits**: Memory and file descriptor limits
4. ✅ **Logging Integration**: All logs go to journald
5. ✅ **Startup Ordering**: Runs after network is ready
6. ✅ **Clean Shutdown**: Proper signal handling (SIGTERM/SIGINT)
7. ✅ **Dependency Management**: Can depend on other services
8. ✅ **User-level**: Runs as user service, no root required

**Comparison with Desktop Autostart:**

| Feature | Desktop Autostart | Systemd Service |
|---------|------------------|-----------------|
| Auto-restart on crash | ❌ No | ✅ Yes |
| Health monitoring | ❌ No | ✅ Yes |
| Log aggregation | ❌ No | ✅ Yes (journald) |
| Resource limits | ❌ No | ✅ Yes |
| Process cleanup | ⚠️ Manual | ✅ Automatic |
| Dependency handling | ❌ No | ✅ Yes |
| Startup ordering | ⚠️ Limited | ✅ Yes |

## Implementation Design

### Service Configuration

**File**: `~/.config/systemd/user/ccr.service`

**Key Directives:**

1. **Type=forking**
   - Service forks into background
   - Systemd uses PID file to track main process
   - Matches current CCR behavior

2. **Restart=always**
   - Automatically restarts on:
     - Process crash (exit code != 0)
     - Process timeout
     - Manual kill (unless stopped via systemd)
   - Wait 10s between restarts (RestartSec=10)

3. **StartLimitBurst=3 + StartLimitInterval=60**
   - Prevents restart loops
   - Max 3 restart attempts in 60 seconds
   - After 3 failures, systemd stops trying

4. **ExecStart/ExecStop/ExecReload**
   - ExecStart: Starts the service
   - ExecStop: Stops gracefully
   - ExecReload: Restarts on reload signal

5. **Resource Limits**
   - LimitNOFILE=65536: High file descriptor limit
   - MemoryMax=2G: Maximum 2GB memory usage

6. **Security Hardening**
   - NoNewPrivileges: Prevents privilege escalation
   - PrivateTmp: Isolated /tmp directory
   - ProtectSystem=strict: Read-only system directories
   - ProtectHome=true: Can't access other user files
   - ReadWritePaths: Explicitly allowed directories

## Integration with Existing Code

### No Code Changes Required

The systemd service works with existing CCR implementation:

1. **PID File Management**
   - CCR already creates PID file at startup
   - Systemd reads same PID file for tracking
   - No changes needed

2. **Stop/Restart Logic**
   - `ccr stop` reads PID file and kills process
   - Works identically with systemd
   - No changes needed

3. **Configuration**
   - Uses existing `~/.claude-code-router/config.json`
   - Environment variables can be set in service
   - No changes needed

### Compatibility Notes

**Desktop Autostart + Systemd:**
- Can coexist (desktop autostart will see systemd-managed service as "already running")
- Desktop autostart can be disabled if systemd is used
- Recommend: Disable desktop autostart when using systemd

**Manual Commands:**
- All `ccr` commands work as before
- `ccr status` checks PID file (still works)
- `ccr stop` works (but better to use `systemctl --user stop ccr`)
- `ccr restart` works (but better to use `systemctl --user reload ccr`)

## Usage

### Enable and Start Service

```bash
# Reload systemd configuration
systemctl --user daemon-reload

# Enable autostart (starts on login)
systemctl --user enable ccr

# Start service immediately
systemctl --user start ccr

# Check status
systemctl --user status ccr
```

### Service Management

```bash
# Stop service
systemctl --user stop ccr

# Restart service
systemctl --user restart ccr

# Reload configuration (restart)
systemctl --user reload ccr

# View logs
journalctl --user -u ccr -f

# View last 100 lines
journalctl --user -u ccr -n 100

# Check if service is enabled
systemctl --user is-enabled ccr
```

### Testing Auto-restart

```bash
# Kill the process manually
kill $(cat ~/.claude-code-router/.claude-code-router.pid)

# Watch systemd restart it automatically
journalctl --user -u ccr -f
```

## Monitoring and Debugging

### Check Service Health

```bash
# Service status
systemctl --user status ccr

# Check if running
systemctl --user is-active ccr

# Check recent restarts
systemctl --user show ccr -p NRestarts
```

### View Logs

```bash
# Follow logs in real-time
journalctl --user -u ccr -f

# View logs since last boot
journalctl --user -u ccr -b

# View logs with timestamps
journalctl --user -u ccr -f --since today

# View error logs only
journalctl --user -u ccr -p err
```

### Common Issues

**Service fails to start:**
```bash
# Check detailed logs
journalctl --user -u ccr -n 50 --no-pager
```

**Service keeps restarting:**
```bash
# Check restart count
systemctl --user show ccr -p NRestarts
# Check if StartLimitBurst reached
systemctl --user show ccr -p StartLimitBurst
```

**Process not responding:**
```bash
# Send SIGTERM (graceful stop)
systemctl --user kill ccr -s SIGTERM

# Send SIGKILL (force kill)
systemctl --user kill ccr -s SIGKILL
```

## Migration from Desktop Autostart

### Option 1: Disable Desktop Autostart

```bash
# Disable desktop autostart
rm ~/.config/autostart/ccr-autostart.desktop

# Or disable without deleting
mv ~/.config/autostart/ccr-autostart.desktop ~/.config/autostart/ccr-autostart.desktop.disabled
```

### Option 2: Keep Both (Not Recommended)

Desktop autostart will see systemd service as "already running" and skip starting.

## Best Practices

1. **Use systemd commands** instead of `ccr stop/start` for better control
2. **Monitor logs** regularly with `journalctl`
3. **Set appropriate resource limits** based on usage
4. **Use Restart=on-failure** instead of always if you want manual control
5. **Add notifications** for service failures (optional)

## Future Enhancements

### Possible Improvements

1. **Health Check Endpoint**
   ```ini
   ExecStartPost=/bin/sleep 5
   ExecStartPost=/usr/bin/curl -f http://127.0.0.1:3456/api/health || exit 1
   ```

2. **Watchdog Timer**
   ```ini
   WatchdogSec=30
   ```

3. **Email Notifications**
   ```ini
   OnFailure=notify-send -i error "CCR Service Failed"
   ```

4. **Resource Usage Alerts**
   ```bash
   # Add to ExecStartPost
   /usr/bin/notify-send "CCR Started" "Memory limit: 2G"
   ```

## Conclusion

The systemd service provides robust process management with automatic restart capabilities, better logging, and resource limits. It requires no code changes and integrates seamlessly with existing CCR functionality.

### Recommended Action

1. Test the service in current session
2. Verify auto-restart works correctly
3. Disable desktop autostart
4. Enable systemd service for auto-start on login