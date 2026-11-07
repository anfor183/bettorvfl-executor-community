const fs = require('fs');
const path = require('path');
const os = require('os');

const GLOBAL_USAGE_FILE = path.resolve(__dirname, '..', 'global_network_usage.json');

/**
 * Global Network Usage Tracker that tracks aggregate bandwidth across all sessions
 * (including temporary bot runs, background scrapers, and permanent profiles).
 */
class GlobalNetworkTracker {
    constructor() {
        this.filePath = GLOBAL_USAGE_FILE;
        this.saveTimeout = null;
        this.data = this.getDefaultData();
        this.load();
    }

    getDefaultData() {
        return {
            totalBytes: 0,
            downloadBytes: 0,
            uploadBytes: 0,
            requests: 0,
            direct: {
                totalBytes: 0,
                downloadBytes: 0,
                uploadBytes: 0,
                requests: 0,
                domains: {}
            },
            proxy: {
                totalBytes: 0,
                downloadBytes: 0,
                uploadBytes: 0,
                requests: 0,
                domains: {},
                proxies: {} // 'host:port' -> { totalBytes, downloadBytes, uploadBytes, requests, protocol, lastUsed }
            },
            history: {}, // 'YYYY-MM-DD' -> { direct: { totalBytes, requests }, proxy: { totalBytes, requests }, totalBytes, requests }
            sessions: [], // Ring buffer of recent sessions
            lastUpdated: new Date().toISOString()
        };
    }

    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf8');
                const parsed = JSON.parse(raw);
                this.data = this.normalize(parsed);
            } else {
                this.save();
            }
        } catch (e) {
            console.error('❌ [Global Network Tracker] Error loading:', e.message);
            this.data = this.getDefaultData();
        }
    }

    normalize(parsed) {
        const d = this.getDefaultData();
        if (!parsed || typeof parsed !== 'object') return d;

        d.totalBytes = parsed.totalBytes || 0;
        d.downloadBytes = parsed.downloadBytes || 0;
        d.uploadBytes = parsed.uploadBytes || 0;
        d.requests = parsed.requests || 0;

        if (parsed.direct) {
            d.direct.totalBytes = parsed.direct.totalBytes || 0;
            d.direct.downloadBytes = parsed.direct.downloadBytes || 0;
            d.direct.uploadBytes = parsed.direct.uploadBytes || 0;
            d.direct.requests = parsed.direct.requests || 0;
            d.direct.domains = parsed.direct.domains || {};
        }

        if (parsed.proxy) {
            d.proxy.totalBytes = parsed.proxy.totalBytes || 0;
            d.proxy.downloadBytes = parsed.proxy.downloadBytes || 0;
            d.proxy.uploadBytes = parsed.proxy.uploadBytes || 0;
            d.proxy.requests = parsed.proxy.requests || 0;
            d.proxy.domains = parsed.proxy.domains || {};
            d.proxy.proxies = parsed.proxy.proxies || {};
        }

        d.history = parsed.history || {};
        d.sessions = Array.isArray(parsed.sessions) ? parsed.sessions.slice(-100) : [];
        d.lastUpdated = parsed.lastUpdated || new Date().toISOString();
        return d;
    }

    save() {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            this.data.lastUpdated = new Date().toISOString();
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
        } catch (e) {
            console.error('❌ [Global Network Tracker] Error saving:', e.message);
        }
    }

    throttledSave() {
        if (this.saveTimeout) return;
        this.saveTimeout = setTimeout(() => {
            this.save();
            this.saveTimeout = null;
        }, 2000);
    }

    recordTransfer({ domain, downloadBytes = 0, uploadBytes = 0, mode = 'direct', proxy = null, profileName = 'unknown' }) {
        const total = (downloadBytes || 0) + (uploadBytes || 0);
        if (total <= 0) return;

        this.data.totalBytes += total;
        this.data.downloadBytes += downloadBytes;
        this.data.uploadBytes += uploadBytes;
        this.data.requests += 1;

        const targetBucket = mode === 'proxy' ? this.data.proxy : this.data.direct;
        targetBucket.totalBytes += total;
        targetBucket.downloadBytes += downloadBytes;
        targetBucket.uploadBytes += uploadBytes;
        targetBucket.requests += 1;

        // Domain breakdown inside bucket
        if (domain && domain !== 'unknown') {
            if (!targetBucket.domains[domain]) {
                targetBucket.domains[domain] = { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0 };
            }
            targetBucket.domains[domain].totalBytes += total;
            targetBucket.domains[domain].downloadBytes += downloadBytes;
            targetBucket.domains[domain].uploadBytes += uploadBytes;
            targetBucket.domains[domain].requests += 1;
        }

        // Proxy fleet breakdown
        if (mode === 'proxy' && proxy && proxy.host) {
            const proxyKey = `${proxy.host}:${proxy.port || 80}`;
            if (!this.data.proxy.proxies[proxyKey]) {
                this.data.proxy.proxies[proxyKey] = {
                    host: proxy.host,
                    port: proxy.port || 80,
                    protocol: proxy.protocol || 'http',
                    totalBytes: 0,
                    downloadBytes: 0,
                    uploadBytes: 0,
                    requests: 0,
                    lastUsed: new Date().toISOString()
                };
            }
            const pEntry = this.data.proxy.proxies[proxyKey];
            pEntry.totalBytes += total;
            pEntry.downloadBytes += downloadBytes;
            pEntry.uploadBytes += uploadBytes;
            pEntry.requests += 1;
            pEntry.lastUsed = new Date().toISOString();
        }

        // Daily history breakdown
        const today = new Date().toISOString().slice(0, 10);
        if (!this.data.history[today]) {
            this.data.history[today] = {
                direct: { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0 },
                proxy: { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0 },
                totalBytes: 0,
                requests: 0
            };
        }
        const histDay = this.data.history[today];
        histDay.totalBytes += total;
        histDay.requests += 1;
        const histBucket = mode === 'proxy' ? histDay.proxy : histDay.direct;
        histBucket.totalBytes += total;
        histBucket.downloadBytes += downloadBytes;
        histBucket.uploadBytes += uploadBytes;
        histBucket.requests += 1;

        this.throttledSave();
    }

    clear(scope = 'all') {
        if (scope === 'all') {
            this.data = this.getDefaultData();
        } else if (scope === 'direct') {
            this.data.totalBytes -= this.data.direct.totalBytes;
            this.data.downloadBytes -= this.data.direct.downloadBytes;
            this.data.uploadBytes -= this.data.direct.uploadBytes;
            this.data.requests -= this.data.direct.requests;
            this.data.direct = { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0, domains: {} };
        } else if (scope === 'proxy') {
            this.data.totalBytes -= this.data.proxy.totalBytes;
            this.data.downloadBytes -= this.data.proxy.downloadBytes;
            this.data.uploadBytes -= this.data.proxy.uploadBytes;
            this.data.requests -= this.data.proxy.requests;
            this.data.proxy = { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0, domains: {}, proxies: {} };
        }
        this.save();
    }
}

