#!/usr/bin/env bash
if [ "$(id -g)" != "1051" ] && getent group vpn-nigeria >/dev/null 2>&1; then
    exec sudo -E -n -u "${USER:-ubuntu}" -g vpn-nigeria "$0" "$@"
fi
set -e

# Change directory to project root
cd "$(dirname "$0")"

echo "=========================================="
echo " Starting NexusPanel Bot Dashboard (Linux) "
echo "=========================================="

# Check if node_modules exist
if [ ! -d "node_modules" ]; then
    echo "📦 Installing root dependencies..."
    npm install
fi

if [ ! -d "dashboard/node_modules" ]; then
    echo "📦 Installing dashboard dependencies..."
    cd dashboard && npm install && cd ..
fi

echo "🚀 Launching Dashboard..."
npm run dashboard
