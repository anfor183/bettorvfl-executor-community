const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function factorial(n) {
    if (n === 0 || n === 1) return 1;
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
}

const poisson = (lambda, k) => {
    return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
};

function getDecayRateForDb(dbPath) {
    let decayRate = 0.015;
    const weightsPath = `${dbPath}.weights.json`;
    if (fs.existsSync(weightsPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
            if (typeof data.decayRate === 'number') {
                decayRate = data.decayRate;
            }
        } catch (err) {
            console.error("Error reading ML decay weights file, using default:", err.message);
        }
    }
    return decayRate;
}

function getWeightedStats(allMatches, decayRate = 0.015) {
    const N = allMatches.length;
    let totalHomeGoalsWeighted = 0;
    let totalAwayGoalsWeighted = 0;
    let totalWeight = 0;

    for (let i = 0; i < N; i++) {
        const m = allMatches[i];
        const w = Math.exp(-(N - 1 - i) * decayRate);
        totalHomeGoalsWeighted += (m.home_score || 0) * w;
        totalAwayGoalsWeighted += (m.away_score || 0) * w;
        totalWeight += w;
    }

    const avgHomeGoals = totalHomeGoalsWeighted / (totalWeight || 1);
    const avgAwayGoals = totalAwayGoalsWeighted / (totalWeight || 1);

    const stats = {};
    const initTeamStats = () => ({
        homeGoalsScored: 0,
        homeGoalsConceded: 0,
        homeMatchesWeight: 0,
        awayGoalsScored: 0,
        awayGoalsConceded: 0,
        awayMatchesWeight: 0
    });

    for (let i = 0; i < N; i++) {
        const m = allMatches[i];
        const w = Math.exp(-(N - 1 - i) * decayRate);

        if (!stats[m.home_team]) stats[m.home_team] = initTeamStats();
        if (!stats[m.away_team]) stats[m.away_team] = initTeamStats();

        stats[m.home_team].homeGoalsScored += (m.home_score || 0) * w;
        stats[m.home_team].homeGoalsConceded += (m.away_score || 0) * w;
        stats[m.home_team].homeMatchesWeight += w;

        stats[m.away_team].awayGoalsScored += (m.away_score || 0) * w;
        stats[m.away_team].awayGoalsConceded += (m.home_score || 0) * w;
        stats[m.away_team].awayMatchesWeight += w;
    }

    return {
        avgHomeGoals,
        avgAwayGoals,
        stats
    };
}

function getWeightedHTStats(allMatches, decayRate = 0.015) {
    const N = allMatches.length;
    let totalHomeHTGoalsWeighted = 0;
    let totalAwayHTGoalsWeighted = 0;
    let totalHTWeight = 0;

    for (let i = 0; i < N; i++) {
        const m = allMatches[i];
        if (m.ht_home_score !== null && m.ht_away_score !== null && m.ht_home_score !== undefined && m.ht_away_score !== undefined) {
            const w = Math.exp(-(N - 1 - i) * decayRate);
            totalHomeHTGoalsWeighted += m.ht_home_score * w;
            totalAwayHTGoalsWeighted += m.ht_away_score * w;
            totalHTWeight += w;
        }
    }

    const avgHomeHTGoals = totalHomeHTGoalsWeighted / (totalHTWeight || 1);
    const avgAwayHTGoals = totalAwayHTGoalsWeighted / (totalHTWeight || 1);

    const htStats = {};
    const initHTStats = () => ({
        homeGoalsScored: 0,
        homeGoalsConceded: 0,
        homeMatchesWeight: 0,
        awayGoalsScored: 0,
        awayGoalsConceded: 0,
        awayMatchesWeight: 0
    });

    for (let i = 0; i < N; i++) {
        const m = allMatches[i];
        if (m.ht_home_score === null || m.ht_away_score === null || m.ht_home_score === undefined || m.ht_away_score === undefined) continue;

        const w = Math.exp(-(N - 1 - i) * decayRate);

        if (!htStats[m.home_team]) htStats[m.home_team] = initHTStats();
        if (!htStats[m.away_team]) htStats[m.away_team] = initHTStats();

        htStats[m.home_team].homeGoalsScored += m.ht_home_score * w;
        htStats[m.home_team].homeGoalsConceded += m.ht_away_score * w;
        htStats[m.home_team].homeMatchesWeight += w;

        htStats[m.away_team].awayGoalsScored += m.ht_away_score * w;
        htStats[m.away_team].awayGoalsConceded += m.ht_home_score * w;
        htStats[m.away_team].awayMatchesWeight += w;
    }

    return {
        avgHomeHTGoals,
        avgAwayHTGoals,
        htStats
    };
}

function getCleanedMatches(db) {
    let rawMatches = [];
    try {
        rawMatches = db.prepare("SELECT home_team, away_team, home_score, away_score, ht_home_score, ht_away_score, match_time FROM fixtures ORDER BY id DESC LIMIT 3000").all();
        rawMatches.reverse();
    } catch (e) {
        console.error("Error reading fixtures database:", e.message);
        return [];
    }

    const allMatches = [];
    for (const m of rawMatches) {
        if (!m.home_team || !m.away_team) continue;
        if (m.home_score === null || m.away_score === null || m.home_score === undefined || m.away_score === undefined) continue;

        const h = parseInt(m.home_score, 10);
        const a = parseInt(m.away_score, 10);
        if (isNaN(h) || isNaN(a) || h < 0 || a < 0) continue;

        let ht_h = null;
        let ht_a = null;
        if (m.ht_home_score !== null && m.ht_away_score !== null && m.ht_home_score !== undefined && m.ht_away_score !== undefined) {
            const parsed_ht_h = parseInt(m.ht_home_score, 10);
            const parsed_ht_a = parseInt(m.ht_away_score, 10);
            if (!isNaN(parsed_ht_h) && !isNaN(parsed_ht_a) && parsed_ht_h >= 0 && parsed_ht_a >= 0) {
                ht_h = parsed_ht_h;
                ht_a = parsed_ht_a;
            }
        }

        allMatches.push({
            home_team: m.home_team,
            away_team: m.away_team,
            home_score: h,
            away_score: a,
            ht_home_score: ht_h,
            ht_away_score: ht_a,
            match_time: m.match_time || ''
        });
    }
    return allMatches;
}

