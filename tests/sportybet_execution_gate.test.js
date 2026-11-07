const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseBooleanSetting, resolveExecutorStartOptions } = require('../utils/executor_settings');
const { SportyBetBoardHealth } = require('../utils/sportybet_board_health');

const source = fs.readFileSync(path.join(__dirname, '../sportybet_executor.js'), 'utf8');
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

function settingsHarness({ savedAutoBet = false, launchAutoBet = true } = {}) {
  const updates = [];
  const logs = [];
  const saved = { sportybetExecutor: { autoBet: savedAutoBet } };
  const context = {
    path, __dirname: path.join(__dirname, '..'), parseBooleanSetting,
    fs: { existsSync: () => true, readFileSync: () => JSON.stringify(saved) },
    autoBet: launchAutoBet, lastConfiguredAutoBet: parseBooleanSetting(savedAutoBet, true),
    placementPersistenceError: null, selectedStrategy: 'ai_best_pick', stakeMode: 'fixed',
    stakeAmount: 10, currentStake: 10, minOdds: 0, maxOdds: 0, minConfidence: 0,
    teamSearch: '', selectedSignalTypes: ['all'], selectedTiers: ['safest'],
    calculateCurrentStake: () => ({ stake: 10 }),
    logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    publishLiveStatus: update => updates.push(update)
  };
  const reload = vm.runInNewContext(slice('function reloadDynamicConfig()', 'const profileId =') + '\nreloadDynamicConfig', context);
  return { reload, context, saved, updates, logs };
}

test('an unchanged saved OFF cannot silently override explicit --auto-bet=true on first poll', () => {
  const h = settingsHarness();
  for (let i = 0; i < 20; i++) h.reload();
  assert.equal(h.context.autoBet, true);
  h.saved.sportybetExecutor.minOdds = 2; // An unrelated save must also preserve the launch choice.
  h.reload();
  assert.equal(h.context.autoBet, true);
});

test('explicit manual launch stays OFF despite unchanged saved ON', () => {
  const h = settingsHarness({ savedAutoBet: true, launchAutoBet: false });
  h.reload();
  assert.equal(h.context.autoBet, false);
});

test('real live toggle changes apply both ways and publish the actual active flag', () => {
  const h = settingsHarness({ savedAutoBet: true });
  h.saved.sportybetExecutor.autoBet = false;
  h.reload();
  assert.equal(h.context.autoBet, false);
  assert.equal(h.updates.at(-1).autoBetActive, false);
  h.saved.sportybetExecutor.autoBet = 'true';
  h.reload();
  assert.equal(h.context.autoBet, true);
  assert.equal(h.updates.at(-1).autoBetActive, true);
  h.saved.sportybetExecutor.autoBet = 'false';
  h.reload();
  assert.equal(h.context.autoBet, false);
});

test('hot reload cannot re-enable uncertain placement or database failure pauses', () => {
  const h = settingsHarness();
  h.context.placementPersistenceError = 'Accepted ticket could not be persisted';
  h.saved.sportybetExecutor.autoBet = true;
  h.reload();
  assert.equal(h.context.autoBet, false);
  h.saved.sportybetExecutor.autoBet = false;
  h.reload();
  h.saved.sportybetExecutor.autoBet = true;
  h.reload();
  assert.equal(h.context.autoBet, false);
});

test('malformed settings keep current mode and report a reload failure', () => {
  const h = settingsHarness();
  h.context.fs.readFileSync = () => '{';
  h.reload();
  assert.equal(h.context.autoBet, true);
  assert.match(h.logs.at(-1)[1], /reload failed/);
});

test('launch resolves omitted settings once for both saved state and process arguments', () => {
  for (const saved of [true, false, 'true', 'false']) {
    const settings = { sportybetExecutor: { autoBet: saved, stakeAmount: 25 } };
    const options = resolveExecutorStartOptions(settings, { platform: 'sportybet' });
    assert.equal(options.autoBet, parseBooleanSetting(saved));
    assert.equal(options.stakeAmount, 25);
    assert.equal(resolveExecutorStartOptions(settings, { autoBet: false }).autoBet, false);
    assert.equal(resolveExecutorStartOptions(settings, { autoBet: true }).autoBet, true);
    assert.equal(resolveExecutorStartOptions(settings, { autoBet: undefined }).autoBet, parseBooleanSetting(saved));
  }
  assert.equal(resolveExecutorStartOptions({}).autoBet, true);
  assert.equal(resolveExecutorStartOptions({}, { platform: '1xbet' }).autoBet, false);
  assert.equal(resolveExecutorStartOptions({ betExecutorPlatform: '1xbet', betExecutor: { autoBet: true } }).autoBet, true);
});