const globalNetworkTracker = new GlobalNetworkTracker();

/**
 * Tracks network data usage and enforces limits on a per-profile and per-domain basis.
 */
class NetworkTracker {
    constructor(profilePath, connectionContext = {}) {
        this.profilePath = profilePath;
        this.isTemp = !profilePath || profilePath.includes(os.tmpdir());
        this.usageFilePath = profilePath ? path.join(profilePath, 'network_usage.json') : null;
        this.connectionContext = {
            mode: connectionContext.mode || 'direct', // 'direct' or 'proxy'
            proxy: connectionContext.proxy || null, // { host, port, protocol, username }
            profileName: connectionContext.profileName || (profilePath ? path.basename(profilePath) : 'ephemeral')
        };

        this.data = this.getDefaultData();
        this.saveTimeout = null;

        if (this.usageFilePath) {
            this.loadUsage();
        }
    }

    setConnectionContext(ctx = {}) {
        if (ctx.mode) this.connectionContext.mode = ctx.mode;
        if (ctx.proxy !== undefined) this.connectionContext.proxy = ctx.proxy;
        if (ctx.profileName) this.connectionContext.profileName = ctx.profileName;
    }

    getDefaultData() {
        return {
            totalBytes: 0,
            downloadBytes: 0,
            uploadBytes: 0,
            requests: 0,
            limitBytes: null, // null = unlimited
            direct: {
                totalBytes: 0,
                downloadBytes: 0,
                uploadBytes: 0,
                requests: 0,
                domains: {}
            },
            proxy: {
                totalBytes: 0,
                downloadBytes: 0,
                uploadBytes: 0,
                requests: 0,
                domains: {},
                proxies: {} // 'host:port' -> { totalBytes, downloadBytes, uploadBytes, requests, lastUsed }
            },
            domains: {},
            lastUpdated: new Date().toISOString()
        };
    }