function calculatePoissonMatchup(dbPath, homeTeam, awayTeam, passedDecayRate = null) {
    const db = new Database(dbPath);
    const allMatches = getCleanedMatches(db);
    
    if (allMatches.length < 5) {
        db.close();
        return null;
    }

    let decayRate = passedDecayRate;
    if (decayRate === null) {
        decayRate = getDecayRateForDb(dbPath);
    }

    // 1. Calculate overall league averages and team-specific stats
    const { avgHomeGoals, avgAwayGoals, stats } = getWeightedStats(allMatches, decayRate);

    if (!stats[homeTeam] || !stats[awayTeam]) {
        db.close();
        return null;
    }

    const homeTeamStats = stats[homeTeam];
    const awayTeamStats = stats[awayTeam];

    const homeTeamHomeMatchesWeight = homeTeamStats.homeMatchesWeight || 1;
    const awayTeamAwayMatchesWeight = awayTeamStats.awayMatchesWeight || 1;

    // Attack and Defense strengths
    const homeAttack = (homeTeamStats.homeGoalsScored / homeTeamHomeMatchesWeight) / (avgHomeGoals || 1);
    const homeDefense = (homeTeamStats.homeGoalsConceded / homeTeamHomeMatchesWeight) / (avgAwayGoals || 1);

    const awayAttack = (awayTeamStats.awayGoalsScored / awayTeamAwayMatchesWeight) / (avgAwayGoals || 1);
    const awayDefense = (awayTeamStats.awayGoalsConceded / awayTeamAwayMatchesWeight) / (avgHomeGoals || 1);

    // Expected Goals (xG)
    const homeXG = homeAttack * awayDefense * avgHomeGoals;
    const awayXG = awayAttack * homeDefense * avgAwayGoals;



    const maxGoals = 6;
    const homeProb = [];
    const awayProb = [];

    for (let i = 0; i <= maxGoals; i++) {
        homeProb.push(poisson(homeXG, i));
        awayProb.push(poisson(awayXG, i));
    }

    let homeWinProb = 0;
    let drawProb = 0;
    let awayWinProb = 0;
    const scores = [];

    for (let h = 0; h <= maxGoals; h++) {
        for (let a = 0; a <= maxGoals; a++) {
            const prob = homeProb[h] * awayProb[a];
            if (h > a) homeWinProb += prob;
            else if (h === a) drawProb += prob;
            else awayWinProb += prob;

            scores.push({
                homeScore: h,
                awayScore: a,
                probability: prob
            });
        }
    }

    const totalMatrixProb = homeWinProb + drawProb + awayWinProb;
    if (totalMatrixProb > 0) {
        homeWinProb /= totalMatrixProb;
        drawProb /= totalMatrixProb;
        awayWinProb /= totalMatrixProb;
        for (const s of scores) {
            s.probability /= totalMatrixProb;
        }
    }

    scores.sort((a, b) => b.probability - a.probability);
    const topScorelines = scores.slice(0, 3).map(s => ({
        score: `${s.homeScore}-${s.awayScore}`,
        prob: s.probability
    }));

    // Comprehensive correct scores list
    const correctScoresList = scores.slice(0, 15).map(s => ({
        score: `${s.homeScore}-${s.awayScore}`,
        prob: s.probability
    }));

    // Calculate Full-Time Goal Markets
    let over05 = 0, over15 = 0, over25 = 0, over35 = 0, over45 = 0, over55 = 0;
    let gg = 0, ng = 0;
    let evenProb = 0, oddProb = 0;
    let eg0 = 0, eg1 = 0, eg2 = 0, eg3 = 0, eg4 = 0, eg5 = 0, eg6Plus = 0;

    // Home / Away Total Goals Under/Over
    let hgOver05 = 0, hgOver15 = 0, hgOver25 = 0;
    let agOver05 = 0, agOver15 = 0, agOver25 = 0;

    for (const s of scores) {
        const total = s.homeScore + s.awayScore;
        if (total > 0) over05 += s.probability;
        if (total > 1) over15 += s.probability;
        if (total > 2) over25 += s.probability;
        if (total > 3) over35 += s.probability;
        if (total > 4) over45 += s.probability;
        if (total > 5) over55 += s.probability;
        
        if (s.homeScore > 0 && s.awayScore > 0) gg += s.probability;
        else ng += s.probability;

        if (total % 2 === 0) evenProb += s.probability;
        else oddProb += s.probability;

        if (total === 0) eg0 += s.probability;
        else if (total === 1) eg1 += s.probability;
        else if (total === 2) eg2 += s.probability;
        else if (total === 3) eg3 += s.probability;
        else if (total === 4) eg4 += s.probability;
        else if (total === 5) eg5 += s.probability;
        else if (total >= 6) eg6Plus += s.probability;

        if (s.homeScore > 0) hgOver05 += s.probability;
        if (s.homeScore > 1) hgOver15 += s.probability;
        if (s.homeScore > 2) hgOver25 += s.probability;

        if (s.awayScore > 0) agOver05 += s.probability;
        if (s.awayScore > 1) agOver15 += s.probability;
        if (s.awayScore > 2) agOver25 += s.probability;
    }

    // Double Chance
    const dc1X = homeWinProb + drawProb;
    const dc12 = homeWinProb + awayWinProb;
    const dcX2 = drawProb + awayWinProb;

    // Draw No Bet
    const dnbTotal = homeWinProb + awayWinProb;
    const dnbHome = dnbTotal > 0 ? homeWinProb / dnbTotal : 0.5;
    const dnbAway = dnbTotal > 0 ? awayWinProb / dnbTotal : 0.5;

    // Handicaps 3-Way
    const calcHandicap3Way = (hVal) => {
        let hWin = 0, draw = 0, aWin = 0;
        for (const s of scores) {
            const diff = s.homeScore + hVal - s.awayScore;
            if (diff > 0) hWin += s.probability;
            else if (diff === 0) draw += s.probability;
            else aWin += s.probability;
        }
        return { home: hWin, draw, away: aWin };
    };

    const hcMinus2 = calcHandicap3Way(-2);
    const hcMinus1 = calcHandicap3Way(-1);
    const hcPlus1 = calcHandicap3Way(1);
    const hcPlus2 = calcHandicap3Way(2);

    // Asian Handicaps 2-Way
    const calcAH = (ahVal) => {
        let homeAH = 0;
        let awayAH = 0;
        for (const s of scores) {
            const diff = s.homeScore + ahVal - s.awayScore;
            if (diff > 0) homeAH += s.probability;
            else if (diff < 0) awayAH += s.probability;
            else {
                homeAH += 0.5 * s.probability;
                awayAH += 0.5 * s.probability;
            }
        }
        const total = homeAH + awayAH;
        return {
            home: total > 0 ? homeAH / total : 0.5,
            away: total > 0 ? awayAH / total : 0.5
        };
    };

    const ahMinus1_5 = calcAH(-1.5);
    const ahPlus1_5 = calcAH(1.5);
    const ahMinus1_25 = calcAH(-1.25);
    const ahPlus1_25 = calcAH(1.25);
    const ahMinus1_75 = calcAH(-1.75);
    const ahPlus1_75 = calcAH(1.75);

    // Calculate Half-Time (HT) averages and team stats
    const { avgHomeHTGoals, avgAwayHTGoals, htStats } = getWeightedHTStats(allMatches, decayRate);

    // Default to league averages if no specific team data is available
    const initHTStats = () => ({
        homeGoalsScored: 0,
        homeGoalsConceded: 0,
        homeMatchesWeight: 0,
        awayGoalsScored: 0,
        awayGoalsConceded: 0,
        awayMatchesWeight: 0
    });
    const homeTeamHT = htStats[homeTeam] || initHTStats();
    const awayTeamHT = htStats[awayTeam] || initHTStats();

    const homeHTMatchesWeightCount = homeTeamHT.homeMatchesWeight || 1;
    const awayHTMatchesWeightCount = awayTeamHT.awayMatchesWeight || 1;

    const homeHTAttack = (homeTeamHT.homeGoalsScored / homeHTMatchesWeightCount) / (avgHomeHTGoals || 1);
    const homeHTDefense = (homeTeamHT.homeGoalsConceded / homeHTMatchesWeightCount) / (avgAwayHTGoals || 1);

    const awayHTAttack = (awayTeamHT.awayGoalsScored / awayHTMatchesWeightCount) / (avgAwayHTGoals || 1);
    const awayHTDefense = (awayTeamHT.awayGoalsConceded / awayHTMatchesWeightCount) / (avgHomeHTGoals || 1);

    const homeHT_XG = homeHTAttack * awayHTDefense * avgHomeHTGoals;
    const awayHT_XG = awayHTAttack * homeHTDefense * avgAwayHTGoals;

    // HT Poisson probabilities
    const maxHTGoals = 4;
    const homeHTProb = [];
    const awayHTProb = [];

    for (let i = 0; i <= maxHTGoals; i++) {
        homeHTProb.push(poisson(homeHT_XG, i));
        awayHTProb.push(poisson(awayHT_XG, i));
    }

    let htHomeWinProb = 0;
    let htDrawProb = 0;
    let htAwayWinProb = 0;
    const htScores = [];

    for (let h = 0; h <= maxHTGoals; h++) {
        for (let a = 0; a <= maxHTGoals; a++) {
            const prob = homeHTProb[h] * awayHTProb[a];
            if (h > a) htHomeWinProb += prob;
            else if (h === a) htDrawProb += prob;
            else htAwayWinProb += prob;

            htScores.push({
                homeScore: h,
                awayScore: a,
                probability: prob
            });
        }
    }

    const totalHTMatrixProb = htHomeWinProb + htDrawProb + htAwayWinProb;
    if (totalHTMatrixProb > 0) {
        htHomeWinProb /= totalHTMatrixProb;
        htDrawProb /= totalHTMatrixProb;
        htAwayWinProb /= totalHTMatrixProb;
        for (const s of htScores) {
            s.probability /= totalHTMatrixProb;
        }
    }

    htScores.sort((a, b) => b.probability - a.probability);
    const topHTScorelines = htScores.slice(0, 3).map(s => ({
        score: `${s.homeScore}-${s.awayScore}`,
        prob: s.probability
    }));

    let htOver05 = 0;
    let htOver15 = 0;
    let htOver25 = 0;
    let htOver35 = 0;
    let htOver45 = 0;
    let htOver55 = 0;
    let htGg = 0;
    let htNg = 0;

    for (const s of htScores) {
        const total = s.homeScore + s.awayScore;
        if (total > 0) htOver05 += s.probability;
        if (total > 1) htOver15 += s.probability;
        if (total > 2) htOver25 += s.probability;
        if (total > 3) htOver35 += s.probability;
        if (total > 4) htOver45 += s.probability;
        if (total > 5) htOver55 += s.probability;
        if (s.homeScore > 0 && s.awayScore > 0) htGg += s.probability;
        else htNg += s.probability;
    }

    // HT Double Chance
    const htDc1X = htHomeWinProb + htDrawProb;
    const htDc12 = htHomeWinProb + htAwayWinProb;
    const htDcX2 = htDrawProb + htAwayWinProb;

    // HT Handicap (3-way) for -1, +1
    const calcHTHandicap3Way = (hVal) => {
        let hWin = 0, draw = 0, aWin = 0;
        for (const s of htScores) {
            const diff = s.homeScore + hVal - s.awayScore;
            if (diff > 0) hWin += s.probability;
            else if (diff === 0) draw += s.probability;
            else aWin += s.probability;
        }
        return { home: hWin, draw, away: aWin };
    };
    const htHcMinus1 = calcHTHandicap3Way(-1);
    const htHcPlus1 = calcHTHandicap3Way(1);

    // Second Half (SH) calculation for HT/FT and Highest Scoring Half
    const homeSH_XG = Math.max(0, homeXG - homeHT_XG);
    const awaySH_XG = Math.max(0, awayXG - awayHT_XG);

    const maxSHGoals = 6;
    const shHomeProb = [];
    const shAwayProb = [];
    for (let i = 0; i <= maxSHGoals; i++) {
        shHomeProb.push(poisson(homeSH_XG, i));
        shAwayProb.push(poisson(awaySH_XG, i));
    }
    const shScores = [];
    for (let h = 0; h <= maxSHGoals; h++) {
        for (let a = 0; a <= maxSHGoals; a++) {
            shScores.push({
                homeScore: h,
                awayScore: a,
                probability: shHomeProb[h] * shAwayProb[a]
            });
        }
    }
    let totalSHMatrixProb = 0;
    for (const s of shScores) {
        totalSHMatrixProb += s.probability;
    }
    if (totalSHMatrixProb > 0) {
        for (const s of shScores) {
            s.probability /= totalSHMatrixProb;
        }
    }

    // HT/FT Combinations
    let htft11 = 0, htft1X = 0, htft12 = 0;
    let htftX1 = 0, htftXX = 0, htftX2 = 0;
    let htft21 = 0, htft2X = 0, htft22 = 0;

    for (const s1 of htScores) {
        const htResult = s1.homeScore > s1.awayScore ? '1' : (s1.homeScore === s1.awayScore ? 'X' : '2');
        for (const s2 of shScores) {
            const ftHome = s1.homeScore + s2.homeScore;
            const ftAway = s1.awayScore + s2.awayScore;
            const ftResult = ftHome > ftAway ? '1' : (ftHome === ftAway ? 'X' : '2');
            
            const prob = s1.probability * s2.probability;
            
            if (htResult === '1' && ftResult === '1') htft11 += prob;
            else if (htResult === '1' && ftResult === 'X') htft1X += prob;
            else if (htResult === '1' && ftResult === '2') htft12 += prob;
            else if (htResult === 'X' && ftResult === '1') htftX1 += prob;
            else if (htResult === 'X' && ftResult === 'X') htftXX += prob;
            else if (htResult === 'X' && ftResult === '2') htftX2 += prob;
            else if (htResult === '2' && ftResult === '1') htft21 += prob;
            else if (htResult === '2' && ftResult === 'X') htft2X += prob;
            else if (htResult === '2' && ftResult === '2') htft22 += prob;
        }
    }

    // Highest Scoring Half
    let hshFirst = 0, hshSecond = 0, hshEqual = 0;
    for (const s1 of htScores) {
        const htGoals = s1.homeScore + s1.awayScore;
        for (const s2 of shScores) {
            const shGoals = s2.homeScore + s2.awayScore;
            const prob = s1.probability * s2.probability;
            
            if (htGoals > shGoals) hshFirst += prob;
            else if (htGoals < shGoals) hshSecond += prob;
            else hshEqual += prob;
        }
    }

    // Classify Kickoff Time trends (Day vs Night)
    let homeDayPlayed = 0, homeDayWins = 0, homeDayGoals = 0;
    let homeNightPlayed = 0, homeNightWins = 0, homeNightGoals = 0;
    let awayDayPlayed = 0, awayDayWins = 0, awayDayGoals = 0;
    let awayNightPlayed = 0, awayNightWins = 0, awayNightGoals = 0;

    for (const m of allMatches) {
        let hour = 15; // default kickoff hour
        if (m.match_time && m.match_time.includes(':')) {
            const parsedHour = parseInt(m.match_time.split(':')[0], 10);
            if (!isNaN(parsedHour)) hour = parsedHour;
        }
        const isDay = hour < 17;

        if (m.home_team === homeTeam) {
            const isWin = m.home_score > m.away_score;
            if (isDay) {
                homeDayPlayed += 1;
                if (isWin) homeDayWins += 1;
                homeDayGoals += m.home_score;
            } else {
                homeNightPlayed += 1;
                if (isWin) homeNightWins += 1;
                homeNightGoals += m.home_score;
            }
        } else if (m.away_team === homeTeam) {
            const isWin = m.away_score > m.home_score;
            if (isDay) {
                homeDayPlayed += 1;
                if (isWin) homeDayWins += 1;
                homeDayGoals += m.away_score;
            } else {
                homeNightPlayed += 1;
                if (isWin) homeNightWins += 1;
                homeNightGoals += m.away_score;
            }
        }

        if (m.home_team === awayTeam) {
            const isWin = m.home_score > m.away_score;
            if (isDay) {
                awayDayPlayed += 1;
                if (isWin) awayDayWins += 1;
                awayDayGoals += m.home_score;
            } else {
                awayNightPlayed += 1;
                if (isWin) awayNightWins += 1;
                awayNightGoals += m.home_score;
            }
        } else if (m.away_team === awayTeam) {
            const isWin = m.away_score > m.home_score;
            if (isDay) {
                awayDayPlayed += 1;
                if (isWin) awayDayWins += 1;
                awayDayGoals += m.away_score;
            } else {
                awayNightPlayed += 1;
                if (isWin) awayNightWins += 1;
                awayNightGoals += m.away_score;
            }
        }
    }

    // 1. First Goal probabilities
    const prob00 = scores.find(s => s.homeScore === 0 && s.awayScore === 0)?.probability || 0;
    const sumXG = homeXG + awayXG;
    const fgHome = sumXG > 0 ? (homeXG / sumXG) * (1 - prob00) : 0;
    const fgAway = sumXG > 0 ? (awayXG / sumXG) * (1 - prob00) : 0;
    const fgNone = prob00;

    // 2. Home/Away Exact Goals
    const homeExactGoals = {
        eg0: homeProb[0] || 0,
        eg1: homeProb[1] || 0,
        eg2: homeProb[2] || 0,
        eg3: homeProb[3] || 0,
        eg4Plus: Math.max(0, 1 - (homeProb[0] || 0) - (homeProb[1] || 0) - (homeProb[2] || 0) - (homeProb[3] || 0))
    };
    const awayExactGoals = {
        eg0: awayProb[0] || 0,
        eg1: awayProb[1] || 0,
        eg2: awayProb[2] || 0,
        eg3: awayProb[3] || 0,
        eg4Plus: Math.max(0, 1 - (awayProb[0] || 0) - (awayProb[1] || 0) - (awayProb[2] || 0) - (awayProb[3] || 0))
    };

    // 3. Teams to Score
    const teamsToScore = {
        both: gg,
        onlyHome: scores.filter(s => s.homeScore > 0 && s.awayScore === 0).reduce((acc, s) => acc + s.probability, 0),
        onlyAway: scores.filter(s => s.homeScore === 0 && s.awayScore > 0).reduce((acc, s) => acc + s.probability, 0),
        none: prob00
    };

    // 4. Correct Score Grid dictionary
    const correctScoreGrid = {};
    for (const score of ['0:0', '1:0', '2:0', '3:0', '0:1', '0:2', '0:3', '1:1', '2:1', '3:1', '1:2', '2:2', '3:2', '1:3', '2:3', '3:3']) {
        const [h, a] = score.split(':').map(Number);
        const matchScore = scores.find(s => s.homeScore === h && s.awayScore === a);
        correctScoreGrid[score.replace(':', '_')] = matchScore ? matchScore.probability : 0;
    }

    // 5. HT Asian Handicaps
    const htAHMinus0_5 = htHomeWinProb;
    const htAHPlus0_5 = htHomeWinProb + htDrawProb;
    const htAHMinus1_5 = htScores.filter(s => s.homeScore - s.awayScore > 1).reduce((acc, s) => acc + s.probability, 0);
    const htAHPlus1_5 = 1 - htScores.filter(s => s.awayScore - s.homeScore > 1).reduce((acc, s) => acc + s.probability, 0);

    const htAHMinus0_75 = htScores.filter(s => s.homeScore - s.awayScore >= 2).reduce((acc, s) => acc + s.probability, 0) +
                          0.5 * htScores.filter(s => s.homeScore - s.awayScore === 1).reduce((acc, s) => acc + s.probability, 0);
    const htAHPlus0_75 = htScores.filter(s => s.awayScore - s.homeScore >= 2).reduce((acc, s) => acc + s.probability, 0) +
                         0.5 * htScores.filter(s => s.awayScore - s.homeScore === 1).reduce((acc, s) => acc + s.probability, 0);

    const kickoffStats = {
        homeDay: {
            played: homeDayPlayed,
            winRate: homeDayPlayed > 0 ? (homeDayWins / homeDayPlayed) * 100 : 0,
            avgGoals: homeDayPlayed > 0 ? homeDayGoals / homeDayPlayed : 0
        },
        homeNight: {
            played: homeNightPlayed,
            winRate: homeNightPlayed > 0 ? (homeNightWins / homeNightPlayed) * 100 : 0,
            avgGoals: homeNightPlayed > 0 ? homeNightGoals / homeNightPlayed : 0
        },
        awayDay: {
            played: awayDayPlayed,
            winRate: awayDayPlayed > 0 ? (awayDayWins / awayDayPlayed) * 100 : 0,
            avgGoals: awayDayPlayed > 0 ? awayDayGoals / awayDayPlayed : 0
        },
        awayNight: {
            played: awayNightPlayed,
            winRate: awayNightPlayed > 0 ? (awayNightWins / awayNightPlayed) * 100 : 0,
            avgGoals: awayNightPlayed > 0 ? awayNightGoals / awayNightPlayed : 0
        }
    };

    db.close();

    return {
        homeXG,
        awayXG,
        homeWinProb,
        drawProb,
        awayWinProb,
        topScorelines,
        correctScoresList,
        correctScoreGrid,
        over05,
        over15,
        over25,
        over35,
        over45,
        over55,
        gg,
        ng,
        evenProb,
        oddProb,
        exactGoals: {
            eg0, eg1, eg2, eg3, eg4, eg5, eg6Plus
        },
        doubleChance: {
            dc1X, dc12, dcX2
        },
        drawNoBet: {
            home: dnbHome,
            away: dnbAway
        },
        handicap3Way: {
            minus2: hcMinus2,
            minus1: hcMinus1,
            plus1: hcPlus1,
            plus2: hcPlus2
        },
        asianHandicap: {
            minus1_5: ahMinus1_5,
            plus1_5: ahPlus1_5,
            minus1_25: ahMinus1_25,
            plus1_25: ahPlus1_25,
            minus1_75: ahMinus1_75,
            plus1_75: ahPlus1_75
        },
        halftimeFulltime: {
            htft11, htft1X, htft12,
            htftX1, htftXX, htftX2,
            htft21, htft2X, htft22
        },
        highestScoringHalf: {
            firstHalf: hshFirst,
            secondHalf: hshSecond,
            equal: hshEqual
        },
        firstGoal: {
            home: fgHome,
            away: fgAway,
            none: fgNone
        },
        homeTotalGoals: {
            over05: hgOver05,
            under05: Math.max(0, 1 - hgOver05),
            over15: hgOver15,
            under15: Math.max(0, 1 - hgOver15),
            over25: hgOver25,
            under25: Math.max(0, 1 - hgOver25)
        },
        awayTotalGoals: {
            over05: agOver05,
            under05: Math.max(0, 1 - agOver05),
            over15: agOver15,
            under15: Math.max(0, 1 - agOver15),
            over25: agOver25,
            under25: Math.max(0, 1 - agOver25)
        },
        homeExactGoals,
        awayExactGoals,
        teamsToScore,
        
        // HT statistics
        ht: {
            homeHT_XG,
            awayHT_XG,
            homeWinProb: htHomeWinProb,
            drawProb: htDrawProb,
            awayWinProb: htAwayWinProb,
            topScorelines: topHTScorelines,
            over05: htOver05,
            over15: htOver15,
            over25: htOver25,
            over35: htOver35,
            over45: htOver45,
            over55: htOver55,
            gg: htGg,
            ng: htNg,
            doubleChance: {
                dc1X: htDc1X,
                dc12: htDc12,
                dcX2: htDcX2
            },
            handicap3Way: {
                minus1: htHcMinus1,
                plus1: htHcPlus1
            },
            asianHandicap: {
                minus0_5: { home: htAHMinus0_5, away: Math.max(0, 1 - htAHMinus0_5) },
                plus0_5: { home: htAHPlus0_5, away: Math.max(0, 1 - htAHPlus0_5) },
                minus0_75: { home: htAHMinus0_75, away: Math.max(0, 1 - htAHMinus0_75) },
                plus0_75: { home: Math.max(0, 1 - htAHPlus0_75), away: htAHPlus0_75 },
                minus1_5: { home: htAHMinus1_5, away: Math.max(0, 1 - htAHMinus1_5) },
                plus1_5: { home: htAHPlus1_5, away: Math.max(0, 1 - htAHPlus1_5) }
            }
        },
        
        // Time stats
        kickoffStats
    };
}

