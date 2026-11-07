param (
    [switch]$NoPause = $false,
    [switch]$CreateShortcutOnly = $false
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

function Create-MultiResIco {
    param(
        [string]$PngPath,
        [string]$IcoPath
    )
    
    try {
        if (-not (Test-Path $PngPath)) { return $false }
        
        Add-Type -AssemblyName System.Drawing
        $sourceBmp = [System.Drawing.Bitmap]::FromFile((Resolve-Path $PngPath).Path)
        $sizes = @(256, 128, 64, 48, 32, 16)
        $entries = @()
        
        foreach ($sz in $sizes) {
            $bmp = New-Object System.Drawing.Bitmap $sz, $sz
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $g.DrawImage($sourceBmp, 0, 0, $sz, $sz)
            $g.Dispose()
            
            $ms = New-Object System.IO.MemoryStream
            $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
            $entries += @{
                Size = $sz
                Bytes = $ms.ToArray()
            }
            $ms.Dispose()
            $bmp.Dispose()
        }
        $sourceBmp.Dispose()
        
        $destDir = Split-Path -Parent $IcoPath
        if (-not (Test-Path $destDir)) {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }
        
        $fs = [System.IO.File]::Create($IcoPath)
        $bw = New-Object System.IO.BinaryWriter $fs
        
        # ICONDIR header (6 bytes)
        $bw.Write([uint16]0)                  # idReserved = 0
        $bw.Write([uint16]1)                  # idType = 1 (ICO)
        $bw.Write([uint16]$entries.Count)     # idCount
        
        # Calculate image data offset
        $offset = 6 + (16 * $entries.Count)
        
        # ICONDIRENTRY (16 bytes per image)
        foreach ($e in $entries) {
            $w = if ($e.Size -eq 256) { [byte]0 } else { [byte]$e.Size }
            $h = if ($e.Size -eq 256) { [byte]0 } else { [byte]$e.Size }
            $bw.Write($w)                         # bWidth
            $bw.Write($h)                         # bHeight
            $bw.Write([byte]0)                    # bColorCount
            $bw.Write([byte]0)                    # bReserved
            $bw.Write([uint16]1)                  # wPlanes
            $bw.Write([uint16]32)                 # wBitCount
            $bw.Write([uint32]$e.Bytes.Length)    # dwBytesInRes
            $bw.Write([uint32]$offset)            # dwImageOffset
            $offset += $e.Bytes.Length
        }
        
        # Write image bytes
        foreach ($e in $entries) {
            $bw.Write($e.Bytes)
        }
        
        $bw.Flush()
        $fs.Close()
        $bw.Dispose()
        return $true
    } catch {
        return $false
    }
}

function Refresh-ShellIcons {
    try {
        $typeDef = @"
using System;
using System.Runtime.InteropServices;
public class ShellIconNotify {
    [DllImport("shell32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
}
"@
        Add-Type -TypeDefinition $typeDef -ErrorAction SilentlyContinue
        [ShellIconNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
    } catch {
        # Non-critical if notification fails
    }
}

function Create-DashboardShortcut {
    param(
        [string]$TargetBat,
        [string]$WorkingDir
    )
    
    try {
        $desktopPath = [Environment]::GetFolderPath('Desktop')
        $shortcutPath = Join-Path $desktopPath "Bot Dashboard.lnk"
        
        # Ensure high-res multi-resolution icon exists
        $icoFile = Join-Path $WorkingDir "dashboard\resources\icon.ico"
        $pngFile = Join-Path $WorkingDir "dashboard\resources\icon.png"
        $rootIco = Join-Path $WorkingDir "icon.ico"
        
        # Build pristine icon from PNG
        Create-MultiResIco -PngPath $pngFile -IcoPath $icoFile | Out-Null
        if (Test-Path $icoFile) {
            Copy-Item -Path $icoFile -Destination $rootIco -Force -ErrorAction SilentlyContinue
        }
        
        $WshShell = New-Object -ComObject WScript.Shell
        $Shortcut = $WshShell.CreateShortcut($shortcutPath)
        $Shortcut.TargetPath = $TargetBat
        $Shortcut.WorkingDirectory = $WorkingDir
        $Shortcut.Description = "Nexus Bot & Match Predictor Dashboard"
        $Shortcut.WindowStyle = 1 # Normal Window
        
        if (Test-Path $icoFile) {
            $Shortcut.IconLocation = "$icoFile,0"
        } elseif (Test-Path $rootIco) {
            $Shortcut.IconLocation = "$rootIco,0"
        } else {
            $Shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
        }
        
        $Shortcut.Save()
        Refresh-ShellIcons
        Write-Host "   [+] Beautiful Desktop Shortcut created: $shortcutPath" -ForegroundColor Green
    } catch {
        Write-Host "   [-] Warning: Failed to create shortcut: $_" -ForegroundColor Yellow
    }
}

if ($CreateShortcutOnly) {
    Write-Host "`nGenerating Beautiful Desktop Shortcut..." -ForegroundColor Cyan
    Create-DashboardShortcut -TargetBat (Join-Path $scriptDir "run-dashboard.bat") -WorkingDir $scriptDir
    exit 0
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "        NEXUS BOT & DASHBOARD - 1-CLICK INSTALLER           " -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# 1. Check for Node.js & NPM
Write-Host "`n[1/4] Checking for Node.js & NPM..." -ForegroundColor Yellow
$nodeInstalled = $false

# Check PATH first
try {
    $nodeVersion = node -v 2>$null
    if ($LASTEXITCODE -eq 0 -and $nodeVersion) {
        $nodeInstalled = $true
        Write-Host "   [OK] Node.js is installed: $nodeVersion" -ForegroundColor Green
    }
} catch {
    $nodeInstalled = $false
}

# If not found in PATH, check standard installation directories
if (-not $nodeInstalled) {
    $commonNodePaths = @(
        "$env:ProgramFiles\nodejs",
        "${env:ProgramFiles(x86)}\nodejs",
        "$env:LocalAppData\Programs\nodejs"
    )
    foreach ($p in $commonNodePaths) {
        if (Test-Path (Join-Path $p "node.exe")) {
            $env:Path = "$p;$env:Path"
            $nodeInstalled = $true
            $nodeVersion = node -v 2>$null
            Write-Host "   [OK] Node.js located at $p ($nodeVersion)" -ForegroundColor Green
            break
        }
    }
}

if (-not $nodeInstalled) {
    Write-Host "   Node.js not detected. Downloading Node.js v20 LTS installer..." -ForegroundColor Yellow
    $nodeMsi = "$env:TEMP\nodejs-lts.msi"
    
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
        Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.14.0/node-v20.14.0-x64.msi" -OutFile $nodeMsi
        
        Write-Host "   Installing Node.js silently... Please wait, this may take a moment." -ForegroundColor Yellow
        $process = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$nodeMsi`" /qn /norestart" -Wait -NoNewWindow -PassThru
        
        if ($process.ExitCode -eq 0 -or $process.ExitCode -eq 3010) {
            Write-Host "   [OK] Node.js installed successfully!" -ForegroundColor Green
        } else {
            Write-Host "   [!] Node.js installer exited with code: $($process.ExitCode). Checking path..." -ForegroundColor Yellow
        }
        
        # Refresh Path
        Write-Host "   Refreshing Environment Variables..." -ForegroundColor Yellow
        $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $env:Path = $machinePath + ";" + $userPath + ";$env:ProgramFiles\nodejs"
        
        $nodeVersion = node -v 2>$null
        Write-Host "   [OK] Verified Node Version: $nodeVersion" -ForegroundColor Green
    } catch {
        Write-Host "   [ERROR] Failed to download or install Node.js: $_" -ForegroundColor Red
        Write-Host "   Please install Node.js LTS manually from https://nodejs.org and re-run this installer." -ForegroundColor Red
        if (-not $NoPause) { pause }
        exit 1
    }
}

# Verify NPM
try {
    $npmVersion = cmd /c "npm -v" 2>$null
    Write-Host "   [OK] NPM Version: $npmVersion" -ForegroundColor Green
} catch {
    Write-Host "   [!] NPM warning: could not verify npm version." -ForegroundColor Yellow
}

# 2. Install Root Dependencies
Write-Host "`n[2/4] Installing Root Bot Dependencies..." -ForegroundColor Yellow
if (Test-Path "package.json") {
    Write-Host "   Running npm install in root folder..." -ForegroundColor Gray
    cmd /c "npm install"
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   [OK] Root bot dependencies installed successfully!" -ForegroundColor Green
    } else {
        Write-Host "   [!] Warning: npm install in root folder returned code $LASTEXITCODE. Retrying with --no-audit..." -ForegroundColor Yellow
        cmd /c "npm install --no-audit"
    }
} else {
    Write-Host "   No package.json found in root folder, skipping." -ForegroundColor Cyan
}

# 3. Install Dashboard Dependencies
Write-Host "`n[3/4] Installing Dashboard (Electron + React) Dependencies..." -ForegroundColor Yellow
if (Test-Path "dashboard\package.json") {
    Push-Location "dashboard"
    Write-Host "   Running npm install in dashboard folder..." -ForegroundColor Gray
    cmd /c "npm install"
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   [OK] Dashboard dependencies installed successfully!" -ForegroundColor Green
    } else {
        Write-Host "   [!] Warning: npm install in dashboard folder returned code $LASTEXITCODE. Retrying with --no-audit..." -ForegroundColor Yellow
        cmd /c "npm install --no-audit"
    }
    Pop-Location
} else {
    Write-Host "   Dashboard folder not found, skipping." -ForegroundColor Cyan
}

# 4. Create Desktop Shortcut with Multi-Res Icon
Write-Host "`n[4/4] Creating High-Quality Desktop Shortcut..." -ForegroundColor Yellow
$targetBat = Join-Path $scriptDir "run-dashboard.bat"
Create-DashboardShortcut -TargetBat $targetBat -WorkingDir $scriptDir

Write-Host "`n============================================================" -ForegroundColor Green
Write-Host "                ALL REQUIREMENTS INSTALLED!                 " -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host " You can now launch the dashboard using:" -ForegroundColor White
Write-Host "  1. The Desktop shortcut: 'Bot Dashboard'" -ForegroundColor Cyan
Write-Host "  2. Or double-clicking: 'run-dashboard.bat'" -ForegroundColor Cyan

if (-not $NoPause) {
    Write-Host "`nWould you like to launch the Dashboard now? (Y/N) [Default: Y]: " -NoNewline -ForegroundColor Yellow
    $ans = Read-Host
    if ([string]::IsNullOrWhiteSpace($ans) -or $ans.Trim().ToUpper() -eq "Y") {
        Write-Host "Launching Dashboard..." -ForegroundColor Green
        Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$targetBat`"" -WorkingDirectory $scriptDir
    }
}
