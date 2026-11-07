const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const mlPredictor = require('./ml_predictor');
const { predictFromRows } = mlPredictor;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function cleanMatchTeamName(name) {
    if (!name) return '';
    let text = name.trim();
    const len = text.length;
    if (len > 0 && len % 2 === 0) {
        const half = text.substring(0, len / 2);
        if (half.length > 3 && /[a-zA-Z]/.test(half) && half + half === text) {
            text = half;
        }
    }
    if (text.length > 3) {
        const suffix = text.substring(text.length - 3);
        if (/^[A-Z0-9]{3}$/.test(suffix)) {
            text = text.substring(0, text.length - 3).trim();
        }
    }
    return text;
}

function extractScore(scoreStr) {
    if (!scoreStr) return null;
    let clean = scoreStr.replace(/\s+/g, '');
    const halfLen = clean.length / 2;
    if (clean.length % 2 === 0 && clean.substring(0, halfLen) === clean.substring(halfLen)) {
        clean = clean.substring(0, halfLen);
    }
    const match = clean.match(/^(\d+):(\d+)$/);
    if (match) {
        return [parseInt(match[1], 10), parseInt(match[2], 10)];
    }
    const m = clean.match(/(\d+):(\d+)/);
    if (m) {
        return [parseInt(m[1], 10), parseInt(m[2], 10)];
    }
    return null;
}

