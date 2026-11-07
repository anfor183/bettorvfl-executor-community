const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'bet_tracker.db');

let dbInstance = null;

function getDB() {
  if (!dbInstance) {
    dbInstance = new Database(DB_PATH);
    dbInstance.pragma('journal_mode = WAL');
    initTables(dbInstance);
  }
  return dbInstance;
}

function initTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id TEXT,
      season_name TEXT,
      week TEXT,
      round TEXT,
      kickoff_time TEXT,
      home_team TEXT,
      away_team TEXT,
      market TEXT,
      selection TEXT,
      odds REAL,
      stake REAL,
      currency TEXT DEFAULT 'NGN',
      status TEXT DEFAULT 'PENDING',
      ticket_id TEXT,
      placed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      settled_at DATETIME,
      profit_loss REAL DEFAULT 0,
      potential_payout REAL DEFAULT 0,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status);
    CREATE INDEX IF NOT EXISTS idx_bets_round ON bets(round);
    CREATE INDEX IF NOT EXISTS idx_bets_placed_at ON bets(placed_at);

    CREATE TABLE IF NOT EXISTS balance_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      balance REAL,
      currency TEXT DEFAULT 'NGN',
      delta REAL DEFAULT 0
    );
  `);

  // Virtual seasons repeat fixtures. A fixture is not a unique wager: the bookmaker ticket is.
  // Rebuild legacy tables transactionally, retaining every historical row and index.
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bets'").get().sql;
  const fixtureUnique = /,\s*UNIQUE\s*\(\s*round\s*,\s*home_team\s*,\s*away_team\s*,\s*market\s*,\s*selection\s*\)/i;
  if (fixtureUnique.test(schema)) {
    db.transaction(() => {
      const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'bets' AND sql IS NOT NULL").all();
      const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'bets'").get();
      db.exec(schema.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?bets/i, 'CREATE TABLE bets_fixture_migration').replace(fixtureUnique, ''));
      db.exec('INSERT INTO bets_fixture_migration SELECT * FROM bets; DROP TABLE bets; ALTER TABLE bets_fixture_migration RENAME TO bets;');
      if (sequence) db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'bets'").run(sequence.seq);
      for (const index of indexes) db.exec(index.sql);
    }).immediate();
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_bets_ticket_id ON bets(ticket_id)');
}

/**
 * Team name mapping for robust matching between predictor and 1xBet
 */
const TEAM_ALIASES = {
  'tot': ['tottenham', 'spurs'],
  'lee': ['leeds', 'leeds united'],
  'cry': ['crystal palace', 'palace'],
  'che': ['chelsea'],
  'bou': ['bournemouth'],
  'hll': ['hull', 'hull city'],
  'new': ['newcastle', 'newcastle united'],
  'for': ['forest', 'nottingham forest'],
  'brn': ['burnley'],
  'ips': ['ipswich', 'ipswich town'],
  'liv': ['liverpool'],
  'sun': ['sunderland'],
  'eve': ['everton'],
  'cov': ['coventry', 'coventry city'],
  'ast': ['aston villa', 'villa'],
  'ful': ['fulham'],
  'bha': ['brighton', 'brighton and hove albion'],
  'mun': ['man utd', 'manchester united', 'man united'],
  'ars': ['arsenal'],
  'mci': ['man city', 'manchester city']
};

function normalizeTeam(name) {
  if (!name) return '';
  const clean = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [abbr, aliases] of Object.entries(TEAM_ALIASES)) {
    if (clean === abbr || aliases.some(a => clean === a.replace(/[^a-z0-9]/g, ''))) {
      return abbr;
    }
  }
  return clean.slice(0, 3);
}

function normalizeRound(round) {
  if (!round) return '';
  const m = String(round).match(/\d+/);
  return m ? m[0] : String(round).trim();
}

/**
 * Check if a bet on the same round, match, market, and selection has already been staked
 */
function hasBetBeenPlaced(round, homeTeam, awayTeam, market, selection, signalId) {
  try {
    const db = getDB();

    // 1. Direct signal ID check
    if (signalId) {
      const sigRow = db.prepare('SELECT id FROM bets WHERE signal_id = ? LIMIT 1').get(String(signalId));
      if (sigRow) return true;
    }

    const normRound = normalizeRound(round);
    const normHome = normalizeTeam(homeTeam);
    const normAway = normalizeTeam(awayTeam);
    const normMarket = String(market || '').trim().toLowerCase();

    // 2. Query recent bets and check normalized values
    const rows = db.prepare(`
      SELECT id, signal_id, round, home_team, away_team, market, selection 
      FROM bets 
      ORDER BY id DESC LIMIT 50
    `).all();

    for (const r of rows) {
      const rRound = normalizeRound(r.round);
      const rHome = normalizeTeam(r.home_team);
      const rAway = normalizeTeam(r.away_team);
      const rMarket = String(r.market || '').trim().toLowerCase();

      // If round matches (or either is empty) AND both teams match AND market matches
      const roundMatches = (!normRound || !rRound || normRound === rRound);
      const teamsMatch = (normHome === rHome && normAway === rAway);
      const marketMatches = (normMarket === rMarket);

      if (roundMatches && teamsMatch && marketMatches) {
        return true;
      }
    }

    return false;
  } catch (e) {
    console.error('[DB] Error checking hasBetBeenPlaced:', e.message);
    return false;
  }
}

/**
 * Record a newly placed single flat bet into the database
 */
function recordPlacedBet(betData) {
  try {
    const db = getDB();
    const odds = parseFloat(betData.odds) || 1.0;
    const stake = parseFloat(betData.stake) || 0;
    const potentialPayout = odds * stake;

    const stmt = db.prepare(`
      INSERT INTO bets (
        signal_id, season_name, week, round, kickoff_time,
        home_team, away_team, market, selection, odds,
        stake, currency, status, ticket_id, potential_payout, placed_at
      ) VALUES (
        @signal_id, @season_name, @week, @round, @kickoff_time,
        @home_team, @away_team, @market, @selection, @odds,
        @stake, @currency, @status, @ticket_id, @potential_payout, COALESCE(@placed_at, CURRENT_TIMESTAMP)
      )
    `);

    const values = {
      signal_id: betData.signal_id || `sig_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      season_name: betData.season_name || '',
      week: betData.week || '',
      round: betData.round || '',
      kickoff_time: betData.kickoff_time || '',
      home_team: betData.home_team || '',
      away_team: betData.away_team || '',
      market: betData.market || '',
      selection: betData.selection || '',
      odds: odds,
      stake: stake,
      currency: betData.currency || 'NGN',
      status: betData.status || 'PENDING',
      ticket_id: betData.ticket_id || '',
      potential_payout: potentialPayout,
      placed_at: betData.placed_at ? new Date(betData.placed_at).toISOString().slice(0, 19).replace('T', ' ') : null
    };

    return db.transaction(() => {
      // Retry confirmation must not count the same bookmaker ticket twice.
      if (values.ticket_id) {
        const existing = db.prepare('SELECT id FROM bets WHERE ticket_id = ? LIMIT 1').get(String(values.ticket_id));
        if (existing) return existing.id;
      }
      const res = stmt.run(values);
      return res.changes === 1 ? Number(res.lastInsertRowid) : null;
    }).immediate();
  } catch (e) {
    console.error('[DB] Error recording placed bet:', e.message);
    return null;
  }
}