function calculateEloRatings(dbPath, homeTeam, awayTeam) {
    const db = new Database(dbPath);
    const allMatches = getCleanedMatches(db);

    if (allMatches.length < 5) {
        db.close();
        return null;
    }

    const elo = {};
    const getElo = (team) => elo[team] || 1500;
    const K = 32;

    for (const m of allMatches) {
        const rHome = getElo(m.home_team);
        const rAway = getElo(m.away_team);

        const eHome = 1 / (1 + Math.pow(10, (rAway - rHome) / 400));
        const eAway = 1 - eHome;

        let sHome = 0.5;
        if (m.home_score > m.away_score) sHome = 1;
        else if (m.home_score < m.away_score) sHome = 0;
        const sAway = 1 - sHome;

        elo[m.home_team] = rHome + K * (sHome - eHome);
        elo[m.away_team] = rAway + K * (sAway - eAway);
    }

    const homeElo = getElo(homeTeam);
    const awayElo = getElo(awayTeam);

    const homeEloWinProb = 1 / (1 + Math.pow(10, (awayElo - homeElo) / 400));
    const awayEloWinProb = 1 - homeEloWinProb;

    db.close();

    return {
        homeElo,
        awayElo,
        homeEloWinProb,
        awayEloWinProb
    };
}

function optimizeBlendingWeights(dbPath) {
    if (!fs.existsSync(dbPath)) {
        return { success: false, error: 'Database file not found' };
    }

    const db = new Database(dbPath);
    const allMatches = getCleanedMatches(db);

    if (allMatches.length < 20) {
        db.close();
        return { success: false, error: 'Insufficient matches to perform weights optimization (minimum 20 completed matches required).' };
    }

    // Chronological simulation variables
    let totalHomeGoals = 0;
    let totalAwayGoals = 0;
    let matchCount = 0;

    const stats = {};
    const initTeamStats = () => ({
        homeGoalsScored: 0,
        homeGoalsConceded: 0,
        homeMatches: 0,
        awayGoalsScored: 0,
        awayGoalsConceded: 0,
        awayMatches: 0
    });

    const elo = {};
    const getElo = (team) => elo[team] || 1500;
    const K = 32;

    const decayRates = [0.0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.035, 0.04, 0.045, 0.05];
    const testCases = [];

    // Chronological simulation loop
    for (const m of allMatches) {
        // We only evaluate predictions after we have a minimum history of 10 matches
        if (matchCount >= 10 && stats[m.home_team] && stats[m.away_team]) {
            // Calculate Elo
            const rHome = getElo(m.home_team);
            const rAway = getElo(m.away_team);
            const eHome = 1 / (1 + Math.pow(10, (rAway - rHome) / 400));
            const eAway = 1 - eHome;

            // Actual outcome
            let actual = 0; // 0 for draw, 1 for home win, -1 for away win
            if (m.home_score > m.away_score) actual = 1;
            else if (m.home_score < m.away_score) actual = -1;

            const trainingRows = allMatches.slice(0, matchCount);

            // Predict under each decay rate (using pure Poisson with weight = 1.0)
            const poissonPredictions = {};
            for (const d of decayRates) {
                const pred = predictFromRows(trainingRows, m.home_team, m.away_team, d, 1.0);
                if (pred) {
                    poissonPredictions[d] = {
                        pHome: pred.homeWinProb,
                        pAway: pred.awayWinProb
                    };
                } else {
                    poissonPredictions[d] = { pHome: 0.33, pAway: 0.33 };
                }
            }

            testCases.push({
                poissonPredictions,
                eHome,
                eAway,
                actual
            });
        }

        // Update Elo & Stats with this match
        const rHome = getElo(m.home_team);
        const rAway = getElo(m.away_team);
        const eHome = 1 / (1 + Math.pow(10, (rAway - rHome) / 400));
        const eAway = 1 - eHome;

        let sHome = 0.5;
        if (m.home_score > m.away_score) sHome = 1;
        else if (m.home_score < m.away_score) sHome = 0;
        const sAway = 1 - sHome;

        elo[m.home_team] = rHome + K * (sHome - eHome);
        elo[m.away_team] = rAway + K * (sAway - eAway);

        if (!stats[m.home_team]) stats[m.home_team] = initTeamStats();
        if (!stats[m.away_team]) stats[m.away_team] = initTeamStats();

        stats[m.home_team].homeGoalsScored += m.home_score;
        stats[m.home_team].homeGoalsConceded += m.away_score;
        stats[m.home_team].homeMatches += 1;

        stats[m.away_team].awayGoalsScored += m.away_score;
        stats[m.away_team].awayGoalsConceded += m.home_score;
        stats[m.away_team].awayMatches += 1;

        totalHomeGoals += m.home_score;
        totalAwayGoals += m.away_score;
        matchCount += 1;
    }

    db.close();

    if (testCases.length < 5) {
        return { success: false, error: 'Insufficient matchups evaluated to tune model weights.' };
    }

    // Grid search weights and decay rates to minimize Brier Score
    let bestW = 0.6;
    let bestDecay = 0.015;
    let minBrier = Infinity;

    for (const d of decayRates) {
        for (let w = 0; w <= 1.0; w += 0.05) {
            let brierSum = 0;
            for (const tc of testCases) {
                const pred = tc.poissonPredictions[d];
                const bHome = (pred.pHome * w) + (tc.eHome * (1 - w));
                const bAway = (pred.pAway * w) + (tc.eAway * (1 - w));
                const bDraw = Math.max(0, 1 - bHome - bAway);

                const actualHome = tc.actual === 1 ? 1 : 0;
                const actualDraw = tc.actual === 0 ? 1 : 0;
                const actualAway = tc.actual === -1 ? 1 : 0;

                const brier = Math.pow(bHome - actualHome, 2) + Math.pow(bDraw - actualDraw, 2) + Math.pow(bAway - actualAway, 2);
                brierSum += brier;
            }

            const avgBrier = brierSum / testCases.length;
            if (avgBrier < minBrier) {
                minBrier = avgBrier;
                bestW = w;
                bestDecay = d;
            }
        }
    }

    const weightsPath = `${dbPath}.weights.json`;
    const weightsData = {
        poissonWeight: bestW,
        eloWeight: 1 - bestW,
        decayRate: bestDecay,
        optimizedAt: new Date().toISOString(),
        brierScore: minBrier,
        matchesAnalyzed: testCases.length
    };

    try {
        fs.writeFileSync(weightsPath, JSON.stringify(weightsData, null, 2));
    } catch (err) {
        console.error("Error writing ML weights file:", err.message);
        return { success: false, error: `Failed to save weights file: ${err.message}` };
    }

    return {
        success: true,
        poissonWeight: bestW,
        eloWeight: 1 - bestW,
        decayRate: bestDecay,
        brierScore: minBrier,
        matchesAnalyzed: testCases.length
    };
}

