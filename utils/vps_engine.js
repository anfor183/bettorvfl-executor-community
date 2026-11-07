const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

class VPSEngine {
    constructor() {
        this.configPath = path.resolve(__dirname, '../browser-config.json');
        this.rootDir = path.resolve(__dirname, '..');
        this.profilesDir = path.resolve(__dirname, '../profiles');
        this.activeWatchdog = null;
        this.lastReapTime = 0;
    }

    /**
     * Load current VPS config from browser-config.json
     */
    getConfig() {
        try {
            if (fs.existsSync(this.configPath)) {
                const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
                return raw.vps || this.getDefaultConfig();
            }
        } catch (e) {
            console.warn('[VPS Engine] Warning loading config:', e.message);
        }
        return this.getDefaultConfig();
    }

    getDefaultConfig() {
        return {
            enabled: 'auto', // 'auto', true, false
            lowMemoryMode: true,
            rendererProcessLimit: 1,
            maxV8MemoryMb: 256,
            blockHeavyMedia: true,
            autoReapZombies: true,
            reapIntervalMinutes: 10,
            pruneCacheOnStartup: true
        };
    }

    /**
     * Inspect system and determine if running in a VPS / low-resource environment
     */
    detectVPSEnvironment() {
        const reasons = [];
        const isLinux = process.platform === 'linux';
        const totalMemBytes = os.totalmem();
        const totalMemMb = Math.round(totalMemBytes / (1024 * 1024));
        const freeMemMb = Math.round(os.freemem() / (1024 * 1024));
        const cpuCores = os.cpus()?.length || 1;

        // 1. Memory constraint (VPS servers often have <= 4GB or <= 2GB)
        if (totalMemMb <= 2200) {
            reasons.push(`Ultralight RAM detected: ${totalMemMb}MB total (<= 2GB)`);
        } else if (totalMemMb <= 4600) {
            reasons.push(`Constrained RAM detected: ${totalMemMb}MB total (<= 4GB)`);
        }

        // 2. CPU constraints
        if (cpuCores <= 2) {
            reasons.push(`Low CPU core count: ${cpuCores} core(s)`);
        }

        // 3. Headless Linux display environment (common on cloud servers)
        if (isLinux && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
            reasons.push('Headless Linux environment without active display server (no DISPLAY/WAYLAND)');
        }

        // 4. Virtualization / Container indicators
        if (isLinux) {
            try {
                if (fs.existsSync('/.dockerenv')) {
                    reasons.push('Running inside Docker container');
                }
                if (fs.existsSync('/proc/vz')) {
                    reasons.push('OpenVZ virtualization detected');
                }
                // Check DMI / sys vendor
                const sysVendorPath = '/sys/class/dmi/id/sys_vendor';
                const productNamePath = '/sys/class/dmi/id/product_name';
                let vendorInfo = '';
                if (fs.existsSync(sysVendorPath)) {
                    vendorInfo += fs.readFileSync(sysVendorPath, 'utf8').trim() + ' ';
                }
                if (fs.existsSync(productNamePath)) {
                    vendorInfo += fs.readFileSync(productNamePath, 'utf8').trim();
                }

                if (/kvm|qemu|digitalocean|hetzner|vultr|linode|aws|amazon|google|vmware|virtualbox/i.test(vendorInfo)) {
                    reasons.push(`Cloud Hypervisor detected (${vendorInfo.trim()})`);
                }
            } catch (e) {
                // Ignore sysfs permission errors
            }
        }

        let isVPS = reasons.length > 0;
        let profile = 'standard';
        if (totalMemMb <= 2200 || (cpuCores === 1 && totalMemMb <= 3500)) {
            profile = 'ultralight';
        } else if (totalMemMb <= 4600 || cpuCores <= 2) {
            profile = 'balanced';
        }

        return {
            isVPS,
            reasons,
            profile,
            metrics: {
                totalMemMb,
                freeMemMb,
                usedMemMb: totalMemMb - freeMemMb,
                freeMemPercent: Math.round((freeMemMb / totalMemMb) * 100),
                cpuCores,
                platform: process.platform,
                uptimeHours: (os.uptime() / 3600).toFixed(1)
            }
        };
    }

