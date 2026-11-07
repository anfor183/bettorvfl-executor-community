if (require('./utils/ensure_nigeria_vpn').ensureNigeriaVpn()) return;
const os = require('os');
const fs = require('fs');
const path = require('path');
const browserConfig = require('./browser-config.json');
const { setupNetworkTracker } = require('./utils/network-tracker');
const vpsEngine = require('./utils/vps_engine');

// Prevent stray CDP / Protocol timeouts from crashing Node processes unexpectedly
process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason || '');
    if (msg.includes('ProtocolError') || msg.includes('Network.enable timed out') || msg.includes('Target closed') || msg.includes('Session closed')) {
        console.warn('⚠️ [Suppressed background CDP protocol warning]:', msg);
        return;
    }
    console.error('Unhandled Promise Rejection:', reason);
});

// Parse command line arguments
const args = process.argv.slice(2);
const userDataDirArg = args.find(arg => arg.startsWith('--user-data-dir='))?.split('=')[1];
const headlessArgVal = args.find(arg => arg.startsWith('--headless='))?.split('=')[1];
const defaultHeadless = headlessArgVal === 'true' || args.includes('--headless');

// Universal path resolver for portability across PCs and operating systems
function resolveUniversalPath(targetPath, defaultRelative) {
    if (!targetPath) return path.resolve(__dirname, defaultRelative);
    if (!path.isAbsolute(targetPath)) return path.resolve(__dirname, targetPath);
    if (fs.existsSync(targetPath)) return targetPath;
    
    const fallbackPath = path.resolve(__dirname, defaultRelative);
    if (fs.existsSync(fallbackPath)) return fallbackPath;
    return targetPath;
}

