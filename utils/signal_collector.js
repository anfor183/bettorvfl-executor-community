const { strategyId, normalizeStrategy } = require('./strategy_identity');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const logger = require('./logger');

let WebSocketImpl = null;
try {
  WebSocketImpl = require('ws');
} catch (e) {
  if (typeof WebSocket !== 'undefined') {
    WebSocketImpl = WebSocket;
  }
}

class SignalCollector extends EventEmitter {
  constructor() {
    super();

    this.config = {
      serverUrl: 'http://127.0.0.1:4000',
      apiKey: 'vfl_live_key_2026',
      autoConnect: true,
      pollIntervalSec: 8,
      dbPath: '',
      maxHistoryLimit: 200
    };

    this.state = {
      connected: false,
      connecting: false,
      transport: 'disconnected', // 'websocket' | 'polling' | 'sqlite' | 'disconnected'
      lastPingMs: null,
      lastSyncTime: null,
      lastError: null,
      serverHealth: null
    };

    this.pendingPicks = new Map(); // key: id or composite key => pick object
    this.settledPicks = []; // array of settled pick objects
    this.activityLogs = []; // array of { id, timestamp, type, message }
    this.stats = {
      totalReceived: 0,
      totalPending: 0,
      totalSettled: 0,
      wonCount: 0,
      lostCount: 0,
      voidCount: 0,
      winRate: 0,
      avgOdds: 0
    };

    this.ws = null;
    this.reconnectTimer = null;
    this.pollTimer = null;
    this.healthTimer = null;
    this.reconnectDelay = 2000;
    this.isExplicitlyStopped = false;
    this.storageFile = path.resolve(__dirname, '..', 'collected_signals.json');

    this.loadFromStorage();
  }

  log(type, message) {
    const entry = {
      id: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      type, // 'info' | 'success' | 'warn' | 'error' | 'signal' | 'settled'
      message
    };
    this.activityLogs.unshift(entry);
    if (this.activityLogs.length > 150) {
      this.activityLogs.pop();
    }
    this.emit('log', entry);
    this.emit('state-changed', this.getState());

    // Write persistently to collector.log and all.log
    try {
      if (type === 'error') {
        logger.error('Collector', message);
      } else if (type === 'warn') {
        logger.warn('Collector', message);
      } else {
        logger.info('Collector', `[${type.toUpperCase()}] ${message}`);
      }
    } catch (e) {}
  }

  cleanSeasonName(rawName) {
    if (!rawName) return 'Golden Race VFL England League';
    return String(rawName).replace(/sportybet\s*(england)?/gi, 'Golden Race VFL England League').trim();
  }

  cleanupStalePendingPicks() {
    const now = Date.now();
    let expiredCount = 0;
    for (const [key, p] of this.pendingPicks.entries()) {
      // In Virtual Football, matches start every 3m and finish in ~90s.
      // If kickoff was more than 3.5 minutes ago (210,000ms), match has completed.
      if (p.kickoff_timestamp && (now - p.kickoff_timestamp) > 210000) {
        this.pendingPicks.delete(key);
        const alreadyInSettled = this.settledPicks.some(s => s.id === p.id);
        if (!alreadyInSettled) {
          this.settledPicks.unshift({
            ...p,
            status: p.status === 'pending' ? 'completed' : p.status,
            actual_score: p.actual_score || 'Completed'
          });
        }
        expiredCount++;
      }
    }
    if (expiredCount > 0) {
      this.recalculateStats();
      this.pollSettledPicks();
    }
    return expiredCount;
  }