function initLiveTables(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS live_predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            season_name TEXT,
            round_number INTEGER,
            match_time TEXT,
            home_team TEXT,
            away_team TEXT,
            predicted_result TEXT,
            predicted_probs TEXT,
            actual_score TEXT,
            actual_ht_score TEXT,
            scored_status INTEGER DEFAULT 0,
            UNIQUE(season_name, home_team, away_team) ON CONFLICT IGNORE
        );

        CREATE TABLE IF NOT EXISTS ai_best_picks_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            season_name TEXT,
            round_number INTEGER,
            pick_type TEXT,
            home_team TEXT,
            away_team TEXT,
            market TEXT,
            probability INTEGER,
            implied_odd REAL,
            actual_score TEXT,
            status TEXT DEFAULT 'pending',
            UNIQUE(season_name, round_number, pick_type) ON CONFLICT IGNORE
        );
    `);

    try {
        db.exec("ALTER TABLE live_predictions ADD COLUMN round_number INTEGER");
    } catch (e) {
        // column already exists, ignore
    }

    // Migration: add scored_with_prediction column to track if a played match had a prior prediction
    try {
        db.exec("ALTER TABLE live_predictions ADD COLUMN scored_with_prediction INTEGER DEFAULT 1");
    } catch (e) {
        // column already exists, ignore
    }
}

async function scrapeAndPredictLiveSeason(dbPath, isHeadless = true) {
    if (!fs.existsSync(dbPath)) {
        return { success: false, error: `Database file not found: ${dbPath}` };
    }

    const db = new Database(dbPath);
    initLiveTables(db);

    let page, browser;
    try {
        console.log("🚀 Launching stealth browser for live companion...");
        const result = await config.connect({ headless: isHeadless });
        page = result;
        
        // Find browser instance to close it later
        if (page.browser) {
            browser = page.browser();
        }

        // Apply VPS Engine lightweight page optimizations (blocks heavy video streams, fonts, and animation churn)
        const vpsEngine = require('./vps_engine');
        await vpsEngine.optimizePageForScraping(page, { blockHeavyMedia: true, blockImages: true });

        console.log("🌐 Navigating to Bet9ja Virtuals live lobby...");
        await page.goto('https://st-cdn001.akamaized.net/bet9javirtuals/en/1', { waitUntil: 'networkidle2' });
        await delay(5000);

        // Click Virtual Football -> Bundesliga
        console.log("🔍 Finding Virtual Football menu...");
        const vfHandle = await page.evaluateHandle(() => {
            const els = Array.from(document.querySelectorAll('a, div, span, button'));
            return els.find(e => e.textContent.trim().includes('Virtual Football') && e.offsetParent !== null && e.textContent.trim().length < 30);
        });
        if (vfHandle && vfHandle.asElement()) {
            await vfHandle.asElement().click();
            await delay(2000);
        }

        console.log("🔍 Selecting Virtual Football Bundesliga...");
        const bndHandle = await page.evaluateHandle(() => {
            const els = Array.from(document.querySelectorAll('a, div, span, li, button'));
            return els.find(e => e.textContent.trim().includes('Virtual Football Bundesliga') && e.offsetParent !== null && e.textContent.trim().length < 50);
        });
        if (bndHandle && bndHandle.asElement()) {
            await bndHandle.asElement().click();
            await delay(4000);
        }

        // Get Active Season Name from UI
        const activeSeasonName = await page.evaluate(() => {
            // Locate current active season element
            const els = Array.from(document.querySelectorAll('div, span, p, h1, h2, h3, h4, th, td'));
            const seasonEl = els.find(e => e.textContent.includes('Virtual Football') && /\d+/.test(e.textContent) && e.offsetParent !== null && e.textContent.trim().length < 50);
            return seasonEl ? seasonEl.textContent.trim() : null;
        }) || "Virtual Football Bundesliga Live";

        console.log(`📡 Current Active Season Name: ${activeSeasonName}`);

        // Open Fixtures Tab
        console.log("📂 Opening Fixtures tab...");
        const fixturesTabHandle = await page.evaluateHandle(() => {
            const els = Array.from(document.querySelectorAll('a, div, span, button, li'));
            return els.find(e => e.textContent.trim().toLowerCase() === 'fixtures' && e.offsetParent !== null && e.textContent.trim().length < 20);
        });
        if (fixturesTabHandle && fixturesTabHandle.asElement()) {
            await fixturesTabHandle.asElement().click();
            await delay(3000);
        }

        // Extract reference round and kickoff time from the default tab before clicking "Full listing"
        console.log("📍 Extracting reference round and kickoff time from default Rounds view...");
        const refRoundInfo = await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('*'));
            let roundNum = null;
            let timeStr = null;
            
            // 1. Search tr rows for Round / Matchday
            const rows = Array.from(document.querySelectorAll('tr'));
            for (const row of rows) {
                const text = row.textContent.trim().replace(/\s+/g, ' ');
                const roundMatch = text.match(/(?:Round|Week|Matchday)\s+(\d+)/i);
                if (roundMatch && !roundNum) {
                    roundNum = parseInt(roundMatch[1], 10);
                }
                if (text.includes('|')) {
                    const parts = text.split('|').map(p => p.trim());
                    if (parts.length >= 2 && /^\d{1,2}:\d{2}$/.test(parts[0])) {
                        if (!timeStr) {
                            timeStr = parts[0];
                        }
                    }
                }
                if (roundNum && timeStr) break;
            }
            
            // 2. Fallback: Search all leaf text nodes for "Round X" or "Week X"
            if (!roundNum) {
                for (const el of els) {
                    if (el.children.length === 0 && el.textContent) {
                        const text = el.textContent.trim();
                        const m = text.match(/^(?:Round|Week|Matchday)\s+(\d+)$/i) || text.match(/\b(?:Round|Week|Matchday)\s+(\d+)\b/i);
                        if (m) {
                            roundNum = parseInt(m[1], 10);
                            break;
                        }
                    }
                }
            }
            
            // 3. Fallback: Search for elements with round-active style classes
            if (!roundNum) {
                const roundActive = document.querySelector('.round-active, .week-active, .active-round, .active-week');
                if (roundActive) {
                    const m = roundActive.textContent.match(/(\d+)/);
                    if (m) roundNum = parseInt(m[1], 10);
                }
            }
            
            return { roundNum, timeStr };
        });
        console.log(`📍 Found reference round info: Round ${refRoundInfo.roundNum} starts at ${refRoundInfo.timeStr}`);

        // Click "Full listing" sub-tab
        console.log("📂 Clicking 'Full listing' sub-tab...");
        const fullListingSubTabHandle = await page.evaluateHandle(() => {
            const els = Array.from(document.querySelectorAll('a, div, span, button, li'));
            return els.find(e => e.textContent.trim().toLowerCase() === 'full listing' && e.offsetParent !== null && e.textContent.trim().length < 20);
        });
        if (fullListingSubTabHandle && fullListingSubTabHandle.asElement()) {
            await fullListingSubTabHandle.asElement().click();
            await delay(3000);
        }

        // Expand all fixtures
        console.log("🔽 Expanding all fixtures...");
        let canShowMore = true;
        let showMoreCount = 0;
        while (canShowMore && showMoreCount < 40) {
            const buttonHandle = await page.evaluateHandle(() => {
                const btns = Array.from(document.querySelectorAll('a, div, span, button'));
                return btns.find(e => {
                    const text = e.textContent.trim().toLowerCase();
                    return (text === 'show more' || text === 'see more') && e.offsetParent !== null && e.textContent.trim().length < 30;
                });
            });
            if (buttonHandle && buttonHandle.asElement()) {
                try {
                    await buttonHandle.asElement().click();
                    showMoreCount++;
                    await delay(2000);
                } catch (err) {
                    try {
                        await page.evaluate(el => el.click(), buttonHandle);
                        showMoreCount++;
                        await delay(2000);
                    } catch (jsErr) {
                        canShowMore = false;
                    }
                }
            } else {
                canShowMore = false;
            }
        }
        console.log(`🔽 Expanded fixtures list cleanly.`);

        // Scrape the DOM rows
        const scraped = await page.evaluate(() => {
            const lines = [];
            const rows = Array.from(document.querySelectorAll('tr'));
            rows.forEach(row => {
                const cells = Array.from(row.querySelectorAll('th, td')).map(td => td.textContent.trim().replace(/\s+/g, ' '));
                if (cells.length > 0) lines.push(cells.join(' | '));
            });
            return lines;
        });

        console.log(`📝 Scraped ${scraped.length} raw rows from live view.`);

        // Load Prior Matches as Training set
        const allPriorMatches = db.prepare(
            "SELECT id, home_team, away_team, home_score, away_score, ht_home_score, ht_away_score FROM betting_analytics ORDER BY id ASC"
        ).all();

        let decayRate = 0.015;
        let poissonWeight = 0.6;
        const weightsPath = `${dbPath}.weights.json`;
        if (fs.existsSync(weightsPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
                if (typeof data.decayRate === 'number') decayRate = data.decayRate;
                if (typeof data.poissonWeight === 'number') poissonWeight = data.poissonWeight;
            } catch (e) {}
        }

        const insertPred = db.prepare(`
            INSERT OR IGNORE INTO live_predictions (
                season_name, round_number, match_time, home_team, away_team, predicted_result, predicted_probs, scored_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        `);

        const updateScore = db.prepare(`
            UPDATE live_predictions
            SET actual_score = ?, actual_ht_score = ?, scored_status = 1
            WHERE season_name = ? AND home_team = ? AND away_team = ? AND scored_status = 0
        `);

        // Build list of unique kickoff times from scraped rows to chronologically map round numbers
        const uniqueTimes = [];
        for (const line of scraped) {
            if (!line.includes('|')) continue;
            const parts = line.split('|').map(p => p.trim());
            if (parts.length < 4) continue;
            const timeStr = parts[0];
            if (/^\d{1,2}:\d{2}$/.test(timeStr)) {
                if (!uniqueTimes.includes(timeStr)) {
                    uniqueTimes.push(timeStr);
                }
            }
        }

        const refIdx = (refRoundInfo && refRoundInfo.timeStr) ? uniqueTimes.indexOf(refRoundInfo.timeStr) : -1;

        let predictionsCreated = 0;
        let predictionsScored = 0;
        let playedCount = 0;
        let unplayedCount = 0;

        for (const line of scraped) {
            if (!line.includes('|')) continue;
            const parts = line.split('|').map(p => p.trim());
            if (parts.length < 4) continue;

            const timeStr = parts[0];
            if (!/^\d{1,2}:\d{2}$/.test(timeStr)) continue;

            // Determine round number chronologically using our reference round
            let currentRound = null;
            const matchTimeIdx = uniqueTimes.indexOf(timeStr);
            if (refIdx !== -1 && refRoundInfo.roundNum !== null) {
                if (matchTimeIdx !== -1) {
                    currentRound = refRoundInfo.roundNum + (matchTimeIdx - refIdx);
                    // Wrap around if necessary
                    const maxRounds = activeSeasonName.toLowerCase().includes('bundesliga') ? 30 : 38;
                    while (currentRound < 1) currentRound += maxRounds;
                    while (currentRound > maxRounds) currentRound -= maxRounds;
                }
            } else if (matchTimeIdx !== -1) {
                // Robust Fallback: In "Full listing", uniqueTimes has exactly 30 entries (rounds 1-30).
                // The index + 1 perfectly corresponds to the round number!
                const maxRounds = activeSeasonName.toLowerCase().includes('bundesliga') ? 30 : 38;
                currentRound = matchTimeIdx + 1;
                if (currentRound > maxRounds) currentRound = maxRounds;
            }

            let homeTeam = '';
            let awayTeam = '';
            let htHomeScore = null;
            let htAwayScore = null;
            let homeScore = null;
            let awayScore = null;

            if (parts.length >= 6 && parts[2] === '-') {
                homeTeam = cleanMatchTeamName(parts[1]);
                awayTeam = cleanMatchTeamName(parts[3]);
                const ht = extractScore(parts[4]);
                if (ht) { htHomeScore = ht[0]; htAwayScore = ht[1]; }
                const ft = extractScore(parts[5]);
                if (ft) { homeScore = ft[0]; awayScore = ft[1]; }
            } else if (parts[1].includes('-')) {
                const teamParts = parts[1].split('-');
                if (teamParts.length >= 2) {
                    homeTeam = cleanMatchTeamName(teamParts[0]);
                    awayTeam = cleanMatchTeamName(teamParts[1]);
                    const ht = extractScore(parts[2]);
                    if (ht) { htHomeScore = ht[0]; htAwayScore = ht[1]; }
                    const ft = extractScore(parts[3]);
                    if (ft) { homeScore = ft[0]; awayScore = ft[1]; }
                }
            }

            if (!homeTeam || !awayTeam || homeTeam === awayTeam) continue;

            const isPlayed = homeScore !== null && awayScore !== null;
            if (isPlayed) playedCount++;
            else unplayedCount++;

            // Check if prediction already exists in DB
            const existing = db.prepare(`
                SELECT * FROM live_predictions 
                WHERE season_name = ? AND home_team = ? AND away_team = ?
            `).get(activeSeasonName, homeTeam, awayTeam);

            if (!existing && !isPlayed) {
                // Generate and save ML prediction for unplayed match
                const pred = predictFromRows(allPriorMatches, homeTeam, awayTeam, decayRate, poissonWeight);
                if (pred) {
                    let predicted = 'Draw';
                    if (pred.homeWinProb >= pred.drawProb && pred.homeWinProb >= pred.awayWinProb) predicted = 'Home';
                    else if (pred.awayWinProb >= pred.homeWinProb && pred.awayWinProb >= pred.drawProb) predicted = 'Away';

                    const probs = {
                        homeWinProb:  Math.round(pred.homeWinProb * 100),
                        drawProb:     Math.round(pred.drawProb    * 100),
                        awayWinProb:  Math.round(pred.awayWinProb * 100),
                        ggProb:       Math.round(pred.gg          * 100),
                        over15Prob:   Math.round(pred.over15      * 100),
                        over25Prob:   Math.round(pred.over25      * 100),
                        over35Prob:   Math.round(pred.over35      * 100),
                        over45Prob:   Math.round(pred.over45      * 100),
                        over55Prob:   Math.round(pred.over55      * 100),
                        htOver25Prob: Math.round(pred.htOver25    * 100),
                        htOver35Prob: Math.round(pred.htOver35    * 100),
                        oddProb:      Math.round(pred.odd         * 100),
                        evenProb:     Math.round(pred.even        * 100),
                        htScoring1stProb: Math.round(pred.htScoring1st * 100),
                        htScoring2ndProb: Math.round(pred.htScoring2nd * 100),
                        htScoringEqualProb: Math.round(pred.htScoringEqual * 100),
                        htft11Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft11 : 0) * 100),
                        htft1XProb: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft1X : 0) * 100),
                        htft12Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft12 : 0) * 100),
                        htftX1Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htftX1 : 0) * 100),
                        htftXXProb: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htftXX : 0) * 100),
                        htftX2Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htftX2 : 0) * 100),
                        htft21Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft21 : 0) * 100),
                        htft2XProb: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft2X : 0) * 100),
                        htft22Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft22 : 0) * 100)
                    };

                    insertPred.run(
                        activeSeasonName, currentRound, timeStr, homeTeam, awayTeam,
                        predicted, JSON.stringify(probs)
                    );
                    predictionsCreated++;
                }
            } else if (!existing && isPlayed) {
                // FIX: Match already played on the FIRST scrape of a new season.
                // Generate a retroactive ML prediction and immediately mark it scored.
                const pred = predictFromRows(allPriorMatches, homeTeam, awayTeam, decayRate, poissonWeight);
                if (pred) {
                    let predicted = 'Draw';
                    if (pred.homeWinProb >= pred.drawProb && pred.homeWinProb >= pred.awayWinProb) predicted = 'Home';
                    else if (pred.awayWinProb >= pred.homeWinProb && pred.awayWinProb >= pred.drawProb) predicted = 'Away';

                    const probs = {
                        homeWinProb:  Math.round(pred.homeWinProb * 100),
                        drawProb:     Math.round(pred.drawProb    * 100),
                        awayWinProb:  Math.round(pred.awayWinProb * 100),
                        ggProb:       Math.round(pred.gg          * 100),
                        over15Prob:   Math.round(pred.over15      * 100),
                        over25Prob:   Math.round(pred.over25      * 100),
                        over35Prob:   Math.round(pred.over35      * 100),
                        over45Prob:   Math.round(pred.over45      * 100),
                        over55Prob:   Math.round(pred.over55      * 100),
                        htOver25Prob: Math.round(pred.htOver25    * 100),
                        htOver35Prob: Math.round(pred.htOver35    * 100),
                        oddProb:      Math.round(pred.odd         * 100),
                        evenProb:     Math.round(pred.even        * 100),
                        htScoring1stProb: Math.round(pred.htScoring1st * 100),
                        htScoring2ndProb: Math.round(pred.htScoring2nd * 100),
                        htScoringEqualProb: Math.round(pred.htScoringEqual * 100),
                        htft11Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft11 : 0) * 100),
                        htft1XProb: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft1X : 0) * 100),
                        htft12Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft12 : 0) * 100),
                        htftX1Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htftX1 : 0) * 100),
                        htftXXProb: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htftXX : 0) * 100),
                        htftX2Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htftX2 : 0) * 100),
                        htft21Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft21 : 0) * 100),
                        htft2XProb: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft2X : 0) * 100),
                        htft22Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft22 : 0) * 100)
                    };

                    const actualScoreStr = `${homeScore}:${awayScore}`;
                    const actualHtScoreStr = htHomeScore !== null ? `${htHomeScore}:${htAwayScore}` : '0:0';

                    // Insert directly as a scored prediction (scored_status = 1, scored_with_prediction = 0)
                    db.prepare(`
                        INSERT OR IGNORE INTO live_predictions (
                            season_name, round_number, match_time, home_team, away_team,
                            predicted_result, predicted_probs, actual_score, actual_ht_score,
                            scored_status, scored_with_prediction
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
                    `).run(
                        activeSeasonName, currentRound, timeStr, homeTeam, awayTeam,
                        predicted, JSON.stringify(probs), actualScoreStr, actualHtScoreStr
                    );
                    predictionsCreated++;
                    predictionsScored++;
                }
            } else if (existing && existing.scored_status === 0 && isPlayed) {
                // Match is completed, score the existing prediction!
                const actualScoreStr = `${homeScore}:${awayScore}`;
                const actualHtScoreStr = htHomeScore !== null ? `${htHomeScore}:${htAwayScore}` : '0:0';

                updateScore.run(
                    actualScoreStr, actualHtScoreStr,
                    activeSeasonName, homeTeam, awayTeam
                );

                // Ensure round_number is populated
                if ((existing.round_number === null || existing.round_number === undefined) && currentRound !== null) {
                    db.prepare(`
                        UPDATE live_predictions 
                        SET round_number = ? 
                        WHERE id = ?
                    `).run(currentRound, existing.id);
                }

                predictionsScored++;
            }
        }

        console.log(`✅ Live companion processing complete.`);
        console.log(`   ↳ Active Season Name: ${activeSeasonName}`);
        console.log(`   ↳ Played matches: ${playedCount}, Unplayed: ${unplayedCount}`);
        console.log(`   ↳ Predictions created: ${predictionsCreated}, Scored: ${predictionsScored}`);

        try {
            updateAIPicksHistory(db, activeSeasonName);
            console.log(`   ↳ AI Recommended Picks History updated successfully.`);
        } catch (e) {
            console.error(`   ⚠️ Failed to update AI Recommended Picks History:`, e.message);
        }

        // Clean shutdown
        if (browser) {
            try { await browser.close(); } catch (bErr) {}
        }

        // 1. Check if entire season (240 matches) is complete and needs archiving
        let totalScored = 0;
        try {
            const res = db.prepare("SELECT count(*) as count FROM live_predictions WHERE season_name = ? AND scored_status = 1").get(activeSeasonName);
            totalScored = res ? res.count : 0;
        } catch (e) {}

        if (totalScored >= 240) {
            console.log(`🎉 Season ${activeSeasonName} is 100% complete! Archiving to permanent table...`);
            try {
                const completedMatches = db.prepare("SELECT * FROM live_predictions WHERE season_name = ?").all(activeSeasonName);
                const insertFixture = db.prepare(`
                    INSERT OR IGNORE INTO fixtures (
                        league_name, season_name, match_time, home_team, away_team,
                        ht_home_score, ht_away_score, home_score, away_score
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                let fixturesArchived = 0;
                for (const m of completedMatches) {
                    const scores = m.actual_score.split(':').map(Number);
                    const htScores = (m.actual_ht_score || "0:0").split(':').map(Number);
                    insertFixture.run(
                        "Virtual Football Bundesliga", m.season_name, m.match_time, m.home_team, m.away_team,
                        htScores[0], htScores[1], scores[0], scores[1]
                    );
                    fixturesArchived++;
                }
                console.log(`💾 Successfully archived ${fixturesArchived} fixtures to fixtures table!`);
            } catch (archiveErr) {
                console.error("❌ Failed to archive live completed season:", archiveErr.message);
            }
        }

        // 2. Auto-archive any completed matches from PREVIOUS seasons that are still sitting in live_predictions
        try {
            const previousSeasons = db.prepare("SELECT DISTINCT season_name FROM live_predictions WHERE season_name != ?").all(activeSeasonName).map(s => s.season_name);
            for (const prevSeason of previousSeasons) {
                const completedMatches = db.prepare("SELECT * FROM live_predictions WHERE season_name = ? AND scored_status = 1").all(prevSeason);
                if (completedMatches.length > 0) {
                    console.log(`🎉 Found completed previous season ${prevSeason} in live predictions! Archiving ${completedMatches.length} fixtures to permanent table...`);
                    const insertFixture = db.prepare(`
                        INSERT OR IGNORE INTO fixtures (
                            league_name, season_name, match_time, home_team, away_team,
                            ht_home_score, ht_away_score, home_score, away_score
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `);
                    
                    let fixturesArchived = 0;
                    for (const m of completedMatches) {
                        if (m.actual_score) {
                            const scores = m.actual_score.split(':').map(Number);
                            const htScores = (m.actual_ht_score || "0:0").split(':').map(Number);
                            insertFixture.run(
                                "Virtual Football Bundesliga", m.season_name, m.match_time, m.home_team, m.away_team,
                                htScores[0], htScores[1], scores[0], scores[1]
                            );
                            fixturesArchived++;
                        }
                    }
                    console.log(`💾 Successfully archived ${fixturesArchived} fixtures for completed previous season ${prevSeason}!`);
                }
            }
        } catch (prevArchiveErr) {
            console.error("❌ Failed to auto-archive previous seasons:", prevArchiveErr.message);
        }

        try { db.close(); } catch (dbErr) {}
        return {
            success: true,
            seasonName: activeSeasonName,
            playedCount,
            unplayedCount,
            predictionsCreated,
            predictionsScored
        };

    } catch (e) {
        if (browser) {
            try { await browser.close(); } catch (bErr) {}
        }
        try { db.close(); } catch (dbErr) {}
        console.error("❌ Live companion failed with error:", e);
        return { success: false, error: e.message };
    }
}

