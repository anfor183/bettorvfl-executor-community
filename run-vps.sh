#!/usr/bin/env bash
if [ "$(id -g)" != "1051" ] && getent group vpn-nigeria >/dev/null 2>&1; then
    exec sudo -E -n -u "${USER:-ubuntu}" -g vpn-nigeria "$0" "$@"
fi
set -e

# Change directory to project root
cd "$(dirname "$0")"

echo "========================================================"
echo "      BETTOR-VFL EXECUTOR - VPS OPTIMIZATION LAUNCHER   "
echo "========================================================"

# Enforce Node V8 memory safety for the host runtime
export NODE_OPTIONS="--max-old-space-size=512"

# 1. Dependency checks
if [ ! -d "node_modules" ]; then
    echo "📦 Installing root dependencies..."
    npm install
fi

# 2. Run VPS Engine status & diagnostics
echo "🔍 Running VPS Hardware & Resource Diagnostics..."
node utils/vps_engine.js --status

# 3. Clean any existing orphaned zombies or stale locks before startup
echo "🧹 Performing startup process hygiene..."
node utils/vps_engine.js --clean

# 4. Mode Selection: CLI Scheduler vs Full GUI Dashboard
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
    echo "Usage: ./run-vps.sh [MODE] [SCHEDULER_ARGS...]"
    echo ""
    echo "Modes:"
    echo "  scheduler [dbFile] [intervalMinutes] [isHeadless] (Default: runs live scheduler)"
    echo "  dashboard                                         (Runs Nexus Panel GUI)"
    echo ""
    echo "Examples:"
    echo "  ./run-vps.sh                                      # Run auto scheduler"
    echo "  ./run-vps.sh scheduler my_data.db 3 true          # Run auto scheduler with args"
    echo "  ./run-vps.sh dashboard                            # Run Nexus Panel (uses xvfb if headless)"
    exit 0
fi

MODE="${1:-scheduler}"
if [ "$MODE" = "scheduler" ]; then
    shift || true
fi

if [ "$MODE" = "dashboard" ]; then
    echo "🖥️ Starting Dashboard Mode..."
    if [ -z "$DISPLAY" ] && [ -z "$WAYLAND_DISPLAY" ]; then
        if command -v xvfb-run >/dev/null 2>&1; then
            echo "🚀 Headless Linux VPS detected: Launching via xvfb-run..."
            xvfb-run -a npm run dashboard
        else
            echo "⚠️ No X11/Wayland display server detected and xvfb-run is not installed."
            echo "💡 Tip: Install Xvfb (sudo apt-get install -y xvfb) to run GUI dashboard on headless VPS,"
            echo "   or run in headless scheduler mode: ./run-vps.sh scheduler"
            exit 1
        fi
    else
        npm run dashboard
    fi
else
    echo "🚀 Launching Live Scraper & ML Scheduler in Headless VPS Mode..."
    echo "   ↳ Target: auto_live_scheduler.js"
    echo "   ↳ Press Ctrl+C at any time to gracefully stop."
    echo "========================================================"
    node auto_live_scheduler.js "$@"
fi