    /**
     * Check if VPS mode is actively enforced (either explicit or auto-detected)
     */
    isVPSEnabled() {
        const cfg = this.getConfig();
        if (cfg.enabled === true || cfg.enabled === 'true') return true;
        if (cfg.enabled === false || cfg.enabled === 'false') return false;

        // Auto mode
        const detection = this.detectVPSEnvironment();
        return detection.isVPS;
    }

    /**
     * Generate VPS-tailored browser launch flags
     */
    getOptimizedBrowserArgs(existingArgs = [], options = {}) {
        const isVPS = options.forceVPS !== undefined ? options.forceVPS : this.isVPSEnabled();
        const isHeadless = options.headless === true || options.headless === 'new';
        const isLinux = process.platform === 'linux';
        const cfg = this.getConfig();

        // Start with a clean set of arguments
        let args = [...existingArgs];

        // 1. Mandatory Linux/Container flags
        if (isLinux || isVPS) {
            const linuxMandatory = [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-setuid-sandbox'
            ];
            for (const flag of linuxMandatory) {
                if (!args.includes(flag)) args.push(flag);
            }

            // CRITICAL FIX: Strip Windows-only DirectX 11 / ANGLE flags on Linux
            args = args.filter(a => !a.includes('--use-angle=d3d11') && !a.includes('--use-gl=angle'));
        }

        if (!isVPS) {
            return args;
        }

        // 2. VPS-Specific GPU & Rendering Throttling
        // Running hardware acceleration on a VPS without a physical GPU leads to crashes and high CPU
        if (isHeadless || isLinux) {
            const gpuBypass = [
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu-compositing'
            ];
            for (const flag of gpuBypass) {
                if (!args.includes(flag)) args.push(flag);
            }
        }

        // 3. Renderer Process Limits & V8 Memory Footprint
        const rendererLimit = cfg.rendererProcessLimit || 1;
        const maxV8Mb = cfg.maxV8MemoryMb || 256;

        if (!args.some(a => a.startsWith('--renderer-process-limit='))) {
            args.push(`--renderer-process-limit=${rendererLimit}`);
        }

        if (!args.some(a => a.startsWith('--js-flags='))) {
            args.push(`--js-flags=--max-old-space-size=${maxV8Mb} --optimize-for-size`);
        }

        // 4. Memory & Background Churn Elimination
        const vpsOptimizations = [
            '--mute-audio',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-breakpad',
            '--disable-component-extensions-with-background-pages',
            '--disable-component-update',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-sync',
            '--disable-translate',
            '--metrics-recording-only',
            '--no-first-run',
            '--no-default-browser-check',
            '--disk-cache-size=33554432' // Limit disk cache to 32MB to prevent SSD bloat
        ];

        for (const flag of vpsOptimizations) {
            if (!args.includes(flag)) args.push(flag);
        }

        return args;
    }

    /**
     * Intercept and block non-essential media & assets to keep scraping ultra-fast and lightweight
     */
    async optimizePageForScraping(page, options = {}) {
        if (!page) return;
        const cfg = this.getConfig();
        const shouldBlock = options.blockHeavyMedia !== undefined ? options.blockHeavyMedia : cfg.blockHeavyMedia;

        if (!shouldBlock) return;

        try {
            const client = await page.target().createCDPSession();

            // 1. Block heavy URLs using CDP
            const blockedPatterns = [
                '*.mp4', '*.webm', '*.ogg', '*.mp3', '*.wav', '*.flv', '*.avi',
                '*.woff', '*.woff2', '*.ttf', '*.eot',
                '*google-analytics.com*', '*googletagmanager.com*', '*doubleclick.net*',
                '*facebook.net*', '*clarity.ms*'
            ];

            // If aggressive media blocking is requested, also block images
            if (options.blockImages !== false) {
                blockedPatterns.push('*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.svg');
            }

            await client.send('Network.setBlockedURLs', { urls: blockedPatterns });
            console.log(`[VPS Engine] 🛡️ Activated CDP lightweight asset blocking (${blockedPatterns.length} patterns)`);

            // 2. Disable CPU-heavy CSS animations and transitions
            await page.evaluateOnNewDocument(() => {
                const style = document.createElement('style');
                style.textContent = `
                    *, *::before, *::after {
                        animation-duration: 0.001s !important;
                        animation-iteration-count: 1 !important;
                        transition-duration: 0.001s !important;
                    }
                `;
                if (document.head) document.head.appendChild(style);
                else document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
            });
        } catch (err) {
            console.warn('[VPS Engine] Could not attach CDP asset blocker:', err.message);
        }
    }