    loadUsage() {
        try {
            if (this.usageFilePath && fs.existsSync(this.usageFilePath)) {
                const content = fs.readFileSync(this.usageFilePath, 'utf8');
                const parsed = JSON.parse(content);
                this.data = this.normalize(parsed);
            } else if (this.usageFilePath && !this.isTemp) {
                this.saveUsage();
            }
        } catch (e) {
            console.error('❌ Error loading network usage:', e.message);
            this.data = this.getDefaultData();
        }
    }

    normalize(parsed) {
        const d = this.getDefaultData();
        if (!parsed || typeof parsed !== 'object') return d;

        d.totalBytes = parsed.totalBytes || 0;
        d.downloadBytes = parsed.downloadBytes || parsed.totalBytes || 0;
        d.uploadBytes = parsed.uploadBytes || 0;
        d.requests = parsed.requests || 0;
        d.limitBytes = parsed.limitBytes !== undefined ? parsed.limitBytes : null;

        if (parsed.direct) {
            d.direct.totalBytes = parsed.direct.totalBytes || 0;
            d.direct.downloadBytes = parsed.direct.downloadBytes || 0;
            d.direct.uploadBytes = parsed.direct.uploadBytes || 0;
            d.direct.requests = parsed.direct.requests || 0;
            d.direct.domains = parsed.direct.domains || {};
        }

        if (parsed.proxy) {
            d.proxy.totalBytes = parsed.proxy.totalBytes || 0;
            d.proxy.downloadBytes = parsed.proxy.downloadBytes || 0;
            d.proxy.uploadBytes = parsed.proxy.uploadBytes || 0;
            d.proxy.requests = parsed.proxy.requests || 0;
            d.proxy.domains = parsed.proxy.domains || {};
            d.proxy.proxies = parsed.proxy.proxies || {};
        }

        // Normalize domains
        if (parsed.domains && typeof parsed.domains === 'object') {
            for (const [dom, domData] of Object.entries(parsed.domains)) {
                d.domains[dom] = {
                    bytes: domData.bytes || domData.totalBytes || 0,
                    directBytes: domData.directBytes !== undefined ? domData.directBytes : 0,
                    proxyBytes: domData.proxyBytes !== undefined ? domData.proxyBytes : 0,
                    downloadBytes: domData.downloadBytes || domData.bytes || 0,
                    uploadBytes: domData.uploadBytes || 0,
                    requests: domData.requests || 0,
                    limitBytes: domData.limitBytes !== undefined ? domData.limitBytes : null
                };
            }
        }

        // If legacy data had no direct/proxy split, estimate by attributing to direct if proxy is empty
        if (d.direct.totalBytes === 0 && d.proxy.totalBytes === 0 && d.totalBytes > 0) {
            d.direct.totalBytes = d.totalBytes;
            d.direct.downloadBytes = d.downloadBytes;
            d.direct.uploadBytes = d.uploadBytes;
            d.direct.requests = d.requests;
        }

        d.lastUpdated = parsed.lastUpdated || new Date().toISOString();
        return d;
    }