function updateAIPicksHistory(db, seasonName) {
    // 1. Find all rounds in the active season that have predictions
    const roundsWithPredictions = db.prepare(`
        SELECT DISTINCT round_number 
        FROM live_predictions 
        WHERE season_name = ? AND round_number IS NOT NULL
    `).all(seasonName).map(r => r.round_number);

    for (const round of roundsWithPredictions) {
        // Check if we already have picks recorded for this round
        const existingPicks = db.prepare(`
            SELECT count(*) as count 
            FROM ai_best_picks_history 
            WHERE season_name = ? AND round_number = ?
        `).get(seasonName, round).count;

        if (existingPicks === 0) {
            // Calculate and insert safest and high value picks for this round
            // FIX: was missing round_number in the WHERE clause — was fetching entire season instead of one round
            const predictions = db.prepare(`
                SELECT * FROM live_predictions 
                WHERE season_name = ? AND round_number = ?
            `).all(seasonName, round);

            if (predictions.length > 0) {
                const highOddsMarkets = [
                    { key: 'homeWinProb', label: 'Home Win', category: '1X2' },
                    { key: 'awayWinProb', label: 'Away Win', category: '1X2' },
                    { key: 'ggProb', label: 'Both Teams to Score (GG)', category: 'BTTS' },
                    { key: 'over25Prob', label: 'Over 2.5 Goals', category: 'Goals' },
                    { key: 'over35Prob', label: 'Over 3.5 Goals', category: 'Goals' }
                ];

                const allMarkets = [
                    { key: 'homeWinProb', label: 'Home Win' },
                    { key: 'awayWinProb', label: 'Away Win' },
                    { key: 'over15Prob', label: 'Over 1.5 Goals' },
                    { key: 'over25Prob', label: 'Over 2.5 Goals' },
                    { key: 'over35Prob', label: 'Over 3.5 Goals' },
                    { key: 'ggProb', label: 'Both Teams to Score (GG)' },
                    { key: 'dnbHomeProb', label: 'Home Draw No Bet' },
                    { key: 'dnbAwayProb', label: 'Away Draw No Bet' }
                ];

                let safest = null;
                let highValue = null;
                let maxSafestProb = -1;
                let bestHighValueOdd = -1;

                predictions.forEach(m => {
                    let probs = {};
                    try {
                        probs = JSON.parse(m.predicted_probs) || {};
                    } catch (pe) {
                        probs = {};
                    }

                    // 1. Safest overall pick
                    allMarkets.forEach(market => {
                        const prob = probs[market.key] || 0;
                        if (prob > maxSafestProb) {
                            maxSafestProb = prob;
                            safest = {
                                match: m,
                                market: market.label,
                                prob,
                                impliedOdd: parseFloat((100 / prob).toFixed(2))
                            };
                        }
                    });

                    // 2. High-odds value pick recommended by ML
                    highOddsMarkets.forEach(market => {
                        const prob = probs[market.key] || 0;
                        if (prob >= 62) {
                            const odd = 100 / prob;
                            if (odd > bestHighValueOdd) {
                                bestHighValueOdd = odd;
                                highValue = {
                                    match: m,
                                    market: market.label,
                                    prob,
                                    impliedOdd: parseFloat(odd.toFixed(2))
                                };
                            }
                        }
                    });
                });

                // Fallback for highValue if none meet >= 62%
                if (!highValue && predictions.length > 0) {
                    let bestProb = -1;
                    predictions.forEach(m => {
                        let probs = {};
                        try {
                            probs = JSON.parse(m.predicted_probs) || {};
                        } catch (pe) {
                            probs = {};
                        }
                        highOddsMarkets.forEach(market => {
                            const prob = probs[market.key] || 0;
                            if (prob > bestProb) {
                                bestProb = prob;
                                highValue = {
                                    match: m,
                                    market: market.label,
                                    prob,
                                    impliedOdd: parseFloat((100 / prob).toFixed(2))
                                };
                            }
                        });
                    });
                }

                // Insert them into history
                if (safest) {
                    db.prepare(`
                        INSERT OR IGNORE INTO ai_best_picks_history (
                            season_name, round_number, pick_type, home_team, away_team, market, probability, implied_odd, status
                        ) VALUES (?, ?, 'safest', ?, ?, ?, ?, ?, 'pending')
                    `).run(seasonName, round, safest.match.home_team, safest.match.away_team, safest.market, safest.prob, safest.impliedOdd);
                }
                if (highValue) {
                    db.prepare(`
                        INSERT OR IGNORE INTO ai_best_picks_history (
                            season_name, round_number, pick_type, home_team, away_team, market, probability, implied_odd, status
                        ) VALUES (?, ?, 'high_value', ?, ?, ?, ?, ?, 'pending')
                    `).run(seasonName, round, highValue.match.home_team, highValue.match.away_team, highValue.market, highValue.prob, highValue.impliedOdd);
                }
            }
        }
    }

    // 2. Update status of any pending picks in ai_best_picks_history where matches are completed
    const pendingPicks = db.prepare(`
        SELECT * FROM ai_best_picks_history 
        WHERE status = 'pending'
    `).all();

    for (const pick of pendingPicks) {
        // Find the completed match in live_predictions
        const match = db.prepare(`
            SELECT * FROM live_predictions 
            WHERE season_name = ? AND home_team = ? AND away_team = ? AND scored_status = 1
        `).get(pick.season_name, pick.home_team, pick.away_team);

        if (match) {
            const actualScore = match.actual_score;
            const actualHtScore = match.actual_ht_score || "0:0";
            const [h, a] = actualScore.split(':').map(Number);
            const [htH, htA] = actualHtScore.split(':').map(Number);
            const totalGoals = h + a;

            let won = false;
            const label = pick.market;

            if (label === 'Home Win') won = h > a;
            else if (label === 'Away Win') won = a > h;
            else if (label === 'Draw') won = h === a;
            else if (label === 'Over 1.5 Goals') won = totalGoals > 1.5;
            else if (label === 'Under 1.5 Goals') won = totalGoals < 1.5;
            else if (label === 'Over 2.5 Goals') won = totalGoals > 2.5;
            else if (label === 'Under 2.5 Goals') won = totalGoals < 2.5;
            else if (label === 'Over 3.5 Goals') won = totalGoals > 3.5;
            else if (label === 'Under 3.5 Goals') won = totalGoals < 3.5;
            else if (label === 'Over 4.5 Goals') won = totalGoals > 4.5;
            else if (label === 'Under 4.5 Goals') won = totalGoals < 4.5;
            else if (label === 'Over 5.5 Goals') won = totalGoals > 5.5;
            else if (label === 'Under 5.5 Goals') won = totalGoals < 5.5;
            else if (label === 'Both Teams to Score (GG)') won = h > 0 && a > 0;
            else if (label === 'Home Draw No Bet') {
                if (h === a) {
                    won = null;
                } else {
                    won = h > a;
                }
            } else if (label === 'Away Draw No Bet') {
                if (h === a) {
                    won = null;
                } else {
                    won = a > h;
                }
            }

            let finalStatus = won === null ? 'void' : (won ? 'won' : 'lost');
            db.prepare(`
                UPDATE ai_best_picks_history 
                SET actual_score = ?, status = ?
                WHERE id = ?
            `).run(actualScore, finalStatus, pick.id);
        }
    }
}