    /**
     * Terminate orphaned / zombie Chrome and Chromium processes safely
     */
    reapZombieProcesses() {
        let reapedCount = 0;
        const isWin = process.platform === 'win32';

        try {
            if (isWin) {
                console.log('[VPS Engine] 🧹 Scanning for lingering Chrome processes on Windows...');
                try {
                    execSync('taskkill /F /IM chrome.exe /FI "STATUS eq NOT RESPONDING"', { stdio: 'ignore' });
                } catch (e) {}
            } else {
                // On Linux: Find defunct or orphaned chrome/chromium processes
                try {
                    const psOutput = execSync('ps -eo pid,ppid,stat,comm 2>/dev/null || true', { encoding: 'utf8' });
                    const lines = psOutput.trim().split('\n');

                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 4) {
                            const pid = parseInt(parts[0], 10);
                            const ppid = parseInt(parts[1], 10);
                            const stat = parts[2];
                            const comm = parts[3].toLowerCase();

                            // Defunct process or orphaned chrome whose parent is PID 1 (system init)
                            if (comm.includes('chrome') || comm.includes('chromium')) {
                                if (stat.startsWith('Z') || (ppid === 1 && !line.includes('chrome-sandbox'))) {
                                    try {
                                        process.kill(pid, 'SIGKILL');
                                        reapedCount++;
                                    } catch (e) {}
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[VPS Engine] Error querying ps on Linux:', e.message);
                }
            }
        } catch (e) {
            console.warn('[VPS Engine] Error in reapZombieProcesses:', e.message);
        }

        this.lastReapTime = Date.now();
        return { reapedCount };
    }

    /**
     * Clear browser cache files, Crashpad reports, and scratch files to preserve VPS disk space
     */
    pruneDiskBloat() {
        let freedBytes = 0;
        const targetDirsToClean = [];

        // 1. Inspect profiles directory for cache folders
        if (fs.existsSync(this.profilesDir)) {
            const findCaches = (dir) => {
                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            if (['Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'Crashpad', 'Service Worker'].includes(entry.name)) {
                                targetDirsToClean.push(fullPath);
                            } else {
                                findCaches(fullPath);
                            }
                        }
                    }
                } catch (e) {}
            };
            findCaches(this.profilesDir);
        }

        // Delete cache directories
        for (const dir of targetDirsToClean) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
                freedBytes += 1024 * 1024 * 5; // Estimated 5MB per cache dir
            } catch (e) {}
        }

        // 2. Clean scratch HTML dump files in root
        try {
            const rootFiles = fs.readdirSync(this.rootDir);
            for (const f of rootFiles) {
                if (f.startsWith('scratch_html') && f.endsWith('.html')) {
                    const filePath = path.join(this.rootDir, f);
                    try {
                        const s = fs.statSync(filePath);
                        freedBytes += s.size;
                        fs.unlinkSync(filePath);
                    } catch (e) {}
                }
            }
        } catch (e) {}

        const freedMb = (freedBytes / (1024 * 1024)).toFixed(1);
        console.log(`[VPS Engine] 🗑️ Disk bloat pruned: ~${freedMb}MB freed across ${targetDirsToClean.length} cache folders.`);
        return { freedMb, cleanedDirsCount: targetDirsToClean.length };
    }

    /**
     * Memory pressure analysis and safe concurrency calculator
     */
    getMemoryHealth() {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const freePercent = (freeMem / totalMem) * 100;
        const freeMb = Math.round(freeMem / (1024 * 1024));

        let pressure = 'low'; // low, moderate, critical
        if (freePercent < 15 || freeMb < 250) {
            pressure = 'critical';
        } else if (freePercent < 30 || freeMb < 600) {
            pressure = 'moderate';
        }

        // Calculate safe concurrent bots for this VPS node
        // A single lightweight headless Chrome instance needs ~400MB - 600MB
        let safeConcurrency = 1;
        if (freeMb >= 2000) {
            safeConcurrency = 3;
        } else if (freeMb >= 1200) {
            safeConcurrency = 2;
        } else {
            safeConcurrency = 1;
        }

        return {
            pressure,
            freeMb,
            freePercent: Math.round(freePercent),
            safeConcurrency,
            warning: pressure === 'critical' ? 'CRITICAL LOW MEMORY: VPS at risk of OOM crash. Concurrency throttled.' : null
        };
    }

    /**
     * Start background hygiene loop (runs zombie reaper and memory check periodically)
     */
    startWatchdog(intervalMinutes = 10) {
        if (this.activeWatchdog) clearInterval(this.activeWatchdog);

        const intervalMs = intervalMinutes * 60 * 1000;
        this.activeWatchdog = setInterval(() => {
            const health = this.getMemoryHealth();
            if (health.pressure === 'critical') {
                console.warn(`[VPS Engine] ⚠️ Memory Watchdog Alert: Free RAM is only ${health.freeMb}MB (${health.freePercent}%). Triggering emergency reap...`);
                this.reapZombieProcesses();
                if (global.gc) {
                    try { global.gc(); } catch (e) {}
                }
            } else {
                this.reapZombieProcesses();
            }
        }, intervalMs);

        if (this.activeWatchdog.unref) {
            this.activeWatchdog.unref();
        }
    }
}