/**
 * Update the result and profit/loss of a settled bet
 */
function updateBetSettlement(betIdOrSignalId, status, profitLoss = 0) {
  try {
    const db = getDB();
    const stmt = db.prepare(`
      UPDATE bets 
      SET status = ?, 
          profit_loss = ?, 
          settled_at = CURRENT_TIMESTAMP
      WHERE id = ? OR signal_id = ? OR ticket_id = ?
    `);
    const res = stmt.run(status, parseFloat(profitLoss) || 0, betIdOrSignalId, betIdOrSignalId, betIdOrSignalId);
    return res.changes > 0;
  } catch (e) {
    console.error('[DB] Error updating bet settlement:', e.message);
    return false;
  }
}

/**
 * Fetch recent bets with optional status filtering
 */
function getRecentBets(limit = 100, filterStatus = null) {
  try {
    const db = getDB();
    let query = 'SELECT * FROM bets';
    const params = [];

    if (filterStatus && filterStatus !== 'ALL') {
      query += ' WHERE status = ?';
      params.push(filterStatus.toUpperCase());
    }

    query += ' ORDER BY placed_at DESC, id DESC LIMIT ?';
    params.push(limit);

    return db.prepare(query).all(...params);
  } catch (e) {
    console.error('[DB] Error fetching recent bets:', e.message);
    return [];
  }
}

/**
 * Calculate live performance statistics
 */
