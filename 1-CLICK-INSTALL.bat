@echo off
TITLE Bot 1-Click Installer & Setup Wizard
COLOR 0B

:: Ensure working directory is always the script folder
cd /d "%~dp0"

:: Check for administrative privileges (required for installing Node.js globally if missing)
net session >nul 2>&1
if %errorLevel% == 0 (
    goto :RunScript
) else (
    echo ============================================================
    echo       NEXUS BOT & DASHBOARD - 1-CLICK INSTALLER
    echo ============================================================
    echo Requesting Administrator privileges to verify and install system components...
    powershell -NoProfile -Command "Start-Process -FilePath '%~dpnx0' -Verb RunAs"
    exit /b
)

:RunScript
cd /d "%~dp0"

echo ============================================================
echo       NEXUS BOT & DASHBOARD - 1-CLICK INSTALLER
echo ============================================================
echo Starting installer and dependency manager...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_requirements.ps1"

if %errorlevel% NEQ 0 (
    echo.
    echo [!] Setup encountered an issue (Exit Code: %errorlevel%).
    pause
)
