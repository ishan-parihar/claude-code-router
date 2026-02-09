#!/bin/bash
# CCR Systemd Service Setup Script
# This script helps set up and manage the CCR systemd user service

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SERVICE_NAME="ccr"
SERVICE_FILE="$HOME/.config/systemd/user/$SERVICE_NAME.service"
NODE_PATH="/home/linuxbrew/.linuxbrew/bin/node"
NPM_GLOBAL_BIN="$HOME/.npm-global/bin"
CCR_DIR="$HOME/claude-code-router"

# Functions
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_dependencies() {
    print_info "Checking dependencies..."

    # Check if systemd is available
    if ! command -v systemctl &> /dev/null; then
        print_error "systemctl not found. This script requires systemd."
        exit 1
    fi

    # Check if node is available
    if [ ! -f "$NODE_PATH" ]; then
        print_error "Node.js not found at $NODE_PATH"
        exit 1
    fi

    # Check if ccr is available
    if [ ! -f "$NPM_GLOBAL_BIN/ccr" ]; then
        print_error "CCR not found at $NPM_GLOBAL_BIN/ccr"
        exit 1
    fi

    # Check if ccr directory exists
    if [ ! -d "$CCR_DIR" ]; then
        print_error "CCR directory not found at $CCR_DIR"
        exit 1
    fi

    print_success "All dependencies checked"
}

create_service_file() {
    print_info "Creating systemd service file..."

    mkdir -p "$HOME/.config/systemd/user"

    cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Claude Code Router Service
Documentation=https://github.com/your-repo/claude-code-router
After=network.target

[Service]
Type=forking
PIDFile=$HOME/.claude-code-router/.claude-code-router.pid
WorkingDirectory=$CCR_DIR
ExecStart=$NODE_PATH $CCR_DIR/dist/cli.js start
ExecStop=$NPM_GLOBAL_BIN/ccr stop
ExecReload=$NPM_GLOBAL_BIN/ccr restart
Restart=always
RestartSec=10
StartLimitInterval=60
StartLimitBurst=3

# Environment
Environment=NODE_ENV=production
Environment=PATH=$NODE_PATH:$NPM_GLOBAL_BIN:/usr/local/bin:/usr/bin:/bin

# Resource limits
LimitNOFILE=65536
MemoryMax=2G

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ccr

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$HOME/.claude-code-router
ReadWritePaths=$CCR_DIR

[Install]
WantedBy=default.target
EOF

    print_success "Service file created at $SERVICE_FILE"
}

reload_systemd() {
    print_info "Reloading systemd daemon..."
    systemctl --user daemon-reload
    print_success "Systemd daemon reloaded"
}

enable_service() {
    print_info "Enabling $SERVICE_NAME service..."
    systemctl --user enable "$SERVICE_NAME"
    print_success "Service enabled (will start on login)"
}

start_service() {
    print_info "Starting $SERVICE_NAME service..."
    systemctl --user start "$SERVICE_NAME"
    print_success "Service started"
}

show_status() {
    print_info "Service status:"
    systemctl --user status "$SERVICE_NAME" --no-pager || true
}

show_logs() {
    print_info "Recent logs (last 20 lines):"
    journalctl --user -u "$SERVICE_NAME" -n 20 --no-pager || true
}

disable_desktop_autostart() {
    local autostart_file="$HOME/.config/autostart/ccr-autostart.desktop"

    if [ -f "$autostart_file" ]; then
        print_warning "Desktop autostart file found at $autostart_file"
        read -p "Do you want to disable it? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            mv "$autostart_file" "$autostart_file.disabled"
            print_success "Desktop autostart disabled"
        else
            print_info "Desktop autostart left enabled"
        fi
    else
        print_info "No desktop autostart file found"
    fi
}