function getBetStats() {
  try {
    const db = getDB();
    const counts = db.prepare(`
      SELECT 
        COUNT(*) as totalBets,
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pendingBets,
        SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as wonBets,
        SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) as lostBets,
        SUM(CASE WHEN status = 'VOID' THEN 1 ELSE 0 END) as voidBets,
        COALESCE(SUM(stake), 0) as totalStaked,
        COALESCE(SUM(CASE WHEN status = 'PENDING' THEN stake ELSE 0 END), 0) as activeStake,
        COALESCE(SUM(profit_loss), 0) as netProfit,
        COALESCE(SUM(CASE WHEN status = 'WON' THEN potential_payout ELSE 0 END), 0) as totalReturns
      FROM bets
    `).get();

    const decidedBets = (counts.wonBets || 0) + (counts.lostBets || 0);
    const winRate = decidedBets > 0 ? ((counts.wonBets / decidedBets) * 100).toFixed(1) : '0.0';
    const totalStaked = counts.totalStaked || 0;
    const netProfit = counts.netProfit || 0;
    const roi = totalStaked > 0 ? ((netProfit / totalStaked) * 100).toFixed(1) : '0.0';

    return {
      totalBets: counts.totalBets || 0,
      pendingBets: counts.pendingBets || 0,
      wonBets: counts.wonBets || 0,
      lostBets: counts.lostBets || 0,
      voidBets: counts.voidBets || 0,
      winRate: parseFloat(winRate),
      totalStaked: Math.round(totalStaked * 100) / 100,
      activeStake: Math.round(counts.activeStake * 100) / 100,
      netProfit: Math.round(netProfit * 100) / 100,
      totalReturns: Math.round(counts.totalReturns * 100) / 100,
      roi: parseFloat(roi)
    };
  } catch (e) {
    console.error('[DB] Error calculating bet stats:', e.message);
    return {
      totalBets: 0, pendingBets: 0, wonBets: 0, lostBets: 0, voidBets: 0,
      winRate: 0, totalStaked: 0, activeStake: 0, netProfit: 0, totalReturns: 0, roi: 0
    };
  }
}

/**
 * Record a bankroll balance entry and calculate delta from previous entry
 */
function recordBalance(balance, currency = 'NGN') {
  try {
    const db = getDB();
    const bal = parseFloat(balance);
    if (isNaN(bal)) return null;

    const last = db.prepare('SELECT balance FROM balance_history ORDER BY id DESC LIMIT 1').get();
    const delta = last ? (bal - last.balance) : 0;

    const stmt = db.prepare(`
      INSERT INTO balance_history (balance, currency, delta)
      VALUES (?, ?, ?)
    `);
    stmt.run(bal, currency.toUpperCase(), delta);
    return { balance: bal, currency, delta };
  } catch (e) {
    console.error('[DB] Error recording balance:', e.message);
    return null;
  }
}

/**
 * Retrieve the latest balance snapshot
 */
function getLatestBalance() {
  try {
    const db = getDB();
    return db.prepare('SELECT * FROM balance_history ORDER BY id DESC LIMIT 1').get() || null;
  } catch (e) {
    return null;
  }
}

/**
 * Fetch bankroll balance history for plotting graphs
 */
function getBalanceHistory(limit = 60) {
  try {
    const db = getDB();
    return db.prepare('SELECT * FROM balance_history ORDER BY id ASC LIMIT ?').all(limit);
  } catch (e) {
    return [];
  }
}

/**
 * Export all bet records as CSV
 */
function exportBetsToCSV() {
  try {
    const db = getDB();
    const rows = db.prepare('SELECT * FROM bets ORDER BY id DESC').all();
    if (rows.length === 0) return 'id,placed_at,kickoff_time,round,home_team,away_team,market,selection,odds,stake,currency,status,profit_loss\n';

    const headers = ['id', 'placed_at', 'kickoff_time', 'round', 'home_team', 'away_team', 'market', 'selection', 'odds', 'stake', 'currency', 'status', 'profit_loss', 'ticket_id'];
    const csvLines = [headers.join(',')];

    for (const r of rows) {
      const line = headers.map(h => {
        let val = r[h] !== null && r[h] !== undefined ? String(r[h]) : '';
        if (val.includes(',') || val.includes('"') || val.includes('\n')) {
          val = `"${val.replace(/"/g, '""')}"`;
        }
        return val;
      });
      csvLines.push(line.join(','));
    }

    return csvLines.join('\n');
  } catch (e) {
    console.error('[DB] Error exporting CSV:', e.message);
    return '';
  }
}

/**
 * Export all bet records as JSON string
 */
function exportBetsToJSON() {
  try {
    const db = getDB();
    const rows = db.prepare('SELECT * FROM bets ORDER BY id DESC').all();
    return JSON.stringify(rows, null, 2);
  } catch (e) {
    console.error('[DB] Error exporting JSON:', e.message);
    return '[]';
  }
}