function resolveUniversalChromePath(configuredPath) {
    if (configuredPath) {
        if (!path.isAbsolute(configuredPath)) {
            const rel = path.resolve(__dirname, configuredPath);
            if (fs.existsSync(rel) && (process.platform === 'win32' || !rel.endsWith('.exe'))) return rel;
        } else if (fs.existsSync(configuredPath)) {
            if (process.platform === 'win32' || !configuredPath.endsWith('.exe')) return configuredPath;
        }
    }

    // 1. Check local chrome directory in project for downloaded versions matching current platform
    const chromeDir = path.resolve(__dirname, 'chrome');
    if (fs.existsSync(chromeDir)) {
        try {
            const entries = fs.readdirSync(chromeDir);
            for (const entry of entries) {
                const entryPath = path.join(chromeDir, entry);
                if (fs.statSync(entryPath).isDirectory()) {
                    let candidates = [];
                    if (process.platform === 'linux') {
                        candidates = [
                            path.join(entryPath, 'chrome-linux64', 'chrome'),
                            path.join(entryPath, 'chrome')
                        ];
                    } else if (process.platform === 'win32') {
                        candidates = [
                            path.join(entryPath, 'chrome-win64', 'chrome.exe'),
                            path.join(entryPath, 'chrome-win32', 'chrome.exe'),
                            path.join(entryPath, 'chrome.exe')
                        ];
                    } else if (process.platform === 'darwin') {
                        candidates = [
                            path.join(entryPath, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
                            path.join(entryPath, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
                        ];
                    }
                    for (const cand of candidates) {
                        if (fs.existsSync(cand)) return cand;
                    }
                }
            }
        } catch (e) {}
    }

    // 2. Platform-specific standard system locations
    const systemPaths = [];
    if (process.platform === 'linux') {
        systemPaths.push(
            path.join(os.homedir(), '.local', 'bin', 'google-chrome'),
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
            '/snap/bin/google-chrome'
        );
    } else if (process.platform === 'win32') {
        systemPaths.push(
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(process.env.PROGRAMFILES || '', 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google\\Chrome\\Application\\chrome.exe')
        );
    } else if (process.platform === 'darwin') {
        systemPaths.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium'
        );
    }

    for (const p of systemPaths) {
        if (p && fs.existsSync(p)) return p;
    }

    return null;
}

const resolvedChrome = resolveUniversalChromePath(browserConfig.paths?.chrome);
const resolvedUserDataDir = resolveUniversalPath(userDataDirArg || browserConfig.paths?.userDataDir, 'profiles/DEFAULT');
const resolvedCursorPath = resolveUniversalPath(browserConfig.paths?.cursorPath, 'gold_mouse.png');

const customConfig = {
    executablePath: resolvedChrome,
    chromePath: resolvedChrome,
    userDataDir: resolvedUserDataDir,
    profilePath: browserConfig.paths?.profilePath || 'Default',
    cursorPath: resolvedCursorPath,
    args: [
        '--start-maximized',
        '--no-sandbox',
        '--disable-notifications',
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-session-crashed-bubble',
        '--hide-crash-restore-bubble',
        '--restore-last-session=false',
        '--disable-save-password-bubble',
        '--disable-prompt-on-repost',
        '--deny-permission-prompts'
    ],
    viewport: { width: 1366, height: 768 }
};

const deepSeekConfig = {
    apiKey: process.env.DEEPSEEK_API_KEY || browserConfig.ai?.deepseekApiKey || '',
    endpoint: process.env.DEEPSEEK_ENDPOINT || 'https://api.deepseek.com/v1'
};

const openAiConfig = {
    apiKey: process.env.OPENAI_API_KEY || browserConfig.ai?.openaiApiKey || '',
    model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
    temperature: 0.1,
    maxTokens: 5
};

async function fixCrashedSession(userDataDir, profilePath = 'Default') {
    if (!userDataDir || !fs.existsSync(userDataDir)) return;

    const paths = [
        path.join(userDataDir, 'Preferences'),
        path.join(userDataDir, 'Local State')
    ];

    try {
        const files = fs.readdirSync(userDataDir);
        for (const file of files) {
            const fullPath = path.join(userDataDir, file);
            if (fs.statSync(fullPath).isDirectory()) {
                const prefPath = path.join(fullPath, 'Preferences');
                if (fs.existsSync(prefPath)) {
                    paths.push(prefPath);
                }
            }
        }
    } catch (e) {}

    if (profilePath) {
        paths.push(path.join(userDataDir, profilePath, 'Preferences'));
    }

    for (const preferencesPath of paths) {
        try {
            if (fs.existsSync(preferencesPath)) {
                let prefs = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
                let changed = false;
                if (prefs.profile) {
                    if (prefs.profile.exit_type !== 'Normal' || prefs.profile.exited_cleanly !== true) {
                        prefs.profile.exit_type = 'Normal';
                        prefs.profile.exited_cleanly = true;
                        changed = true;
                    }
                }
                if (prefs.browser) {
                    if (prefs.browser.exit_type !== 'Normal' || prefs.browser.exited_cleanly !== true) {
                        prefs.browser.exit_type = 'Normal';
                        prefs.browser.exited_cleanly = true;
                        changed = true;
                    }
                }
                if (changed) {
                    fs.writeFileSync(preferencesPath, JSON.stringify(prefs));
                }
            }
        } catch (e) {}
    }
}

/**
 * Connect to or launch the browser instance cleanly.
 */
const connect = async function (options = {}) {
    const isHeadless = options.headless !== undefined ? options.headless : defaultHeadless;
    const targetUserDataDir = options.userDataDir || customConfig.userDataDir;
    const targetExecutablePath = options.executablePath || customConfig.executablePath || undefined;

    const puppeteer = require('puppeteer-real-browser');
    const proxyChain = require('proxy-chain');

    console.log('Attempting to connect to browser instance...');
    const isVPSEnabled = vpsEngine.isVPSEnabled();
    if (isVPSEnabled) {
        console.log('⚡ [VPS Engine] Active: Low-resource profile enabled for consistent VPS stability');
        if (browserConfig.vps?.autoReapZombies !== false) {
            vpsEngine.startWatchdog(browserConfig.vps?.reapIntervalMinutes || 10);
        }
    }

    // Proxy configuration resolution
    let connectionMode = 'direct';
    let activeProxyDetails = null;
    let proxyServerArg = null;

    if (browserConfig.proxy?.enabled && browserConfig.proxy?.host && browserConfig.proxy?.port) {
        try {
            let proxyUrl = `${browserConfig.proxy.protocol || 'http'}://`;
            if (browserConfig.proxy.username && browserConfig.proxy.password) {
                proxyUrl += `${encodeURIComponent(browserConfig.proxy.username)}:${encodeURIComponent(browserConfig.proxy.password)}@`;
            }
            proxyUrl += `${browserConfig.proxy.host}:${browserConfig.proxy.port}`;
            
            const anonymized = await proxyChain.anonymizeProxy(proxyUrl);
            proxyServerArg = `--proxy-server=${anonymized}`;
            connectionMode = 'proxy';
            activeProxyDetails = {
                host: browserConfig.proxy.host,
                port: browserConfig.proxy.port,
                protocol: browserConfig.proxy.protocol || 'http',
                username: browserConfig.proxy.username || ''
            };
        } catch (proxyError) {
            console.warn('⚠️ Proxy initialization warning, proceeding with direct connection:', proxyError.message);
        }
    }

    const browserArgs = [
        '--disable-features=Notifications,GeolocationAPI,SavePasswordBubble,Translate',
        '--disable-save-password-bubble',
        '--password-store=basic',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        '--disable-geolocation',
        '--deny-permission-prompts',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling'
    ];

    if (proxyServerArg) {
        browserArgs.push(proxyServerArg);
    }

    // Apply VPS Engine optimizations
    const optimizedArgs = vpsEngine.getOptimizedBrowserArgs(browserArgs, {
        forceVPS: isVPSEnabled,
        rendererLimit: browserConfig.vps?.rendererProcessLimit || 1,
        maxV8MemoryMb: browserConfig.vps?.maxV8MemoryMb || 256,
        blockHeavyMedia: browserConfig.vps?.blockHeavyMedia || false
    });

    if (targetUserDataDir && !fs.existsSync(targetUserDataDir)) {
        try {
            fs.mkdirSync(targetUserDataDir, { recursive: true });
        } catch (e) {}
    }

    await fixCrashedSession(targetUserDataDir, customConfig.profilePath);

    const browserOptions = {
        headless: isHeadless ? 'new' : false,
        executablePath: targetExecutablePath,
        userDataDir: targetUserDataDir,
        turnstile: false,
        connectOption: {
            defaultViewport: null,
            protocolTimeout: 180000,
            timeout: 180000
        },
        disableXvfb: process.platform === 'linux',
        args: optimizedArgs
    };

    try {
        const { page, browser } = await puppeteer.connect(browserOptions);

        async function setupPage(_page) {
            try {
                const profileLabel = targetUserDataDir
                    ? (targetUserDataDir.includes(os.tmpdir()) ? 'temp_session' : path.basename(targetUserDataDir))
                    : 'direct_session';
                setupNetworkTracker(_page, targetUserDataDir, {
                    mode: connectionMode,
                    proxy: activeProxyDetails,
                    profileName: profileLabel
                }).catch(() => {});
            } catch (trackerErr) {}

            try {
                await _page.setViewport({ width: 1366, height: 768 });
            } catch (e) {}
        }

        browser.on('targetcreated', async (target) => {
            try {
                const newPage = await target.page();
                if (newPage && !newPage.isClosed()) {
                    await newPage.setDefaultNavigationTimeout(360000);
                    await newPage.setDefaultTimeout(360000);
                    await setupPage(newPage);
                }
            } catch (e) {}
        });

        browser.on('disconnected', () => {
            console.log('Browser disconnected');
        });

        await setupPage(page);

        console.log('✅ Successfully connected to browser instance');
        return page;
    } catch (error) {
        console.error('Browser connection error:', error.message);
        throw error;
    }
};

module.exports = {
    customConfig,
    connect,
    deepSeekConfig,
    vpsEngine,
    featureFlags: browserConfig.features || {},
    openAiConfig,
    resolveUniversalChromePath,
    resolveUniversalPath
};