function getLivePredictions(dbPath) {
    if (!fs.existsSync(dbPath)) {
        return { success: false, error: 'Database not found' };
    }

    const db = new Database(dbPath);
    initLiveTables(db);

    try {
        // FIX: Fetch the most recently ACTIVE season — the one with the highest max(id),
        // which reliably points to the season that was last written to (newest data).
        const latestSeasonRow = db.prepare(
            "SELECT season_name, MAX(id) as max_id FROM live_predictions GROUP BY season_name ORDER BY max_id DESC LIMIT 1"
        ).get();
        if (!latestSeasonRow) {
            db.close();
            return { success: true, seasonName: null, predictions: [], aiPicksHistory: [] };
        }

        const seasonName = latestSeasonRow.season_name;
        const predictions = db.prepare("SELECT * FROM live_predictions WHERE season_name = ? ORDER BY round_number ASC, id ASC").all(seasonName);
        
        // Fetch AI picks history from the permanent table
        let aiPicksHistory = [];
        try {
            aiPicksHistory = db.prepare("SELECT * FROM ai_best_picks_history ORDER BY id DESC").all();
        } catch (he) {
            console.error("Error reading ai_best_picks_history:", he.message);
        }

        db.close();

        return {
            success: true,
            seasonName,
            predictions: predictions.map(p => ({
                ...p,
                predicted_probs: JSON.parse(p.predicted_probs)
            })),
            aiPicksHistory
        };
    } catch (e) {
        db.close();
        return { success: false, error: e.message };
    }
}

module.exports = {
    scrapeAndPredictLiveSeason,
    getLivePredictions
};