  loadFromStorage() {
    try {
      if (fs.existsSync(this.storageFile)) {
        const raw = fs.readFileSync(this.storageFile, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.pendingPicks)) {
          data.pendingPicks.forEach(p => {
            p.season_name = this.cleanSeasonName(p.season_name);
            Object.assign(p, normalizeStrategy(p));
            p.pick_type = this.classifyPickType(p);
            const key = p.id != null ? String(p.id) : `${p.season_name}_${p.round_number}_${p.pick_type}_${p.market}`;
            this.pendingPicks.set(key, p);
          });
        }
        if (Array.isArray(data.settledPicks)) {
          this.settledPicks = data.settledPicks.slice(0, this.config.maxHistoryLimit).map(p => {
            p.season_name = this.cleanSeasonName(p.season_name);
            Object.assign(p, normalizeStrategy(p));
            p.pick_type = this.classifyPickType(p);
            return p;
          });
        }
        if (Array.isArray(data.activityLogs)) {
          this.activityLogs = data.activityLogs.slice(0, 100);
        }
        if (data.config) {
          this.config = { ...this.config, ...data.config };
        }
        this.cleanupStalePendingPicks();
        this.recalculateStats();
      }
    } catch (e) {
      console.warn('[SignalCollector] Failed to load previous storage:', e.message);
    }
  }

  saveToStorage() {
    try {
      const data = {
        config: this.config,
        pendingPicks: Array.from(this.pendingPicks.values()),
        settledPicks: this.settledPicks.slice(0, this.config.maxHistoryLimit),
        activityLogs: this.activityLogs.slice(0, 100),
        stats: this.stats,
        lastSaved: new Date().toISOString()
      };
      fs.writeFileSync(this.storageFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.warn('[SignalCollector] Failed to save storage:', e.message);
    }
  }

  recalculateStats() {
    const settled = this.settledPicks;
    let won = 0;
    let lost = 0;
    let voided = 0;
    let totalOdds = 0;
    let countedOdds = 0;

    for (const p of settled) {
      const st = (p.status || '').toLowerCase();
      if (st === 'won') won++;
      else if (st === 'lost') lost++;
      else if (st === 'void') voided++;

      if (p.implied_odd && typeof p.implied_odd === 'number') {
        totalOdds += p.implied_odd;
        countedOdds++;
      }
    }

    for (const p of this.pendingPicks.values()) {
      if (p.implied_odd && typeof p.implied_odd === 'number') {
        totalOdds += p.implied_odd;
        countedOdds++;
      }
    }

    const completed = won + lost;
    const winRate = completed > 0 ? parseFloat(((won / completed) * 100).toFixed(1)) : 0;
    const avgOdds = (countedOdds > 0) ? parseFloat((totalOdds / countedOdds).toFixed(2)) : 0;

    this.stats = {
      totalReceived: this.pendingPicks.size + settled.length,
      totalPending: this.pendingPicks.size,
      totalSettled: settled.length,
      wonCount: won,
      lostCount: lost,
      voidCount: voided,
      winRate,
      avgOdds
    };
  }

  updateConfig(newConfig = {}) {
    this.config = { ...this.config, ...newConfig };
    this.saveToStorage();
    this.log('info', `Configuration updated (Server: ${this.config.serverUrl})`);
    
    // If running, restart connection to apply changes
    if (this.state.connected || this.state.connecting) {
      this.start();
    }
  }

  async testConnection(targetUrl, targetApiKey) {
    const baseUrl = (targetUrl || this.config.serverUrl || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    const apiKey = targetApiKey || this.config.apiKey || 'vfl_live_key_2026';
    const startTime = Date.now();

    try {
      const healthUrl = `${baseUrl}/api/health`;
      const res = await fetch(healthUrl, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey
        },
        signal: AbortSignal.timeout(5000)
      });

      const latencyMs = Date.now() - startTime;
      if (!res.ok) {
        return {
          success: false,
          latencyMs,
          error: `HTTP ${res.status}: ${res.statusText}`
        };
      }

      let data = {};
      try {
        data = await res.json();
      } catch (pe) {
        // Ignored
      }

      return {
        success: true,
        latencyMs,
        serverData: data
      };
    } catch (e) {
      return {
        success: false,
        latencyMs: Date.now() - startTime,
        error: e.message
      };
    }
  }

  start() {
    this.isExplicitlyStopped = false;
    this.stopConnections();

    this.state.connecting = true;
    this.state.lastError = null;
    this.emit('state-changed', this.getState());

    this.log('info', `Starting Signal Collector connection to ${this.config.serverUrl}...`);

    // Try WebSocket connection first
    this.connectWebSocket();

    // Start background health & periodic check timer
    this.startPeriodicTasks();
  }

  stop() {
    this.isExplicitlyStopped = true;
    this.stopConnections();
    this.state.connected = false;
    this.state.connecting = false;
    this.state.transport = 'disconnected';
    this.log('info', 'Signal Collector service stopped by user.');
    this.emit('state-changed', this.getState());
  }

  stopConnections() {
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch (e) {
        // Ignored
      }
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  startPeriodicTasks() {
    // Check health, ping server, sync settled results, and purge finished matches every 15 seconds
    this.healthTimer = setInterval(() => {
      this.checkServerHealth();
      this.pollSettledPicks();
      const expired = this.cleanupStalePendingPicks();
      if (expired > 0) {
        this.saveToStorage();
        this.emit('signals-updated', this.getState());
      }
    }, 15000);

    // Run first check immediately
    this.checkServerHealth();
    this.pollSettledPicks();
    this.cleanupStalePendingPicks();
  }

  async checkServerHealth() {
    if (this.isExplicitlyStopped) return;
    const test = await this.testConnection(this.config.serverUrl, this.config.apiKey);
    if (test.success) {
      this.state.lastPingMs = test.latencyMs;
      this.state.serverHealth = test.serverData;
      this.state.lastSyncTime = new Date().toISOString();
      if (!this.state.connected && this.state.transport === 'disconnected') {
        // Server is reachable, attempt to reconnect or poll
        this.connectWebSocket();
      }
    } else {
      if (this.state.transport === 'polling') {
        this.state.lastError = test.error;
      }
    }
    this.emit('state-changed', this.getState());
  }

  connectWebSocket() {
    if (this.isExplicitlyStopped) return;

    if (!WebSocketImpl) {
      this.log('warn', 'No WebSocket client available in runtime; falling back to REST polling mode.');
      this.startPollingFallback();
      return;
    }

    try {
      const baseUrl = this.config.serverUrl.replace(/\/+$/, '');
      const wsUrlStr = baseUrl.replace(/^http/, 'ws') + `/ws?api_key=${encodeURIComponent(this.config.apiKey)}`;

      this.log('info', `Connecting WebSocket: ${baseUrl}/ws`);

      const ws = new WebSocketImpl(wsUrlStr);
      this.ws = ws;

      const connectionTimeout = setTimeout(() => {
        if (this.ws === ws && (!this.state.connected || ws.readyState !== 1)) {
          this.log('warn', 'WebSocket connection timed out, trying REST polling fallback...');
          try { ws.close(); } catch (e) {}
          this.startPollingFallback();
        }
      }, 7000);

      ws.onopen = () => {
        clearTimeout(connectionTimeout);
        this.state.connected = true;
        this.state.connecting = false;
        this.state.transport = 'websocket';
        this.state.lastError = null;
        this.reconnectDelay = 2000;
        this.log('success', `⚡ Real-Time WebSocket connected to Predictor Server (${baseUrl})`);
        this.emit('state-changed', this.getState());

        // Perform initial REST sync just in case
        this.pollPendingPicks();
      };

      ws.onmessage = (event) => {
        const rawData = typeof event.data === 'string' ? event.data : event.data.toString();
        this.handleServerMessage(rawData);
      };

      ws.onerror = (err) => {
        clearTimeout(connectionTimeout);
        const errMsg = (err && err.message) || 'WebSocket connection error';
        this.state.lastError = errMsg;
        if (!this.state.connected) {
          this.log('warn', `WebSocket connection failed: ${errMsg}. Activating REST polling fallback.`);
          this.startPollingFallback();
        }
      };

      ws.onclose = (event) => {
        clearTimeout(connectionTimeout);
        const wasConnected = this.state.connected;
        this.state.connected = false;
        this.ws = null;

        if (!this.isExplicitlyStopped) {
          if (wasConnected) {
            this.log('warn', `WebSocket disconnected (code: ${event.code || 'unknown'}). Reconnecting in ${this.reconnectDelay / 1000}s...`);
          }
          // Enable immediate polling while disconnected
          this.startPollingFallback();
          this.scheduleReconnect();
        } else {
          this.state.transport = 'disconnected';
          this.emit('state-changed', this.getState());
        }
      };
    } catch (e) {
      this.log('error', `Failed to construct WebSocket: ${e.message}`);
      this.startPollingFallback();
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.isExplicitlyStopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isExplicitlyStopped && (!this.state.connected || this.state.transport !== 'websocket')) {
        this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
        this.connectWebSocket();
      }
    }, this.reconnectDelay);
  }

  startPollingFallback() {
    if (this.pollTimer) return;
    this.state.transport = 'polling';
    this.emit('state-changed', this.getState());

    // Run first polling round immediately
    this.pollPendingPicks();
    this.pollSettledPicks();

    const intervalMs = Math.max(3000, (this.config.pollIntervalSec || 8) * 1000);
    this.pollTimer = setInterval(() => {
      if (this.isExplicitlyStopped) return;
      this.pollPendingPicks();
      this.pollSettledPicks();
    }, intervalMs);
  }

  async pollPendingPicks() {
    try {
      const baseUrl = this.config.serverUrl.replace(/\/+$/, '');
      const apiKey = encodeURIComponent(this.config.apiKey || 'vfl_live_key_2026');
      const url = `${baseUrl}/api/picks/pending?api_key=${apiKey}`;
      const res = await fetch(url, {
        headers: { 'x-api-key': this.config.apiKey },
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        const json = await res.json();
        let picks = json.data || json.pending_picks || (Array.isArray(json) ? json : []);
        if ((!picks || picks.length === 0) && json.signals && typeof json.signals === 'object') {
          picks = Object.values(json.signals).flat().filter(Boolean);
        }
        if (Array.isArray(picks) && picks.length > 0) {
          this.ingestIncomingPicks(picks, 'rest');
        }
        this.state.lastSyncTime = new Date().toISOString();
        this.emit('state-changed', this.getState());
      }
    } catch (e) {
      // If REST and WS both fail, try local SQLite fallback if configured
      if (this.config.dbPath) {
        this.pollLocalSqlite();
      }
    }
  }

  async pollSettledPicks() {
    try {
      const baseUrl = this.config.serverUrl.replace(/\/+$/, '');
      const apiKey = encodeURIComponent(this.config.apiKey || 'vfl_live_key_2026');
      const url = `${baseUrl}/api/picks/settled?api_key=${apiKey}&limit=100`;
      const res = await fetch(url, {
        headers: { 'x-api-key': this.config.apiKey },
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        const json = await res.json();
        const settled = json.data || json.settled_picks || (Array.isArray(json) ? json : []);
        if (Array.isArray(settled) && settled.length > 0) {
          this.ingestSettledPicks(settled, 'rest');
        }
      }
    } catch (e) {
      // Silently ignore or retry
    }
  }

  pollLocalSqlite() {
    try {
      const dbPath = this.config.dbPath;
      if (!dbPath || !fs.existsSync(dbPath)) return;

      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });

      // Read pending picks
      try {
        const pending = db.prepare(`
          SELECT * FROM ai_best_picks_history 
          WHERE status = 'pending'
          ORDER BY id DESC LIMIT 50
        `).all();
        if (pending && pending.length > 0) {
          this.ingestIncomingPicks(pending, 'sqlite');
        }
      } catch (e) {
        // Ignore missing table
      }

      // Read settled picks
      try {
        const settled = db.prepare(`
          SELECT * FROM ai_best_picks_history 
          WHERE status IN ('won', 'lost', 'void')
          ORDER BY id DESC LIMIT 50
        `).all();
        if (settled && settled.length > 0) {
          this.ingestSettledPicks(settled, 'sqlite');
        }
      } catch (e) {
        // Ignore
      }

      db.close();
    } catch (e) {
      // Ignore
    }
  }

  handleServerMessage(raw) {
    try {
      const payload = JSON.parse(raw);
      const msgType = payload.type;

      if (msgType === 'connected') {
        this.log('info', `Server handshake acknowledged. Pending picks: ${payload.pending_picks ? payload.pending_picks.length : 0}`);
        if (Array.isArray(payload.pending_picks)) {
          this.ingestIncomingPicks(payload.pending_picks, 'ws_init');
        }
      } else if (msgType === 'new_picks') {
        const picks = payload.data || [];
        this.log('signal', `⚡ Received ${picks.length} new betting signal(s) from Predictor!`);
        this.ingestIncomingPicks(picks, 'ws_push');
        this.emit('new-picks', picks);
      } else if (msgType === 'settled_picks') {
        const settled = payload.data || [];
        this.log('settled', `🏁 Received ${settled.length} settled pick result(s).`);
        this.ingestSettledPicks(settled, 'ws_push');
        this.emit('settled-picks', settled);
      }
    } catch (e) {
      this.log('warn', `Received non-JSON message: ${raw.slice(0, 100)}`);
    }
  }

  ingestIncomingPicks(picks, source = 'ws') {
    let newCount = 0;

    // First purge any existing pending picks that have passed kickoff + 3.5m
    this.cleanupStalePendingPicks();

    // Group by season and round to guarantee differentiation across 3 tiers
    const roundGroups = {};
    for (const rawPick of picks) {
      const p = this.normalizePick(rawPick);
      if (!p) continue;
      const rKey = `${p.season_name}_R${p.round_number}`;
      if (!roundGroups[rKey]) roundGroups[rKey] = [];
      roundGroups[rKey].push(p);
    }

    for (const rKey in roundGroups) {
      const group = roundGroups[rKey];
      // Keep the recorded strategy; sorting a round must never reassign it.
      for (const p of group) {
        // If match has already kicked off > 3.5m ago, treat as finished
        const isExpired = p.kickoff_timestamp && (Date.now() - p.kickoff_timestamp) > 210000;
        if (isExpired) {
          const alreadySettled = this.settledPicks.some(s => s.id === p.id);
          if (!alreadySettled) {
            this.settledPicks.unshift({
              ...p,
              status: p.status === 'pending' ? 'completed' : p.status,
              actual_score: p.actual_score || 'Completed'
            });
          }
          continue;
        }

        const key = p.id != null ? String(p.id) : `${p.season_name}_${p.round_number}_${p.pick_type}_${p.market}`;
        const existing = this.pendingPicks.get(key);
        if (!existing) {
          const alreadySettled = this.settledPicks.some(s => s.id === p.id && s.status !== 'pending');
          if (!alreadySettled) {
            this.pendingPicks.set(key, p);
            newCount++;
          }
        } else {
          Object.assign(existing, p);
        }
      }
    }

    if (picks.length > 0) {
      this.recalculateStats();
      this.saveToStorage();
      this.emit('signals-updated', this.getState());
    }
  }

  ingestSettledPicks(settledPicks, source = 'ws') {
    let changed = false;

    for (const rawSettled of settledPicks) {
      const s = this.normalizePick(rawSettled);
      if (!s || !s.status || s.status === 'pending') continue;

      const key = s.id != null ? String(s.id) : `${s.season_name}_${s.round_number}_${s.pick_type}_${s.market}`;

      // Remove from pending
      if (this.pendingPicks.has(key)) {
        this.pendingPicks.delete(key);
        changed = true;
      }

      // Add or update in settledPicks
      const existingIdx = this.settledPicks.findIndex(p => p.id === s.id || (p.season_name === s.season_name && p.round_number === s.round_number && p.market === s.market && p.home_team === s.home_team));

      if (existingIdx !== -1) {
        this.settledPicks[existingIdx] = { ...this.settledPicks[existingIdx], ...s };
        changed = true;
      } else {
        this.settledPicks.unshift(s);
        changed = true;
      }
    }

    if (this.settledPicks.length > this.config.maxHistoryLimit) {
      this.settledPicks = this.settledPicks.slice(0, this.config.maxHistoryLimit);
    }

    if (changed) {
      this.recalculateStats();
      this.saveToStorage();
      this.emit('signals-updated', this.getState());
    }
  }

  classifyPickType(pick) {
    const id = strategyId(pick);
    return ({ high_value: 'high_chance', ai_best: 'ai_best', goals: 'goals_strategy' })[id] || id;
  }

  normalizePick(pick) {
    if (!pick || typeof pick !== 'object') return null;

    let kickoffTimestamp = pick.kickoff_timestamp;
    if (!kickoffTimestamp && pick.match_time) {
      // Try to parse match_time HH:MM
      const [h, m] = pick.match_time.split(':').map(Number);
      if (!isNaN(h) && !isNaN(m)) {
        const d = new Date();
        d.setHours(h, m, 0, 0);
        kickoffTimestamp = d.getTime();
      }
    }

    pick = normalizeStrategy(pick);
    const assignedTier = this.classifyPickType(pick);
    const cleanedSeason = this.cleanSeasonName(pick.season_name);
    const isAiBest = strategyId(pick) === 'ai_best';

    return {
      ...pick,
      id: pick.id ?? Math.floor(Math.random() * 1000000),
      season_name: cleanedSeason,
      round_number: pick.round_number != null ? Number(pick.round_number) : 1,
      pick_type: assignedTier,
      server_pick_type: pick.server_pick_type || pick.pick_type || null,
      category: pick.category,
      category_label: pick.category_label,
      is_best_pick: isAiBest,
      sportybet_odd: pick.sportybet_odd || pick.implied_odd || null,
      home_team: pick.home_team || 'Home',
      away_team: pick.away_team || 'Away',
      market: pick.market || 'Over 1.5 Goals',
      probability: pick.probability != null ? parseFloat(pick.probability) : 75.0,
      implied_odd: pick.implied_odd != null ? parseFloat(pick.implied_odd) : 1.50,
      kickoff_timestamp: kickoffTimestamp || (Date.now() + 180000),
      match_time: pick.match_time || new Date(kickoffTimestamp || Date.now()).toTimeString().slice(0, 5),
      status: pick.status || 'pending',
      actual_score: pick.actual_score || null,
      collected_at: pick.collected_at || new Date().toISOString()
    };
  }

  clearHistory() {
    this.pendingPicks.clear();
    this.settledPicks = [];
    this.activityLogs = [];
    this.recalculateStats();
    this.saveToStorage();
    this.log('info', 'Signal history and cache cleared.');
    this.emit('signals-updated', this.getState());
    return { success: true };
  }

  exportSignals(format = 'json') {
    const all = {
      pending: Array.from(this.pendingPicks.values()),
      settled: this.settledPicks,
      stats: this.stats,
      exportedAt: new Date().toISOString()
    };

    if (format === 'csv') {
      const header = ['ID', 'Type', 'Season', 'Round', 'Match', 'Market', 'Prob %', 'Odds', 'Kickoff', 'Score', 'Status'].join(',');
      const rows = [...all.pending, ...all.settled].map(p => {
        return [
          p.id,
          p.pick_type,
          `"${p.season_name}"`,
          p.round_number,
          `"${p.home_team} vs ${p.away_team}"`,
          `"${p.market}"`,
          p.probability,
          p.implied_odd,
          `"${p.match_time || ''}"`,
          `"${p.actual_score || ''}"`,
          p.status
        ].join(',');
      });
      return { success: true, format: 'csv', data: [header, ...rows].join('\n') };
    }

    return { success: true, format: 'json', data: JSON.stringify(all, null, 2) };
  }

  getState() {
    return {
      config: { ...this.config },
      state: { ...this.state },
      pendingPicks: Array.from(this.pendingPicks.values()).sort((a, b) => a.kickoff_timestamp - b.kickoff_timestamp),
      settledPicks: this.settledPicks,
      activityLogs: this.activityLogs,
      stats: { ...this.stats }
    };
  }
}

// Export singleton instance
const signalCollector = new SignalCollector();

module.exports = {
  SignalCollector,
  signalCollector
};
