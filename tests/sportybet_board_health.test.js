const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SportyBetBoardHealth } = require('../utils/sportybet_board_health');

const board = (overrides = {}) => ({
  weekNumber: 27, remainingSec: 120, timerText: '02:00',
  fixtures: [{ homeCode: 'ARS', awayCode: 'CHE' }], ...overrides
});

test('recovers the reported Week 27 / 00:00 / zero fixtures freeze after 60s', () => {
  const health = new SportyBetBoardHealth();
  const frozen = board({ remainingSec: 0, timerText: '00:00', fixtures: [] });
  assert.equal(health.observe(frozen, 0).shouldRecover, false);
  assert.equal(health.observe(frozen, 59999).shouldRecover, false);
  const result = health.observe(frozen, 60000);
  assert.equal(result.shouldRecover, true);
  assert.equal(result.ready, false);
  assert.equal(result.status, 'stalled');
  assert.match(result.reason, /Week 27 countdown frozen/);
});

test('tolerates a short kickoff transition and resumes on the next week', () => {
  const health = new SportyBetBoardHealth();
  health.observe(board({ remainingSec: 4 }), 0);
  const transition = health.observe(board({ remainingSec: 0, fixtures: [] }), 5000);
  assert.equal(transition.shouldRecover, false);
  assert.equal(transition.ready, false);
  assert.equal(health.observe(board({ weekNumber: 28, remainingSec: 179 }), 15000).ready, true);
});

test('a progressing board with no matching signals needs no recovery', () => {
  const health = new SportyBetBoardHealth();
  for (let time = 0; time <= 240000; time += 5000) {
    const result = health.observe(board({ remainingSec: 180 - (time / 1000) % 180 }), time);
    assert.equal(result.ready, true);
    assert.equal(result.shouldRecover, false);
  }
});

test('detects a frozen positive timer even with fixtures still rendered', () => {
  const health = new SportyBetBoardHealth();
  health.observe(board(), 0);
  const result = health.observe(board(), 60000);
  assert.equal(result.shouldRecover, true);
  assert.equal(result.ready, false);
});

test('changing fixtures cannot mask a frozen clock', () => {
  const health = new SportyBetBoardHealth();
  health.observe(board(), 0);
  assert.equal(health.observe(board({ fixtures: [{ homeCode: 'LIV', awayCode: 'EVE' }] }), 60000).shouldRecover, true);
});

test('recovers a persistently empty board even while its countdown progresses', () => {
  const health = new SportyBetBoardHealth();
  for (let time = 0; time < 90000; time += 10000) {
    assert.equal(health.observe(board({ remainingSec: 180 - time / 1000, fixtures: [] }), time).shouldRecover, false);
  }
  const result = health.observe(board({ remainingSec: 90, fixtures: [] }), 90000);
  assert.equal(result.shouldRecover, true);
  assert.match(result.reason, /No upcoming fixtures/);
});

test('unknown clocks, weeks and extraction failures block betting and eventually recover', () => {
  for (const overrides of [{ remainingSec: null }, { weekNumber: null }, { extractionError: 'detached' }]) {
    const health = new SportyBetBoardHealth();
    assert.equal(health.observe(board(overrides), 0).ready, false);
    assert.equal(health.observe(board(overrides), 60000).shouldRecover, true);
  }
});

test('cooldown survives resets and allows a later retry after failed recovery', () => {
  const health = new SportyBetBoardHealth();
  health.observe(board(), 0);
  assert.equal(health.observe(board(), 60000).shouldRecover, true);
  health.markRecoveryAttempt(60000);
  health.reset(65000);
  health.observe(board(), 65000);
  const cooling = health.observe(board(), 125000);
  assert.equal(cooling.ready, false);
  assert.equal(cooling.shouldRecover, false);
  assert.equal(health.observe(board(), 180000).shouldRecover, true);
  assert.equal(health.observe(board({ weekNumber: 28, remainingSec: 175 }), 185000).ready, true);
});

// Evaluate only these helpers: importing the executable would launch a browser and place real bets.
const source = fs.readFileSync(path.join(__dirname, '..', 'sportybet_executor.js'), 'utf8');
const extractSource = source.slice(source.indexOf('async function extractBoardState('), source.indexOf('async function recoverStalledBoard('));
const recoverySource = source.slice(source.indexOf('async function recoverStalledBoard('), source.indexOf('// ─── Market Navigation'));

test('extraction failure returns an unknown timer instead of inventing 60 betting seconds', async () => {
  const extract = vm.runInNewContext(`${extractSource}\nextractBoardState`);
  const result = await extract({ evaluate: async () => { throw new Error('frame detached'); } });
  assert.equal(result.remainingSec, null);
  assert.equal(result.weekNumber, null);
  assert.equal(result.extractionError, 'frame detached');
});

test('missing countdown text stays unknown even if fixture extraction succeeds', async () => {
  const extract = vm.runInNewContext(`${extractSource}\nextractBoardState`, {
    document: { querySelectorAll: () => [] }
  });
  const result = await extract({ evaluate: async fn => fn() });
  assert.equal(result.remainingSec, null);
  assert.equal(result.timerText, '');
});

function recoveryHarness({ loggedIn = true, loginSucceeds = true, reloadFails = false } = {}) {
  const calls = [];
  const statuses = [];
  const frame = {};
  const recover = vm.runInNewContext(`${recoverySource}\nrecoverStalledBoard`, {
    logger: { warn() {} }, publishLiveStatus: status => statuses.push(status),
    path, VISION_DIR: 'unused', delay: async () => {},
    evaluateSportyBetAuth: async () => ({ isLoggedIn: loggedIn, visiblePhone: !loggedIn }),
    checkAndEnsureAuth: async () => { calls.push('login'); return loginSucceeds; },
    navigateToEnglandLeague: async () => { calls.push('navigate'); return frame; }
  });
  const page = {
    screenshot: async () => { calls.push('screenshot'); },
    reload: async () => { calls.push('reload'); if (reloadFails) throw new Error('offline'); }
  };
  return { recover, page, calls, statuses, frame };
}

test('recovery reloads the page and reacquires England in a fresh frame', async () => {
  const h = recoveryHarness();
  assert.equal(await h.recover(h.page, 'frozen'), h.frame);
  assert.deepEqual(h.calls, ['screenshot', 'reload', 'navigate']);
  assert.equal(h.statuses[0].networkStatus, 'reconnecting');
});

test('recovery restores authentication before selecting England', async () => {
  const h = recoveryHarness({ loggedIn: false });
  assert.equal(await h.recover(h.page, 'frozen'), h.frame);
  assert.deepEqual(h.calls, ['screenshot', 'reload', 'login', 'navigate']);
});

test('failed login or reload leaves the board degraded for a later retry', async () => {
  for (const options of [{ loggedIn: false, loginSucceeds: false }, { reloadFails: true }]) {
    const h = recoveryHarness(options);
    assert.equal(await h.recover(h.page, 'frozen'), null);
    assert.equal(h.calls.includes('navigate'), false);
    assert.equal(h.statuses.at(-1).networkStatus, 'degraded');
  }
});