function predictMatchupML(dbPath, homeTeam, awayTeam) {
    if (!fs.existsSync(dbPath)) {
        return { success: false, error: 'Database file not found' };
    }

    const poissonResult = calculatePoissonMatchup(dbPath, homeTeam, awayTeam);
    const eloResult = calculateEloRatings(dbPath, homeTeam, awayTeam);

    if (!poissonResult) {
        return { success: false, error: 'Insufficient match data to train Machine Learning model (need at least 5 parsed matches in the database).' };
    }

    // Load optimized weights or default to 60/40
    let poissonWeight = 0.6;
    let eloWeight = 0.4;
    const weightsPath = `${dbPath}.weights.json`;
    if (fs.existsSync(weightsPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
            if (typeof data.poissonWeight === 'number' && typeof data.eloWeight === 'number') {
                poissonWeight = data.poissonWeight;
                eloWeight = data.eloWeight;
            }
        } catch (err) {
            console.error("Error reading ML weights file, using defaults:", err.message);
        }
    }

    // Blend Poisson and Elo probabilities
    const blendedHomeWin = (poissonResult.homeWinProb * poissonWeight) + ((eloResult ? eloResult.homeEloWinProb : poissonResult.homeWinProb) * eloWeight);
    const blendedAwayWin = (poissonResult.awayWinProb * poissonWeight) + ((eloResult ? eloResult.awayEloWinProb : poissonResult.awayWinProb) * eloWeight);
    const blendedDraw = 1 - blendedHomeWin - blendedAwayWin;

    // Calculate Confidence Score
    const maxProb = Math.max(blendedHomeWin, blendedDraw, blendedAwayWin);
    let confidenceScore = Math.round(40 + (maxProb - 0.33) * 85);
    confidenceScore = Math.max(50, Math.min(98, confidenceScore));

    return {
        success: true,
        modelName: 'Blended Poisson-Elo Football Prediction Model v2.2',
        poisson: poissonResult,
        elo: eloResult,
        weights: {
            poissonWeight,
            eloWeight
        },
        blended: {
            homeWin: blendedHomeWin,
            draw: blendedDraw,
            awayWin: blendedAwayWin
        },
        confidenceScore
    };
}