const vpsEngine = new VPSEngine();

// CLI handling for direct terminal use
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.includes('--status')) {
        const detection = vpsEngine.detectVPSEnvironment();
        const health = vpsEngine.getMemoryHealth();
        const isEnabled = vpsEngine.isVPSEnabled();

        console.log('\n======================================================');
        console.log('             BETTOR-VFL VPS ENGINE DIAGNOSTICS        ');
        console.log('======================================================');
        console.log(`VPS Engine Status : ${isEnabled ? '✅ ACTIVE' : 'ℹ️ INACTIVE'}`);
        console.log(`Auto-Detected VPS : ${detection.isVPS ? 'YES' : 'NO'}`);
        console.log(`Resource Profile  : ${detection.profile.toUpperCase()}`);
        console.log(`System Memory     : ${detection.metrics.freeMemMb}MB free / ${detection.metrics.totalMemMb}MB total (${detection.metrics.freeMemPercent}%)`);
        console.log(`CPU Cores         : ${detection.metrics.cpuCores}`);
        console.log(`Memory Pressure   : ${health.pressure.toUpperCase()}`);
        console.log(`Safe Concurrency  : Max ${health.safeConcurrency} concurrent bot(s)`);
        if (detection.reasons.length > 0) {
            console.log('\nDetection Indicators:');
            detection.reasons.forEach(r => console.log(`   ↳ ${r}`));
        }
        console.log('======================================================\n');
    } else if (args.includes('--clean')) {
        console.log('Running VPS hygiene & bloat cleanup...');
        const zombieResult = vpsEngine.reapZombieProcesses();
        const diskResult = vpsEngine.pruneDiskBloat();
        console.log(`Cleanup complete: ${zombieResult.reapedCount} zombie(s) reaped, ~${diskResult.freedMb}MB disk space cleared.`);
    } else {
        console.log('Usage: node utils/vps_engine.js [--status | --clean]');
    }
}

module.exports = vpsEngine;
