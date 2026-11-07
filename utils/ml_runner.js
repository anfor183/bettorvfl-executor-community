process.env.ML_RUNNER = 'true';
const mlPredictor = require('./ml_predictor.js');
const { predictMatchupML, optimizeBlendingWeights, runBacktestML } = mlPredictor;
const { analysePatterns } = require('./pattern_analyzer.js');
const liveCompanion = require('./live_companion.js');
const { scrapeAndPredictLiveSeason, getLivePredictions } = liveCompanion;

const args = process.argv.slice(2);
const command = args[0]; // 'predict', 'optimize', 'backtest', 'analyse-patterns', 'scrape-live-season', 'get-live-predictions'

if (command === 'predict') {
    const dbPath = args[1];
    const homeTeam = args[2];
    const awayTeam = args[3];
    try {
        const result = predictMatchupML(dbPath, homeTeam, awayTeam);
        console.log(JSON.stringify(result));
    } catch (e) {
        console.error(JSON.stringify({ success: false, error: e.message }));
        process.exit(1);
    }
} else if (command === 'optimize') {
    const dbPath = args[1];
    try {
        const result = optimizeBlendingWeights(dbPath);
        console.log(JSON.stringify(result));
    } catch (e) {
        console.error(JSON.stringify({ success: false, error: e.message }));
        process.exit(1);
    }
} else if (command === 'backtest') {
    const dbPath = args[1];
    const seasonName = args.slice(2).join(' ');
    try {
        const result = runBacktestML(dbPath, seasonName);
        console.log(JSON.stringify(result));
    } catch (e) {
        console.error(JSON.stringify({ success: false, error: e.message }));
        process.exit(1);
    }
} else if (command === 'analyse-patterns') {
    const dbPath = args[1];
    try {
        const result = analysePatterns(dbPath);
        console.log(JSON.stringify(result));
    } catch (e) {
        console.error(JSON.stringify({ success: false, error: e.message }));
        process.exit(1);
    }
} else if (command === 'scrape-live-season') {
    const dbPath = args[1];
    const isHeadless = args[2] !== 'false';
    scrapeAndPredictLiveSeason(dbPath, isHeadless)
        .then(result => {
            console.log(JSON.stringify(result));
            process.exit(0);
        })
        .catch(e => {
            console.error(JSON.stringify({ success: false, error: e.message }));
            process.exit(1);
        });
} else if (command === 'get-live-predictions') {
    const dbPath = args[1];
    try {
        const result = getLivePredictions(dbPath);
        console.log(JSON.stringify(result));
    } catch (e) {
        console.error(JSON.stringify({ success: false, error: e.message }));
        process.exit(1);
    }
} else {
    console.error(JSON.stringify({ success: false, error: 'Unknown command' }));
    process.exit(1);
}