/**
 * Predict match outcome using raw match rows (no DB needed).
 * Used by the backtest walk-forward simulation so we don't re-open the DB per match.
 * matchRows must be an array of { home_team, away_team, home_score, away_score }.
 */
function predictFromRows(matchRows, homeTeam, awayTeam, decayRate = 0.015, poissonWeight = 0.6) {
    if (!matchRows || matchRows.length < 5) return null;

    const { avgHomeGoals, avgAwayGoals, stats } = getWeightedStats(matchRows, decayRate);

    const homeTeamStats = stats[homeTeam];
    const awayTeamStats = stats[awayTeam];
    if (!homeTeamStats || !awayTeamStats) return null;

    const homeTeamHomeMatchesWeight = homeTeamStats.homeMatchesWeight || 1;
    const awayTeamAwayMatchesWeight = awayTeamStats.awayMatchesWeight || 1;

    const homeAttack  = (homeTeamStats.homeGoalsScored  / homeTeamHomeMatchesWeight) / avgHomeGoals;
    const homeDefense = (homeTeamStats.homeGoalsConceded / homeTeamHomeMatchesWeight) / avgAwayGoals;
    const awayAttack  = (awayTeamStats.awayGoalsScored  / awayTeamAwayMatchesWeight) / avgAwayGoals;
    const awayDefense = (awayTeamStats.awayGoalsConceded / awayTeamAwayMatchesWeight) / avgHomeGoals;

    const homeXG = homeAttack * awayDefense * avgHomeGoals;
    const awayXG = awayAttack * homeDefense * avgAwayGoals;

    // Calculate HT stats
    const { avgHomeHTGoals, avgAwayHTGoals, htStats } = getWeightedHTStats(matchRows, decayRate);
    const initHTStats = () => ({
        homeGoalsScored: 0, homeGoalsConceded: 0, homeMatchesWeight: 0,
        awayGoalsScored: 0, awayGoalsConceded: 0, awayMatchesWeight: 0
    });
    const homeTeamHT = htStats[homeTeam] || initHTStats();
    const awayTeamHT = htStats[awayTeam] || initHTStats();

    const homeHTMatchesWeightCount = homeTeamHT.homeMatchesWeight || 1;
    const awayHTMatchesWeightCount = awayTeamHT.awayMatchesWeight || 1;

    const homeHTAttack = (homeTeamHT.homeGoalsScored / homeHTMatchesWeightCount) / (avgHomeHTGoals || 1);
    const homeHTDefense = (homeTeamHT.homeGoalsConceded / homeHTMatchesWeightCount) / (avgAwayHTGoals || 1);
    const awayHTAttack = (awayTeamHT.awayGoalsScored / awayHTMatchesWeightCount) / (avgAwayHTGoals || 1);
    const awayHTDefense = (awayTeamHT.awayGoalsConceded / awayHTMatchesWeightCount) / (avgHomeHTGoals || 1);

    const homeHT_XG = homeHTAttack * awayHTDefense * avgHomeHTGoals;
    const awayHT_XG = awayHTAttack * homeHTDefense * avgAwayHTGoals;

    const maxHTGoals = 4;
    const homeHTProb = [], awayHTProb = [];
    for (let i = 0; i <= maxHTGoals; i++) {
        homeHTProb.push(poisson(homeHT_XG, i));
        awayHTProb.push(poisson(awayHT_XG, i));
    }
    const htScores = [];
    for (let h = 0; h <= maxHTGoals; h++) {
        for (let a = 0; a <= maxHTGoals; a++) {
            htScores.push({
                homeScore: h,
                awayScore: a,
                probability: homeHTProb[h] * awayHTProb[a]
            });
        }
    }
    let totalHTMatrixProb = htScores.reduce((acc, s) => acc + s.probability, 0) || 1;
    for (const s of htScores) {
        s.probability /= totalHTMatrixProb;
    }

    let htOver25 = 0;
    let htOver35 = 0;
    for (const s of htScores) {
        const total = s.homeScore + s.awayScore;
        if (total > 2) htOver25 += s.probability;
        if (total > 3) htOver35 += s.probability;
    }

    // ── Elo ──────────────────────────────────────────────────────────────────
    const elo = {};
    const getElo = (t) => elo[t] || 1500;
    const K = 32;
    for (const m of matchRows) {
        const rH = getElo(m.home_team), rA = getElo(m.away_team);
        const eH = 1 / (1 + Math.pow(10, (rA - rH) / 400));
        let sH = 0.5;
        if ((m.home_score || 0) > (m.away_score || 0)) sH = 1;
        else if ((m.home_score || 0) < (m.away_score || 0)) sH = 0;
        elo[m.home_team] = rH + K * (sH - eH);
        elo[m.away_team] = rA + K * ((1 - sH) - (1 - eH));
    }
    const homeEloWinProb = 1 / (1 + Math.pow(10, (getElo(awayTeam) - getElo(homeTeam)) / 400));
    const awayEloWinProb = 1 - homeEloWinProb;

    // ── Poisson matrix ───────────────────────────────────────────────────────
    const maxGoals = 6;
    const homeProb = [], awayProb = [];
    for (let i = 0; i <= maxGoals; i++) {
        homeProb.push(poisson(homeXG, i));
        awayProb.push(poisson(awayXG, i));
    }

    let pHome = 0, pDraw = 0, pAway = 0;
    let over05 = 0, over15 = 0, over25 = 0, over35 = 0, over45 = 0, over55 = 0, gg = 0;
    let odd = 0, even = 0;

    for (let h = 0; h <= maxGoals; h++) {
        for (let a = 0; a <= maxGoals; a++) {
            const p = homeProb[h] * awayProb[a];
            if (h > a) pHome += p;
            else if (h === a) pDraw += p;
            else pAway += p;
            const tot = h + a;
            if (tot > 0) over05 += p;
            if (tot > 1) over15 += p;
            if (tot > 2) over25 += p;
            if (tot > 3) over35 += p;
            if (tot > 4) over45 += p;
            if (tot > 5) over55 += p;
            if (h > 0 && a > 0) gg += p;
            if (tot % 2 === 1) odd += p;
            else even += p;
        }
    }

    const totalP = pHome + pDraw + pAway || 1;
    pHome /= totalP; pDraw /= totalP; pAway /= totalP;
    over05 /= totalP; over15 /= totalP; over25 /= totalP;
    over35 /= totalP; over45 /= totalP; over55 /= totalP;
    gg /= totalP;
    odd /= totalP; even /= totalP;

    // Highest Scoring Half calculation
    const lambda1H = (homeHT_XG || 0) + (awayHT_XG || 0);
    const lambda2H = Math.max(0, homeXG - (homeHT_XG || 0)) + Math.max(0, awayXG - (awayHT_XG || 0));

    const maxHalfGoals = 8;
    const p1H = [], p2H = [];
    for (let i = 0; i <= maxHalfGoals; i++) {
        p1H.push(poisson(lambda1H, i));
        p2H.push(poisson(lambda2H, i));
    }

    let htScoring1st = 0;
    let htScoring2nd = 0;
    let htScoringEqual = 0;

    for (let h1 = 0; h1 <= maxHalfGoals; h1++) {
        for (let h2 = 0; h2 <= maxHalfGoals; h2++) {
            const p = p1H[h1] * p2H[h2];
            if (h1 > h2) htScoring1st += p;
            else if (h2 > h1) htScoring2nd += p;
            else htScoringEqual += p;
        }
    }

    const totalHalfP = htScoring1st + htScoring2nd + htScoringEqual || 1;
    htScoring1st /= totalHalfP;
    htScoring2nd /= totalHalfP;
    htScoringEqual /= totalHalfP;

    // HT/FT Combinations
    const homeSH_XG = Math.max(0, homeXG - (homeHT_XG || 0));
    const awaySH_XG = Math.max(0, awayXG - (awayHT_XG || 0));
    
    const maxSHGoals = 4;
    const shHomeProb = [], shAwayProb = [];
    for (let i = 0; i <= maxSHGoals; i++) {
        shHomeProb.push(poisson(homeSH_XG, i));
        shAwayProb.push(poisson(awaySH_XG, i));
    }
    const shScores = [];
    for (let h = 0; h <= maxSHGoals; h++) {
        for (let a = 0; a <= maxSHGoals; a++) {
            shScores.push({
                homeScore: h,
                awayScore: a,
                probability: shHomeProb[h] * shAwayProb[a]
            });
        }
    }
    let totalSHMatrixProb = shScores.reduce((acc, s) => acc + s.probability, 0) || 1;
    for (const s of shScores) {
        s.probability /= totalSHMatrixProb;
    }

    let htft11 = 0, htft1X = 0, htft12 = 0;
    let htftX1 = 0, htftXX = 0, htftX2 = 0;
    let htft21 = 0, htft2X = 0, htft22 = 0;

    for (const s1 of htScores) {
        const htResult = s1.homeScore > s1.awayScore ? '1' : (s1.homeScore === s1.awayScore ? 'X' : '2');
        for (const s2 of shScores) {
            const ftHome = s1.homeScore + s2.homeScore;
            const ftAway = s1.awayScore + s2.awayScore;
            const ftResult = ftHome > ftAway ? '1' : (ftHome === ftAway ? 'X' : '2');
            
            const prob = s1.probability * s2.probability;
            
            if (htResult === '1' && ftResult === '1') htft11 += prob;
            else if (htResult === '1' && ftResult === 'X') htft1X += prob;
            else if (htResult === '1' && ftResult === '2') htft12 += prob;
            else if (htResult === 'X' && ftResult === '1') htftX1 += prob;
            else if (htResult === 'X' && ftResult === 'X') htftXX += prob;
            else if (htResult === 'X' && ftResult === '2') htftX2 += prob;
            else if (htResult === '2' && ftResult === '1') htft21 += prob;
            else if (htResult === '2' && ftResult === 'X') htft2X += prob;
            else if (htResult === '2' && ftResult === '2') htft22 += prob;
        }
    }

    // ── Blend Poisson + Elo ─────────────────────────────────────────────────
    const w = poissonWeight;
    const blendedHomeWin = pHome * w + homeEloWinProb * (1 - w);
    const blendedAwayWin = pAway * w + awayEloWinProb * (1 - w);
    const blendedDraw    = Math.max(0, 1 - blendedHomeWin - blendedAwayWin);

    return {
        homeWinProb: blendedHomeWin,
        drawProb:    blendedDraw,
        awayWinProb: blendedAwayWin,
        over05, over15, over25, over35, over45, over55, gg,
        htOver25, htOver35,
        odd, even,
        htScoring1st, htScoring2nd, htScoringEqual,
        halftimeFulltime: {
            htft11, htft1X, htft12,
            htftX1, htftXX, htftX2,
            htft21, htft2X, htft22
        }
    };
}