    saveUsage() {
        if (!this.usageFilePath || this.isTemp) return;
        try {
            if (!fs.existsSync(this.profilePath)) {
                fs.mkdirSync(this.profilePath, { recursive: true });
            }
            this.data.lastUpdated = new Date().toISOString();
            fs.writeFileSync(this.usageFilePath, JSON.stringify(this.data, null, 4), 'utf8');
        } catch (e) {
            console.error('❌ Error saving network usage:', e.message);
        }
    }

    throttledSave() {
        if (this.saveTimeout) return;
        this.saveTimeout = setTimeout(() => {
            this.saveUsage();
            this.saveTimeout = null;
        }, 2000);
    }

    /**
     * Record data transfer for a specific URL/domain
     */
    recordTransfer({ urlStr, downloadBytes = 0, uploadBytes = 0 }) {
        const total = (downloadBytes || 0) + (uploadBytes || 0);
        if (total <= 0) return;

        let domain = 'unknown';
        try {
            if (urlStr) {
                const url = new URL(urlStr);
                domain = url.hostname;
            }
        } catch (e) {}

        const mode = this.connectionContext.mode === 'proxy' ? 'proxy' : 'direct';
        const proxy = this.connectionContext.proxy;

        // 1. Update Profile Level Data
        this.data.totalBytes += total;
        this.data.downloadBytes += downloadBytes;
        this.data.uploadBytes += uploadBytes;
        this.data.requests += 1;

        const modeBucket = mode === 'proxy' ? this.data.proxy : this.data.direct;
        modeBucket.totalBytes += total;
        modeBucket.downloadBytes += downloadBytes;
        modeBucket.uploadBytes += uploadBytes;
        modeBucket.requests += 1;

        if (domain !== 'unknown') {
            // General domain map
            if (!this.data.domains[domain]) {
                this.data.domains[domain] = {
                    bytes: 0,
                    directBytes: 0,
                    proxyBytes: 0,
                    downloadBytes: 0,
                    uploadBytes: 0,
                    requests: 0,
                    limitBytes: null
                };
            }
            const dom = this.data.domains[domain];
            dom.bytes += total;
            dom.downloadBytes += downloadBytes;
            dom.uploadBytes += uploadBytes;
            dom.requests += 1;
            if (mode === 'proxy') {
                dom.proxyBytes = (dom.proxyBytes || 0) + total;
            } else {
                dom.directBytes = (dom.directBytes || 0) + total;
            }

            // Mode-specific domain map
            if (!modeBucket.domains[domain]) {
                modeBucket.domains[domain] = { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0 };
            }
            modeBucket.domains[domain].totalBytes += total;
            modeBucket.domains[domain].downloadBytes += downloadBytes;
            modeBucket.domains[domain].uploadBytes += uploadBytes;
            modeBucket.domains[domain].requests += 1;
        }

        // If proxy mode, record per-proxy endpoint
        if (mode === 'proxy' && proxy && proxy.host) {
            const proxyKey = `${proxy.host}:${proxy.port || 80}`;
            if (!this.data.proxy.proxies[proxyKey]) {
                this.data.proxy.proxies[proxyKey] = {
                    host: proxy.host,
                    port: proxy.port || 80,
                    protocol: proxy.protocol || 'http',
                    totalBytes: 0,
                    downloadBytes: 0,
                    uploadBytes: 0,
                    requests: 0,
                    lastUsed: new Date().toISOString()
                };
            }
            const pObj = this.data.proxy.proxies[proxyKey];
            pObj.totalBytes += total;
            pObj.downloadBytes += downloadBytes;
            pObj.uploadBytes += uploadBytes;
            pObj.requests += 1;
            pObj.lastUsed = new Date().toISOString();
        }

        this.throttledSave();

        // 2. Update Global Tracker
        globalNetworkTracker.recordTransfer({
            domain,
            downloadBytes,
            uploadBytes,
            mode,
            proxy,
            profileName: this.connectionContext.profileName
        });
    }

    /**
     * Backward-compatible recordBytes method
     */
    recordBytes(urlStr, bytes) {
        this.recordTransfer({ urlStr, downloadBytes: bytes, uploadBytes: 0 });
    }

