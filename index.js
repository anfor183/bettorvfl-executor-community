/**
 * Nexus VFL Automated Bet Execution Engine & Nexus Panel
 * 
 * Provides automated match telemetry tracking, market odds analysis,
 * and deterministic wager execution for virtual football leagues.
 */

function printUsage() {
    console.log('========================================================');
    console.log('   NEXUS VFL AUTOMATED EXECUTION ENGINE & NEXUS PANEL   ');
    console.log('========================================================');
    console.log('\nAvailable Commands:');
    console.log('  node bet_executor.js       - Launch automated bet execution engine');
    console.log('  node auto_live_scheduler.js - Launch live companion season scheduler');
    console.log('  npm run dashboard          - Launch Nexus Panel Electron/React GUI');
    console.log('  npm run vps:check          - Check VPS memory health and resource status');
    console.log('  npm run vps:clean          - Run zombie process reaper and cache cleaner');
    console.log('\nFor automated wager placement options, see:');
    console.log('  node bet_executor.js --help');
    console.log('========================================================');
}

if (require.main === module) {
    printUsage();
}

module.exports = {
    getConfig: () => require('./config'),
    getLogger: () => require('./utils/logger'),
    getDb: () => require('./utils/db'),
    getVpsEngine: () => require('./utils/vps_engine')
};