/**
 * Full walk-forward backtest using Poisson+Elo.
 * Reads ALL matches from both the fixtures table AND betting_analytics table,
 * then for each match in the target season it predicts using only prior data.
 * dbPath – path to the SQLite DB that has a betting_analytics table.
 */
function runBacktestML(dbPath, seasonName) {
    if (!fs.existsSync(dbPath)) {
        return { success: false, error: 'Database file not found' };
    }

    const db = new Database(dbPath);

    // Fetch the target season's matches (ordered chronologically)
    let seasonMatches = [];
    try {
        seasonMatches = db.prepare(
            "SELECT * FROM betting_analytics WHERE season_name = ? ORDER BY id ASC"
        ).all(seasonName);
    } catch (e) {
        db.close();
        return { success: false, error: 'Could not read betting_analytics: ' + e.message };
    }

    if (seasonMatches.length === 0) {
        db.close();
        return { success: false, error: 'No matches found for season: ' + seasonName };
    }

    // Fetch ALL matches from betting_analytics as training pool (ordered by id)
    let allMatches = [];
    try {
        allMatches = db.prepare(
            "SELECT id, home_team, away_team, home_score, away_score, ht_home_score, ht_away_score FROM betting_analytics ORDER BY id ASC"
        ).all();
    } catch (e) {
        db.close();
        return { success: false, error: 'Could not read training data: ' + e.message };
    }

    db.close();

    let decayRate = 0.015;
    let poissonWeight = 0.6;
    const weightsPath = `${dbPath}.weights.json`;
    if (fs.existsSync(weightsPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
            if (typeof data.decayRate === 'number') {
                decayRate = data.decayRate;
            }
            if (typeof data.poissonWeight === 'number') {
                poissonWeight = data.poissonWeight;
            }
        } catch (e) {
            // ignore
        }
    }

    // Walk-forward: for each test match use only rows with id < match.id
    const results = [];

    for (const match of seasonMatches) {
        const { home_team, away_team, match_result, over_1_5, over_2_5, gg_ng, total_goals } = match;

        // Training set = up to the last 3000 rows strictly before this match (prevents data leakage & noise)
        const trainingRows = allMatches.filter(r => r.id < match.id).slice(-3000);

        const pred = predictFromRows(trainingRows, home_team, away_team, decayRate, poissonWeight);

        // Actual outcomes
        const actualResult  = match_result;              // 'Home', 'Draw', 'Away'
        const actualOver15  = over_1_5 === 'Yes';
        const actualOver25  = over_2_5 === 'Yes';
        const actualOver35  = (total_goals || 0) > 3;
        const actualOver45  = (total_goals || 0) > 4;
        const actualOver55  = (total_goals || 0) > 5;

        const actualUnder15  = !actualOver15;
        const actualUnder25  = !actualOver25;
        const actualUnder35  = !actualOver35;
        const actualUnder45  = !actualOver45;
        const actualUnder55  = !actualOver55;

        const actualGG      = gg_ng === 'GG';
        const actualHTGoals = (match.ht_home_score || 0) + (match.ht_away_score || 0);
        const actualHTOver25 = actualHTGoals > 2;
        const actualHTUnder25 = actualHTGoals <= 2;
        const actualHTOver35 = actualHTGoals > 3;
        const actualHTUnder35 = actualHTGoals <= 3;

        const actualOdd  = (total_goals || 0) % 2 === 1;
        const actualEven = (total_goals || 0) % 2 === 0;
        const actual2HGoals = (match.home_score || 0) - (match.ht_home_score || 0) + (match.away_score || 0) - (match.ht_away_score || 0);
        const actual1stHalfHigher = actualHTGoals > actual2HGoals;
        const actual2ndHalfHigher = actualHTGoals < actual2HGoals;
        const actualHalvesEqual   = actualHTGoals === actual2HGoals;
        const actualTeamsToScoreBoth = (match.home_score > 0 && match.away_score > 0);
        const actualTeamsToScoreOnlyHome = (match.home_score > 0 && match.away_score === 0);
        const actualTeamsToScoreOnlyAway = (match.home_score === 0 && match.away_score > 0);
        const actualTeamsToScoreNone = (match.home_score === 0 && match.away_score === 0);

        if (!pred) {
            // Not enough training data for this match – skip
            results.push({
                homeTeam: home_team, awayTeam: away_team,
                actualResult, actualOver15, actualOver25, actualOver35, actualOver45, actualOver55, actualGG,
                actualUnder15, actualUnder25, actualUnder35, actualUnder45, actualUnder55,
                actualHTOver25, actualHTUnder25, actualHTOver35, actualHTUnder35,
                actualOdd, actualEven, actual1stHalfHigher, actual2ndHalfHigher, actualHalvesEqual,
                predicted: null, predOver15: null, predOver25: null, predOver35: null,
                predOver45: null, predOver55: null, predGG: null,
                predUnder15: null, predUnder25: null, predUnder35: null, predUnder45: null, predUnder55: null,
                predHTOver25: null, predHTUnder25: null, predHTOver35: null, predHTUnder35: null,
                homeWinProb: null, drawProb: null, awayWinProb: null,
                ggProb: null, oddProb: null, evenProb: null,
                htScoring1stProb: null, htScoring2ndProb: null, htScoringEqualProb: null,
                trainingSize: trainingRows.length,
                skipped: true,
                actualDNBHome: false,
                actualDNBAway: false,
                isNotDraw: false,
                dnbHomeProb: null,
                dnbAwayProb: null,
                actualTeamsToScoreBoth: false,
                actualTeamsToScoreOnlyHome: false,
                actualTeamsToScoreOnlyAway: false,
                actualTeamsToScoreNone: false,
                teamsToScoreBothProb: null,
                teamsToScoreOnlyHomeProb: null,
                teamsToScoreOnlyAwayProb: null,
                teamsToScoreNoneProb: null,
                correct1X2: false, correctOver15: false, correctOver25: false,
                correctOver35: false, correctOver45: false, correctOver55: false, correctGG: false,
                correctUnder15: false, correctUnder25: false, correctUnder35: false, correctUnder45: false, correctUnder55: false,
                correctHTOver25: false, correctHTUnder25: false, correctHTOver35: false, correctHTUnder35: false
            });
            continue;
        }

        // Determine predicted outcomes using Poisson probabilities
        let predicted;
        if (pred.homeWinProb >= pred.drawProb && pred.homeWinProb >= pred.awayWinProb)
            predicted = 'Home';
        else if (pred.awayWinProb >= pred.homeWinProb && pred.awayWinProb >= pred.drawProb)
            predicted = 'Away';
        else
            predicted = 'Draw';

        const predOver15 = pred.over15 > 0.50;
        const predOver25 = pred.over25 > 0.50;
        const predOver35 = pred.over35 > 0.50;
        const predOver45 = pred.over45 > 0.50;
        const predOver55 = pred.over55 > 0.50;
        const predGG     = pred.gg     > 0.50;

        const predUnder15 = pred.over15 <= 0.50;
        const predUnder25 = pred.over25 <= 0.50;
        const predUnder35 = pred.over35 <= 0.50;
        const predUnder45 = pred.over45 <= 0.50;
        const predUnder55 = pred.over55 <= 0.50;

        const predHTOver25  = pred.htOver25 > 0.50;
        const predHTUnder25 = pred.htOver25 <= 0.50;
        const predHTOver35  = pred.htOver35 > 0.50;
        const predHTUnder35 = pred.htOver35 <= 0.50;

        results.push({
            homeTeam: home_team,
            awayTeam: away_team,
            actualResult,
            actualOver15,
            actualOver25,
            actualOver35,
            actualOver45,
            actualOver55,
            actualUnder15,
            actualUnder25,
            actualUnder35,
            actualUnder45,
            actualUnder55,
            actualGG,
            actualHTOver25,
            actualHTUnder25,
            actualHTOver35,
            actualHTUnder35,
            actualOdd,
            actualEven,
            actual1stHalfHigher,
            actual2ndHalfHigher,
            actualHalvesEqual,
            predicted,
            predOver15,
            predOver25,
            predOver35,
            predOver45,
            predOver55,
            predUnder15,
            predUnder25,
            predUnder35,
            predUnder45,
            predUnder55,
            predGG,
            predHTOver25,
            predHTUnder25,
            predHTOver35,
            predHTUnder35,
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
            actualDNBHome: actualResult === 'Home',
            actualDNBAway: actualResult === 'Away',
            isNotDraw:      actualResult !== 'Draw',
            dnbHomeProb:  Math.round((pred.drawNoBet ? pred.drawNoBet.home : 0.5) * 100),
            dnbAwayProb:  Math.round((pred.drawNoBet ? pred.drawNoBet.away : 0.5) * 100),
            actualTeamsToScoreBoth,
            actualTeamsToScoreOnlyHome,
            actualTeamsToScoreOnlyAway,
            actualTeamsToScoreNone,
            teamsToScoreBothProb: Math.round((pred.teamsToScore ? pred.teamsToScore.both : 0) * 100),
            teamsToScoreOnlyHomeProb: Math.round((pred.teamsToScore ? pred.teamsToScore.onlyHome : 0) * 100),
            teamsToScoreOnlyAwayProb: Math.round((pred.teamsToScore ? pred.teamsToScore.onlyAway : 0) * 100),
            teamsToScoreNoneProb: Math.round((pred.teamsToScore ? pred.teamsToScore.none : 0) * 100),
            trainingSize: trainingRows.length,
            skipped: false,
            correct1X2:    predicted  === actualResult,
            correctOver15: predOver15 === actualOver15,
            correctOver25: predOver25 === actualOver25,
            correctOver35: predOver35 === actualOver35,
            correctOver45: predOver45 === actualOver45,
            correctOver55: predOver55 === actualOver55,
            correctUnder15: predUnder15 === actualUnder15,
            correctUnder25: predUnder25 === actualUnder25,
            correctUnder35: predUnder35 === actualUnder35,
            correctUnder45: predUnder45 === actualUnder45,
            correctUnder55: predUnder55 === actualUnder55,
            correctGG:     predGG     === actualGG,
            correctHTOver25:  predHTOver25  === actualHTOver25,
            correctHTUnder25: predHTUnder25 === actualHTUnder25,
            correctHTOver35:  predHTOver35  === actualHTOver35,
            correctHTUnder35: predHTUnder35 === actualHTUnder35
        });
    }

    // Aggregate accuracy (only non-skipped rows)
    const evaluated = results.filter(r => !r.skipped);
    const total = evaluated.length;
    const acc = (field) => total > 0 ? (evaluated.filter(r => r[field]).length / total) * 100 : 0;

    return {
        success: true,
        seasonName,
        totalMatches: results.length,
        evaluatedMatches: total,
        skippedMatches: results.length - total,
        modelName: 'Blended Poisson-Elo Football Prediction Model v2.2 (Walk-Forward Backtest)',
        accuracy: {
            result:  acc('correct1X2'),
            over15:  acc('correctOver15'),
            over25:  acc('correctOver25'),
            over35:  acc('correctOver35'),
            over45:  acc('correctOver45'),
            over55:  acc('correctOver55'),
            under15: acc('correctUnder15'),
            under25: acc('correctUnder25'),
            under35: acc('correctUnder35'),
            under45: acc('correctUnder45'),
            under55: acc('correctUnder55'),
            gg:      acc('correctGG'),
            htOver25: acc('correctHTOver25'),
            htUnder25: acc('correctHTUnder25'),
            htOver35: acc('correctHTOver35'),
            htUnder35: acc('correctHTUnder35')
        },
        results
    };
}

module.exports = {
    predictMatchupML,
    optimizeBlendingWeights,
    predictFromRows,
    runBacktestML
};