function loopHarness({ enabled = true, seconds = [109], pending = null, paused = null, healthReady = true } = {}) {
  const h = settingsHarness({ savedAutoBet: false, launchAutoBet: enabled });
  const logs = [];
  const statuses = [];
  const placements = [];
  let cycle = 0;
  const board = () => ({ weekNumber: 21, remainingSec: seconds[cycle], timerText: '01:49', fixtures: [{ homeCode: 'ARS', awayCode: 'CHE' }] });
  const frame = { isDetached: () => false };
  const page = { browser: () => ({ on() {} }) };
  Object.assign(h.context, {
    isShuttingDown: false, placementPersistenceError: paused,
    lastSeenBoardWeek: null, lastPlacedWeek: null, placedRoundTeams: new Set(),
    placedPickIds: new Set(), stakeMode: pending ? 'martingale_1_5' : 'fixed',
    config: { connect: async () => page }, headless: false, targetProfileDir: 'unused',
    checkAndEnsureAuth: async () => true, navigateToEnglandLeague: async () => frame,
    db: { getRecentBets: () => [], getBetStats: () => ({}) },
    signalCollector: {
      pendingPicks: new Map([['123', { id: 123, home_team: 'Arsenal', away_team: 'Chelsea' }]]),
      pollPendingPicks: async () => {}, cleanupStalePendingPicks() {}, saveToStorage() {}
    },
    syncSettledSignalsFromCollector: async () => {}, syncSettledTicketsFromFrame: async () => {},
    reconcilePendingSubmission: async () => {},
    switchToMyBetsTab: async () => true, getUnsettledActiveBet: () => pending,
    evaluateSportyBetAuth: async () => ({ isLoggedIn: true }), readSportyBetBalance: async () => {},
    extractBoardState: async () => board(),
    selectAiBestSignalsForBoard: () => [{ id: 123, home_team: 'Arsenal', away_team: 'Chelsea', market: 'Over 2.5' }],
    SportyBetBoardHealth: healthReady ? SportyBetBoardHealth : class { observe() { return { ready: false, reason: 'No fixtures' }; } },
    matchTeams: () => true,
    locateAndClickOddsButton: async () => { placements.push(cycle); return { found: false }; },
    logger: { info: (_tag, msg) => logs.push(msg), warn: (_tag, msg) => logs.push(msg), error: (_tag, msg) => { throw new Error(msg); } },
    publishLiveStatus: update => statuses.push({ ...update, actualAutoBet: h.context.autoBet }),
    performHumanIdleGesture: async () => {}, delay: async () => {},
    randomDelay: async () => { cycle++; if (cycle >= seconds.length) h.context.isShuttingDown = true; }
  });
  h.context.reloadDynamicConfig = h.reload;
  const run = vm.runInNewContext(
    slice('function getPlacementGate(', "process.on('SIGINT'") + '\nstartSportyBetExecutor', h.context
  );
  return { ...h, run, logs, statuses, placements };
}

test('reported countdown with one match and disabled Auto-Bet gives a specific reason every cycle', async () => {
  const h = loopHarness({ enabled: false, seconds: [109, 103, 97, 91, 86, 79, 73, 67, 61, 56, 49, 43, 37, 30, 24, 19, 13] });
  await h.run();
  assert.equal(h.placements.length, 0);
  const snapshots = h.statuses.filter(s => s.placementStatus);
  assert.equal(snapshots.length, 17);
  assert.ok(snapshots.every(s => s.placementStatus === 'auto_bet_disabled' && /Auto-Bet is OFF/.test(s.gateNotice)));
  const boardLogs = h.logs.filter(s => s.includes('Matching Unstaked AI Signals: 1'));
  assert.equal(boardLogs.length, 17);
  assert.ok(boardLogs.every(s => s.includes('AutoBet: OFF | Placement: auto_bet_disabled')));
});

test('explicit enabled launch reaches odds selection despite stale saved OFF', async () => {
  const h = loopHarness();
  await h.run();
  assert.equal(h.placements.length, 2); // One selection attempt plus the existing selection retry.
  assert.ok(h.logs.some(s => s.includes('Executing AI Best Signal #123')));
  assert.ok(h.statuses.some(s => s.placementStatus === 'ready' && s.actualAutoBet));
});

