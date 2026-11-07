@echo off
title NexusPanel Private Access & Auto-IP Whitelister
echo ======================================================================
echo    NEXUSPANEL PRIVATE ACCESS (AUTO-UPDATES YOUR IP ON ANY NETWORK)
echo ======================================================================
echo.
echo [1] Whitelisting your current network IP on the VPS firewall...
ssh -o StrictHostKeyChecking=no ubuntu@YOUR_VPS_IP "sudo /usr/local/bin/whitelist-my-ip.sh"
echo.
echo [2] Dashboard Links (100%% Private to You):
echo     - Signals Provider Dashboard : http://YOUR_VPS_IP:5174  (or http://127.0.0.1:5174)
echo     - SportyBet Bet Executor     : http://127.0.0.1:5175
echo.
echo Opening SportyBet Bet Executor (http://127.0.0.1:5175)...
start http://127.0.0.1:5175

:tunnel_loop
echo.
echo [Active] Encrypted tunnel connected. If you switch Wi-Fi/networks,
echo          this window will automatically reconnect and whitelist your new IP!
ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=2 -o ExitOnForwardFailure=yes -L 5175:127.0.0.1:5175 -L 5174:127.0.0.1:5174 -L 3081:127.0.0.1:3081 -L 4000:127.0.0.1:4000 ubuntu@YOUR_VPS_IP "sudo /usr/local/bin/whitelist-my-ip.sh && while true; do sleep 3600; done"
echo.
echo [Network Change Detected] Reconnecting and whitelisting your new IP in 3 seconds...
timeout /t 3 >nul
goto tunnel_loop