test_auto_restart() {
    print_info "Testing auto-restart functionality..."
    print_warning "This will kill the CCR process to test if systemd restarts it"

    read -p "Continue? (y/N): " -n 1 -r
    echo

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        local pid_file="$HOME/.claude-code-router/.claude-code-router.pid"

        if [ -f "$pid_file" ]; then
            local pid=$(cat "$pid_file")
            print_info "Killing process $pid..."
            kill "$pid"

            print_info "Waiting 5 seconds for systemd to restart..."
            sleep 5

            if systemctl --user is-active "$SERVICE_NAME" &> /dev/null; then
                print_success "✓ Service was automatically restarted by systemd!"
                show_status
            else
                print_error "✗ Service did not restart automatically"
                show_status
            fi
        else
            print_error "PID file not found. Service may not be running."
        fi
    else
        print_info "Auto-restart test skipped"
    fi
}

show_menu() {
    echo ""
    echo "CCR Systemd Service Management"
    echo "=============================="
    echo ""
    echo "1) Setup and enable service"
    echo "2) Start service"
    echo "3) Stop service"
    echo "4) Restart service"
    echo "5) Show status"
    echo "6) Show logs"
    echo "7) Show logs (follow mode)"
    echo "8) Test auto-restart"
    echo "9) Disable desktop autostart"
    echo "10) Enable service for autostart"
    echo "11) Disable service autostart"
    echo "0) Exit"
    echo ""
    read -p "Select an option: " choice

    case $choice in
        1)
            check_dependencies
            create_service_file
            reload_systemd
            enable_service
            start_service
            show_status
            ;;
        2)
            systemctl --user start "$SERVICE_NAME"
            print_success "Service started"
            show_status
            ;;
        3)
            systemctl --user stop "$SERVICE_NAME"
            print_success "Service stopped"
            ;;
        4)
            systemctl --user restart "$SERVICE_NAME"
            print_success "Service restarted"
            show_status
            ;;
        5)
            show_status
            ;;
        6)
            show_logs
            ;;
        7)
            print_info "Following logs (Ctrl+C to exit)..."
            journalctl --user -u "$SERVICE_NAME" -f
            ;;
        8)
            test_auto_restart
            ;;
        9)
            disable_desktop_autostart
            ;;
        10)
            systemctl --user enable "$SERVICE_NAME"
            print_success "Service enabled for autostart"
            ;;
        11)
            systemctl --user disable "$SERVICE_NAME"
            print_success "Service autostart disabled"
            ;;
        0)
            print_info "Exiting..."
            exit 0
            ;;
        *)
            print_error "Invalid option"
            ;;
    esac
}

# Main script
if [ "$1" == "--setup" ]; then
    # Quick setup mode
    check_dependencies
    create_service_file
    reload_systemd
    enable_service
    start_service
    show_status
    echo ""
    print_success "Setup complete! Service is now running and will start automatically on login."
    print_info "To manage the service, run: $0"
elif [ "$1" == "--status" ]; then
    show_status
elif [ "$1" == "--logs" ]; then
    if [ "$2" == "--follow" ]; then
        journalctl --user -u "$SERVICE_NAME" -f
    else
        show_logs
    fi
elif [ "$1" == "--start" ]; then
    systemctl --user start "$SERVICE_NAME"
    print_success "Service started"
elif [ "$1" == "--stop" ]; then
    systemctl --user stop "$SERVICE_NAME"
    print_success "Service stopped"
elif [ "$1" == "--restart" ]; then
    systemctl --user restart "$SERVICE_NAME"
    print_success "Service restarted"
elif [ "$1" == "--enable" ]; then
    systemctl --user enable "$SERVICE_NAME"
    print_success "Service enabled for autostart"
elif [ "$1" == "--disable" ]; then
    systemctl --user disable "$SERVICE_NAME"
    print_success "Service autostart disabled"
elif [ "$1" == "--test-restart" ]; then
    test_auto_restart
else
    # Interactive mode
    while true; do
        show_menu
    done
fi