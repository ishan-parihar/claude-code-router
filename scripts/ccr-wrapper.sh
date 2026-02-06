#!/bin/bash
# Wrapper script for running CCR under systemd
# This script keeps the process alive and handles signals properly

set -e

# Configuration
CCR_BIN="/home/ishanp/.npm-global/bin/ccr"
PID_FILE="$HOME/.claude-code-router/.claude-code-router.pid"
LOG_DIR="$HOME/.claude-code-router/logs"
LOG_FILE="$LOG_DIR/systemd-wrapper.log"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Function to stop CCR
stop_ccr() {
    echo "[$(date)] Stopping CCR..." >> "$LOG_FILE"
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "[$(date)] Killing process $PID" >> "$LOG_FILE"
            kill "$PID"
            sleep 2
            # Force kill if still running
            if kill -0 "$PID" 2>/dev/null; then
                kill -9 "$PID"
            fi
        fi
        rm -f "$PID_FILE"
    fi
}

# Function to start CCR
start_ccr() {
    echo "[$(date)] Starting CCR..." >> "$LOG_FILE"

    # Stop any existing instance
    stop_ccr

    # Start CCR in background
    "$CCR_BIN" start >> "$LOG_FILE" 2>&1 &
    CCR_PID=$!

    echo "[$(date)] CCR started with PID: $CCR_PID" >> "$LOG_FILE"

    # Wait a moment for CCR to initialize
    sleep 3

    # Check if process is still running
    if kill -0 "$CCR_PID" 2>/dev/null; then
        echo "[$(date)] CCR is running (PID: $CCR_PID)" >> "$LOG_FILE"
        # Keep this wrapper script alive until CCR exits
        wait "$CCR_PID"
        EXIT_CODE=$?
        echo "[$(date)] CCR exited with code: $EXIT_CODE" >> "$LOG_FILE"
        exit $EXIT_CODE
    else
        echo "[$(date)] ERROR: CCR failed to start or exited immediately" >> "$LOG_FILE"
        exit 1
    fi
}

# Handle signals
trap 'echo "[$(date)] Received signal, stopping..."; stop_ccr; exit 0' SIGTERM SIGINT

# Start CCR
start_ccr