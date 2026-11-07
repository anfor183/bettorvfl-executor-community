@echo off
TITLE Nexus Bot Dashboard Launcher

:: Lock working directory to the directory containing this batch script
cd /d "%~dp0"

:: Handle standalone shortcut creation argument
if /I "%~1"=="--shortcut" goto :CreateShortcutOnly
if /I "%~1"=="/shortcut" goto :CreateShortcutOnly
if /I "%~1"=="-shortcut" goto :CreateShortcutOnly

echo ============================================================
echo               NEXUS BOT DASHBOARD LAUNCHER
echo ============================================================

:: 1. Verify Node.js Environment
where node >nul 2>&1
if %errorlevel% NEQ 0 (
    if exist "C:\Program Files\nodejs\node.exe" (
        set "PATH=C:\Program Files\nodejs;%PATH%"
    ) else if exist "C:\Program Files (x86)\nodejs\node.exe" (
        set "PATH=C:\Program Files (x86)\nodejs;%PATH%"
    ) else if exist "%LocalAppData%\Programs\nodejs\node.exe" (
        set "PATH=%LocalAppData%\Programs\nodejs;%PATH%"
    )
)

where node >nul 2>&1
if %errorlevel% NEQ 0 (
    echo.
    echo [!] Node.js was not found on your system!
    echo.
    set /p RUN_INSTALL="Would you like to run 1-CLICK-INSTALL.bat now to set up Node.js? (Y/N): "
    if /I "%RUN_INSTALL%"=="Y" (
        start "" "%~dp01-CLICK-INSTALL.bat"
        exit /b 0
    ) else (
        echo Please install Node.js manually or run 1-CLICK-INSTALL.bat to continue.
        pause
        exit /b 1
    )
)

:: 2. Verify Root Dependencies
if not exist "node_modules\" (
    echo.
    echo [*] Missing root bot dependencies. Installing automatically...
    call npm install
    if %errorlevel% NEQ 0 (
        echo [!] Warning: Root dependencies installation encountered errors.
    ) else (
        echo [+] Root dependencies installed successfully!
    )
)

:: 3. Verify Dashboard Dependencies
if not exist "dashboard\node_modules\.bin\electron-vite.cmd" (
    echo.
    echo [*] Missing dashboard dependencies. Installing automatically...
    pushd dashboard
    call npm install
    if %errorlevel% NEQ 0 (
        echo [!] Warning: Dashboard dependencies installation encountered errors.
    ) else (
        echo [+] Dashboard dependencies installed successfully!
    )
    popd
)

:: 4. Ensure Desktop Shortcut Exists
powershell -NoProfile -Command "$desktop=[Environment]::GetFolderPath('Desktop'); $lnk=Join-Path $desktop 'Bot Dashboard.lnk'; if (-not (Test-Path $lnk)) { exit 1 } else { exit 0 }" >nul 2>&1
if %errorlevel% NEQ 0 (
    echo [*] Desktop shortcut not found. Generating shortcut on Desktop...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_requirements.ps1" -CreateShortcutOnly -NoPause
)

:: 5. Weekly Dependency Update Check
set "update_file=%TEMP%\nexus_bot_last_update.txt"
powershell -NoProfile -Command "$file='%update_file%'; if (Test-Path $file) { $lastWrite=(Get-Item $file).LastWriteTime; if ((Get-Date) - $lastWrite -lt (New-TimeSpan -Days 7)) { exit 1 } }; New-Item -ItemType File -Force -Path $file | Out-Null; exit 0" >nul 2>&1

if %errorLevel% == 0 (
    echo.
    echo ============================================================
    echo                WEEKLY DEPENDENCY CHECK
    echo ============================================================
    echo Checking for minor dependency updates...
    call npm update --silent
    
    pushd dashboard
    call npm update --silent
    popd
    echo Dependencies checked.
    echo ============================================================
)

:: 6. Launch Electron + React Dashboard
echo.
echo [*] Cleaning stale dashboard processes...
taskkill /F /IM electron.exe >nul 2>&1
echo [*] Starting Nexus Bot Dashboard...
cd /d "%~dp0dashboard"
call npm run dev

if %errorlevel% NEQ 0 (
    echo.
    echo ============================================================
    echo [!] Dashboard process exited unexpectedly with code: %errorlevel%
    echo ============================================================
    echo If this is your first run or dependencies are broken,
    echo run 1-CLICK-INSTALL.bat to perform a full reinstall.
    echo ============================================================
    pause
)
exit /b 0

:CreateShortcutOnly
echo Creating Desktop shortcut for Nexus Bot Dashboard...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_requirements.ps1" -CreateShortcutOnly -NoPause
pause
exit /b 0