test('settlement, pause, board and kickoff guards still block execution and explain why', async () => {
  for (const [options, expected] of [
    [{ pending: { ticket_id: '1280063081', home_team: 'Arsenal', away_team: 'Chelsea' } }, 'awaiting_settlement'],
    [{ paused: 'Confirmation uncertain' }, 'placement_paused'],
    [{ healthReady: false }, 'board_unavailable'],
    [{ seconds: [15, 13] }, 'kickoff_guard']
  ]) {
    const h = loopHarness(options);
    await h.run();
    assert.equal(h.placements.length, 0);
    const status = h.statuses.find(s => s.placementStatus);
    assert.equal(status.placementStatus, expected);
    assert.ok(status.gateNotice);
  }
});

test('status publisher always derives Auto-Bet from execution state, including stale update fields', () => {
  const context = {
    fs: { existsSync: () => true, writeFileSync() {} }, path, __dirname,
    STATUS_FILE: 'unused', liveStatus: { autoBetActive: true, currentBalance: null },
    autoBet: false, placementPersistenceError: null, sessionStartTime: Date.now()
  };
  const publish = vm.runInNewContext(slice('function publishLiveStatus(', '// ─── 100% Physical Hardware') + '\npublishLiveStatus', context);
  publish({ autoBetActive: true });
  assert.equal(context.liveStatus.autoBetActive, false);
  context.autoBet = true;
  publish();
  assert.equal(context.liveStatus.autoBetActive, true);
  context.placementPersistenceError = 'Reconcile ticket';
  publish({ gateNotice: null });
  assert.equal(context.liveStatus.autoBetActive, false);
  assert.equal(context.liveStatus.gateNotice, 'Reconcile ticket');
});

test('dashboard autosave waits for asynchronous hydration before saving Auto-Bet and stake', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../dashboard/src/renderer/src/App.jsx'), 'utf8');
  const fetchSource = app.slice(app.indexOf('  const fetchBetExecutorConfig ='), app.indexOf('  const handleSaveExecutorConfig ='));
  const effectStart = app.indexOf('  // Auto-persist strategy presets');
  const firstEffect = app.indexOf('\n  useEffect(', effectStart);
  const effectSource = app.slice(effectStart, app.indexOf('\n  useEffect(', firstEffect + 1));
  for (const fallback of [false, true]) {
    let finishProfiles;
    const profileRead = new Promise(resolve => { finishProfiles = resolve; });
    const scheduled = [];
    const saved = [];
    const effects = [];
    const conf = { platform: 'sportybet', autoBet: true, stakeAmount: 25, sportybet: { stakeAmount: 25 } };
    const context = {
      console, executorConfigLoaded: false, executorPlatform: 'sportybet', executorAutoBet: false,
      executorStakeAmount: 60, sportybetStakeAmount: 10, executorStakePercentage: 2,
      executorStopLoss: 0, executorStopLossEnabled: false, executorTakeProfit: 0, executorTakeProfitEnabled: false,
      executorStakeMode: 'fixed', executorStartingBankroll: 1000, executorStakingScaling: 'uncapped',
      executorSelectedTiers: ['safest'], executorSelectedSignalTypes: ['all'], executorSelectedStrategy: 'all',
      executorMinOdds: '', executorMaxOdds: '', executorMinConfidence: 'all', executorTeamSearch: '',
      normalizeTiers: x => x, useEffect: fn => effects.push(fn),
      setTimeout: fn => { scheduled.push(fn); return scheduled.length; }, clearTimeout() {},
      window: { api: {
        getProfiles: () => profileRead,
        getBetExecutorConfig: async () => fallback ? null : conf,
        getBotSettings: async () => ({ betExecutorPlatform: 'sportybet', sportybetExecutor: conf, betExecutor: { autoBet: false, stakeAmount: 60 } }),
        saveBetExecutorConfig: async config => saved.push(config)
      } }
    };
    for (const [, setter] of fetchSource.matchAll(/\b(set\w+)\(/g)) {
      const variable = setter[3].toLowerCase() + setter.slice(4);
      context[setter] = value => { context[variable] = value; };
    }
    const fetch = vm.runInNewContext(fetchSource + '\nfetchBetExecutorConfig', context);
    vm.runInNewContext(effectSource, context);
    const autosave = effects[0];
    const loading = fetch();
    autosave(); // Profiles/settings are still loading with initial defaults.
    assert.equal(scheduled.length, 0);
    finishProfiles([]);
    await loading;
    assert.equal(context.executorConfigLoaded, true);
    assert.equal(context.executorAutoBet, true);
    autosave();
    assert.equal(scheduled.length, 1);
    await scheduled[0]();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].autoBet, true);
    assert.equal(saved[0].stakeAmount, 25);
  }
});
