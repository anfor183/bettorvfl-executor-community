if (require('./utils/ensure_nigeria_vpn').ensureNigeriaVpn()) return;
const fs = require('fs');
const path = require('path');
const { scrapeAndPredictLiveSeason } = require('./utils/live_companion.js');
const vpsEngine = require('./utils/vps_engine.js');

// Helper to log with timestamp
function log(msg, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    let prefix = 'ℹ️';
    if (type === 'success') prefix = '✅';
    if (type === 'error') prefix = '❌';
    if (type === 'warn') prefix = '⚠️';
    if (type === 'working') prefix = '⏳';
    console.log(`[${timestamp}] ${prefix} ${msg}`);
}

async function startScheduler() {
    console.clear();
    console.log('========================================================');
    console.log('    BET9JA VIRTUAL FOOTBALL LIVE SCRAPER SCHEDULER      ');
    console.log('========================================================');

    // Load configurations from bot_settings.json
    let settings = {};
    const settingsPath = path.join(__dirname, 'bot_settings.json');
    if (fs.existsSync(settingsPath)) {
        try {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        } catch (e) {
            log(`Failed to read bot_settings.json: ${e.message}`, 'warn');
        }
    }

    let rawOutputDir = settings.outputDir || 'Virtual FootBall Data';
    let outputDir = path.isAbsolute(rawOutputDir) ? rawOutputDir : path.resolve(__dirname, rawOutputDir);
    if (!fs.existsSync(outputDir)) {
        const localFallback = path.resolve(__dirname, 'Virtual FootBall Data');
        if (fs.existsSync(localFallback)) {
            outputDir = localFallback;
        } else {
            try { fs.mkdirSync(outputDir, { recursive: true }); } catch (e) { outputDir = __dirname; }
        }
    }
    log(`Output Directory: ${outputDir}`);

    // Parse command line arguments
    // Usage: node auto_live_scheduler.js [dbFile] [intervalMinutes] [isHeadless]
    const args = process.argv.slice(2);
    let dbFile = args[0];
    let intervalMinutes = parseFloat(args[1]) || 3; // Default 3 minutes
    let isHeadless = args[2] !== 'false'; // Default headless: true

    // Auto-detect db file if not provided
    if (!dbFile) {
        log('No database file specified. Searching in output directory...', 'info');
        if (fs.existsSync(outputDir)) {
            const files = fs.readdirSync(outputDir)
                .filter(f => f.endsWith('.db'))
                .map(f => ({
                    name: f,
                    path: path.join(outputDir, f),
                    mtime: fs.statSync(path.join(outputDir, f)).mtime
                }))
                .sort((a, b) => b.mtime - a.mtime); // Sort newest first

            if (files.length > 0) {
                dbFile = files[0].name;
                log(`Detected most recently modified database: "${dbFile}"`, 'success');
            } else {
                log('No database files (.db) found in output directory.', 'error');
                console.log('\nPlease run the dashboard first, or create a database using the dashboard.');
                process.exit(1);
            }
        } else {
            log(`Output directory "${outputDir}" does not exist.`, 'error');
            process.exit(1);
        }
    }

    const dbPath = path.isAbsolute(dbFile) ? dbFile : path.join(outputDir, dbFile);
    if (!fs.existsSync(dbPath)) {
        log(`Database file not found at: ${dbPath}`, 'error');
        process.exit(1);
    }

    log(`Target Database: ${dbPath}`);
    log(`Schedule Interval: Every ${intervalMinutes} minute(s)`);
    log(`Scraper Mode: ${isHeadless ? 'Headless (Background)' : 'Headed (Browser Visible)'}`);

    const isVPS = vpsEngine.isVPSEnabled();
    const vpsDet = vpsEngine.detectVPSEnvironment();
    const memHealth = vpsEngine.getMemoryHealth();
    log(`VPS Optimization Engine: ${isVPS ? 'ACTIVE (' + vpsDet.profile.toUpperCase() + ')' : 'STANDBY'}`);
    log(`System RAM: ${memHealth.freeMb}MB free (${memHealth.freePercent}%) | Pressure: ${memHealth.pressure.toUpperCase()}`);
    if (memHealth.warning) log(memHealth.warning, 'warn');
    console.log('========================================================\n');

    let isRunning = false;
    let runCount = 0;

    const runScraperPass = async () => {
        if (isRunning) {
            log('Previous scrape cycle is still running. Skipping this tick to prevent overlaps.', 'warn');
            return;
        }

        // Memory pressure check before launching browser pass
        const currentHealth = vpsEngine.getMemoryHealth();
        if (currentHealth.pressure === 'critical') {
            log(`⚠️ Memory is critically low (${currentHealth.freeMb}MB free). Running emergency cache & zombie purge...`, 'warn');
            vpsEngine.reapZombieProcesses();
            vpsEngine.pruneDiskBloat();
            if (global.gc) {
                try { global.gc(); } catch (e) {}
            }
        }

        isRunning = true;
        runCount++;
        log(`Starting Scrape Run #${runCount}...`, 'working');

        try {
            // Call the live companion scraper
            const result = await scrapeAndPredictLiveSeason(dbPath, isHeadless);
            
            if (result.success) {
                log(`Run #${runCount} Completed Successfully!`, 'success');
                console.log(`   ↳ Season: ${result.seasonName}`);
                console.log(`   ↳ Matches Played: ${result.playedCount}`);
                console.log(`   ↳ Matches Unplayed: ${result.unplayedCount}`);
                console.log(`   ↳ New Predictions Created: ${result.predictionsCreated}`);
                console.log(`   ↳ Existing Predictions Scored: ${result.predictionsScored}`);
            } else {
                log(`Run #${runCount} Failed: ${result.error || 'Unknown error'}`, 'error');
            }
        } catch (err) {
            log(`Fatal error during scrape run #${runCount}: ${err.message}`, 'error');
            if (err.stack) console.error(err.stack);
        } finally {
            isRunning = false;

            // Run process hygiene between passes to prevent zombie accumulations
            if (isVPS) {
                const reap = vpsEngine.reapZombieProcesses();
                if (reap.reapedCount > 0) {
                    log(`VPS Hygiene: Cleaned up ${reap.reapedCount} lingering zombie process(es)`, 'info');
                }
            }

            log(`Next run scheduled in ${intervalMinutes} minute(s)...`, 'info');
            console.log('────────────────────────────────────────────────────────');
        }
    };

    // Run first pass immediately
    await runScraperPass();

    // Setup interval loop
    const intervalMs = intervalMinutes * 60 * 1000;
    const intervalId = setInterval(runScraperPass, intervalMs);

    // Handle clean shutdown
    process.on('SIGINT', () => {
        console.log('\n');
        log('Gracefully shutting down scheduler. Please wait...', 'working');
        clearInterval(intervalId);
        log('Scheduler stopped.', 'success');
        process.exit(0);
    });
}

startScheduler();