    /**
     * Checks if the total limit or domain limit has been exceeded
     */
    isLimitExceeded(urlStr) {
        // Check overall limit
        if (this.data.limitBytes !== null && this.data.totalBytes >= this.data.limitBytes) {
            return { exceeded: true, type: 'total', limit: this.data.limitBytes };
        }

        try {
            if (urlStr) {
                const url = new URL(urlStr);
                const domain = url.hostname;
                const domainData = this.data.domains[domain];

                if (domainData && domainData.limitBytes !== null && domainData.bytes >= domainData.limitBytes) {
                    return { exceeded: true, type: 'domain', domain, limit: domainData.limitBytes };
                }
            }
        } catch (e) {}

        return { exceeded: false };
    }
}

// Global active trackers mapping (profilePath -> NetworkTracker)
const activeTrackers = {};

/**
 * Setup network monitoring on a Puppeteer page
 */
async function setupNetworkTracker(page, profilePath, connectionContext = {}) {
    if (!page) return null;

    const resolvedPath = profilePath ? path.resolve(profilePath) : 'ephemeral';
    let tracker = activeTrackers[resolvedPath];

    if (!tracker) {
        tracker = new NetworkTracker(profilePath ? resolvedPath : null, connectionContext);
        activeTrackers[resolvedPath] = tracker;
    } else if (connectionContext) {
        tracker.setConnectionContext(connectionContext);
    }

    // Avoid multiple listeners on the same page instance
    if (page._networkTrackerAttached) {
        return tracker;
    }
    page._networkTrackerAttached = true;

    try {
        // Enable request interception to enforce domain & total limits and measure upload sizes
        await page.setRequestInterception(true);

        page.on('request', (request) => {
            try {
                const check = tracker.isLimitExceeded(request.url());
                if (check.exceeded) {
                    if (check.type === 'total') {
                        console.warn(`🚫 [Network Quota] Total data limit of ${formatBytes(check.limit)} exceeded. Request blocked: ${request.url().substring(0, 80)}`);
                    } else {
                        console.warn(`🚫 [Network Quota] Domain limit of ${formatBytes(check.limit)} exceeded for ${check.domain}. Request blocked: ${request.url().substring(0, 80)}`);
                    }
                    request.abort('aborted');
                    return;
                }

                // Estimate request upload size (payload + headers)
                let uploadBytes = 0;
                const postData = request.postData();
                if (postData) {
                    uploadBytes += Buffer.byteLength(postData, 'utf8');
                }
                const reqHeaders = request.headers();
                if (reqHeaders) {
                    for (const [k, v] of Object.entries(reqHeaders)) {
                        uploadBytes += (k.length + (v ? String(v).length : 0) + 4);
                    }
                }

                if (uploadBytes > 0) {
                    tracker.recordTransfer({ urlStr: request.url(), downloadBytes: 0, uploadBytes });
                }

                request.continue().catch(() => {});
            } catch (e) {
                request.continue().catch(() => {});
            }
        });

        // Listen to network responses to track actual incoming download bandwidth
        page.on('response', async (response) => {
            try {
                const headers = response.headers();
                let downloadSize = 0;

                if (headers['content-length']) {
                    downloadSize = parseInt(headers['content-length'], 10);
                } else {
                    const buffer = await response.buffer().catch(() => null);
                    if (buffer) downloadSize = buffer.length;
                }

                // Add response headers approximate overhead
                if (headers) {
                    for (const [k, v] of Object.entries(headers)) {
                        downloadSize += (k.length + (v ? String(v).length : 0) + 4);
                    }
                }

                if (downloadSize > 0) {
                    tracker.recordTransfer({ urlStr: response.url(), downloadBytes: downloadSize, uploadBytes: 0 });
                }
            } catch (e) {
                // Ignore response read failures (e.g. navigation redirects or connections closed)
            }
        });
    } catch (err) {
        console.warn('⚠️ Could not attach network tracker interception:', err.message);
    }

    return tracker;
}

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = {
    setupNetworkTracker,
    NetworkTracker,
    GlobalNetworkTracker,
    globalNetworkTracker,
    activeTrackers,
    formatBytes
};