function syncSummaryJson() {
  try {
    const summary = {
      stats: getBetStats(),
      recentBets: getRecentBets(100),
      balanceHistory: getBalanceHistory(60)
    };
    fs.writeFileSync(path.join(DATA_DIR, 'tracker_summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  } catch (e) {}
}

function syncSettlementsWithPredictor() {
  return new Promise((resolve) => {
    try {
      const pendingBets = getRecentBets(100, 'PENDING');
      if (!pendingBets || pendingBets.length === 0) {
        return resolve({ settledCount: 0 });
      }

      let serverUrl = process.env.SIGNAL_SERVER_URL || 'http://127.0.0.1:4000';
      try {
        const sigPath = path.resolve(__dirname, '..', 'collected_signals.json');
        if (fs.existsSync(sigPath)) {
          const sigData = JSON.parse(fs.readFileSync(sigPath, 'utf8'));
          if (sigData && sigData.config && sigData.config.serverUrl) {
            serverUrl = sigData.config.serverUrl;
          }
        }
      } catch (e) {}

      const apiKey = process.env.SIGNAL_API_KEY || 'vfl_live_key_2026';
      const cleanBase = serverUrl.replace(/\/+$/, '');
      const reqUrl = `${cleanBase}/api/picks/settled?api_key=${encodeURIComponent(apiKey)}&limit=100`;
      const httpModule = reqUrl.startsWith('https') ? require('https') : require('http');

      httpModule.get(reqUrl, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const settledList = json.data || (Array.isArray(json) ? json : []);
            let settledCount = 0;

            for (const bet of pendingBets) {
              const match = settledList.find(s => String(s.id) === String(bet.signal_id));
              if (match && (match.status === 'won' || match.status === 'lost' || match.status === 'void')) {
                const status = match.status.toUpperCase();
                let profitLoss = 0;
                if (status === 'WON') {
                  profitLoss = Number(((bet.odds * bet.stake) - bet.stake).toFixed(2));
                } else if (status === 'LOST') {
                  profitLoss = -Number(bet.stake);
                }
                updateBetSettlement(bet.id, status, profitLoss);
                settledCount++;
              }
            }
            if (settledCount > 0) {
              syncSummaryJson();
            }
            resolve({ settledCount });
          } catch (e) {
            resolve({ settledCount: 0, error: e.message });
          }
        });
      }).on('error', err => resolve({ settledCount: 0, error: err.message }));
    } catch (e) {
      resolve({ settledCount: 0, error: e.message });
    }
  });
}

function clearAllStatsAndBets(options = {}) {
  try {
    const db = getDB();
    db.exec(`
      DELETE FROM bets;
      DELETE FROM balance_history;
    `);

    // Reset tracker_summary.json while preserving live balance & currency
    let currentBalance = 0;
    let currentCurrency = 'NGN';

    const summaryPath = path.join(DATA_DIR, 'tracker_summary.json');
    if (fs.existsSync(summaryPath)) {
      try {
        const old = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
        if (old.liveBalance != null && !isNaN(old.liveBalance)) {
          currentBalance = Number(old.liveBalance);
        }
        if (old.currency) {
          currentCurrency = old.currency;
        }
      } catch (e) {}
    }

    if (options.preserveBalance === false) {
      currentBalance = 0;
    }

    const resetSummary = {
      lastUpdated: new Date().toISOString(),
      liveBalance: currentBalance,
      currency: currentCurrency,
      stats: {
        totalBets: 0,
        pendingBets: 0,
        wonBets: 0,
        lostBets: 0,
        voidBets: 0,
        winRate: 0,
        totalStaked: 0,
        activeStake: 0,
        netProfit: 0,
        totalReturns: 0,
        roi: 0
      },
      recentBets: [],
      balanceHistory: currentBalance > 0 ? [{
        id: Date.now(),
        timestamp: new Date().toISOString(),
        balance: currentBalance,
        currency: currentCurrency,
        delta: 0
      }] : []
    };

    fs.writeFileSync(summaryPath, JSON.stringify(resetSummary, null, 2), 'utf8');
    return { success: true, message: 'All tracker bets and statistics have been reset successfully.' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  getDB,
  hasBetBeenPlaced,
  recordPlacedBet: function(...args) {
    const res = recordPlacedBet(...args);
    syncSummaryJson();
    return res;
  },
  updateBetSettlement: function(...args) {
    const res = updateBetSettlement(...args);
    syncSummaryJson();
    return res;
  },
  getRecentBets,
  getBetStats,
  recordBalance: function(...args) {
    const res = recordBalance(...args);
    syncSummaryJson();
    return res;
  },
  getLatestBalance,
  getBalanceHistory,
  exportBetsToCSV,
  exportBetsToJSON,
  syncSummaryJson,
  syncSettlementsWithPredictor,
  clearAllStatsAndBets,
  DB_PATH
};
