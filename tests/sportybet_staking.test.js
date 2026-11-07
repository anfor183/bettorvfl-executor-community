const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const { parseMyBetsText, confirmSubmission } = require('../utils/sportybet_confirmation');

const dbSource = fs.readFileSync(path.join(__dirname, '../utils/db.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../sportybet_executor.js'), 'utf8');
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

// Run the production helpers against SQLite in memory; never import the browser executable.
function database(t) {
  const sqlite = new Database(':memory:');
  t.after(() => sqlite.close());
  const module = { exports: {} };
  vm.runInNewContext(dbSource + '\nmodule.exports.initTables = initTables;', {
    require: name => name === 'better-sqlite3' ? function () { return sqlite; }
      : name === 'fs' ? { existsSync: () => true, writeFileSync() {} } : require(name),
    __dirname: path.join(__dirname, '../utils'), module, console
  });
  return { api: module.exports, sqlite };
}

const fixture = (ticket, overrides = {}) => ({
  ticket_id: ticket, signal_id: String(Number(ticket) - 1280000000),
  season_name: 'England', round: '7', week: '7', home_team: 'Sunderland', away_team: 'Hull',
  market: 'Over 3.5 Goals', selection: 'Over 3.5 Goals', odds: 3.31, stake: 10,
  ...overrides
});

function staking(api, options = {}) {
  const context = {
    db: api, stakeAmount: 10, defaultStake: 10, stakeMode: 'martingale_1_5',
    stakingScaling: 'uncapped', stakePercentage: 2, currentBalance: 1000, startingBankroll: 15000,
    settledTicketTracker: new Map(), sessionStats: { wonCount: 0, lostCount: 0 },
    liveStatus: { recentTickets: [] }, logger: { info() {} }, publishLiveStatus() {},
    document: { body: { innerText: '' } }, parseMyBetsText, ...options
  };
  const helpers = [
    slice('function getUnsettledActiveBet()', '// ─── Filter & Rank Signals'),
    slice('function getConsecutiveLossStreak()', 'async function syncSettledTicketsFromFrame('),
    slice('async function readMyBetsTickets(', '// ─── Verify Pick Presence'),
    slice('async function syncSettledTicketsFromFrame(', 'async function syncSettledSignalsFromCollector(')
  ];
  const functions = vm.runInNewContext(helpers.join('\n') + '\n({ calculateCurrentStake, getConsecutiveLossStreak, getUnsettledActiveBet, readMyBetsTickets, syncSettledTicketsFromFrame })', context);
  return { ...functions, context };
}

test('migrates legacy fixture uniqueness without losing bets, balances, indexes, or IDs', t => {
  const { api, sqlite } = database(t);
  api.initTables(sqlite);
  const schema = sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='bets'").get().sql;
  sqlite.exec('DROP TABLE bets');
  sqlite.exec(schema.replace(/\)\s*$/, ', UNIQUE(round, home_team, away_team, market, selection))'));
  sqlite.exec("INSERT INTO bets (id,ticket_id,round,home_team,away_team,market,selection,stake,status) VALUES (386,'1278837941','7','Sunderland','Hull','Over 3.5 Goals','Over 3.5 Goals',15,'LOST')");
  sqlite.exec("CREATE INDEX custom_bets_index ON bets(signal_id); INSERT INTO balance_history(balance) VALUES (1000); UPDATE sqlite_sequence SET seq=593 WHERE name='bets'");
  api.initTables(sqlite);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM bets').get().n, 1);
  assert.equal(sqlite.prepare('SELECT balance FROM balance_history').get().balance, 1000);
  assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='custom_bets_index'").get());
  const id = api.recordPlacedBet(fixture('1280063081', { stake: 15 }));
  assert.equal(id, 594);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM bets').get().n, 2);
  api.initTables(sqlite); // Migration is idempotent.
  assert.equal(sqlite.prepare('SELECT count(*) n FROM bets').get().n, 2);
  assert.equal(sqlite.pragma('integrity_check', { simple: true }), 'ok');
});

test('records repeated fixtures in later seasons and records each ticket only once', t => {
  const { api } = database(t);
  const a = api.recordPlacedBet(fixture('1280063081', { stake: 15 }));
  const b = api.recordPlacedBet(fixture('1280073179', { stake: 23 }));
  assert.notEqual(a, b);
  assert.equal(api.recordPlacedBet(fixture('1280073179', { stake: 23 })), b);
  assert.equal(api.getRecentBets().length, 2);
});

test('1.5x multiplies each actual stake, rounds to bookmaker increments, and resets after a win', t => {
  const { api } = database(t);
  const h = staking(api);
  const amounts = [];
  for (let i = 0; i < 6; i++) {
    const stake = h.calculateCurrentStake().stake;
    amounts.push(stake);
    const ticket = String(1280100000 + i);
    api.recordPlacedBet(fixture(ticket, { stake }));
    assert.equal(h.getUnsettledActiveBet().ticket_id, ticket);
    api.updateBetSettlement(ticket, 'LOST', -stake);
  }
  assert.deepEqual(amounts, [10, 15, 25, 40, 60, 90]);
  api.updateBetSettlement('1280100005', 'WON', 160);
  assert.equal(h.calculateCurrentStake().stake, 10);
  assert.equal(h.getUnsettledActiveBet(), null);
});

test('the screenshot losses cannot leave the next stake stuck at 15', t => {
  const { api } = database(t);
  for (const [ticket, stake] of [['1280056019', 10], ['1280063081', 15], ['1280073179', 15]]) {
    api.recordPlacedBet(fixture(ticket, { stake }));
    api.updateBetSettlement(ticket, 'LOST', -stake);
  }
  const h = staking(api);
  assert.equal(h.getConsecutiveLossStreak().count, 3);
  assert.equal(h.calculateCurrentStake().stake, 25);
  // Reconstruct state on restart from persisted stakes, not session counters.
  assert.equal(staking(api).calculateCurrentStake().stake, 25);
});

test('pending bets block progression even after ten minutes or missing timestamps', t => {
  const { api, sqlite } = database(t);
  api.recordPlacedBet(fixture('1280082624', { stake: 15 }));
  for (const time of ['2026-01-01 00:00:00', null]) {
    sqlite.prepare('UPDATE bets SET placed_at=?').run(time);
    assert.equal(staking(api).getUnsettledActiveBet().ticket_id, '1280082624');
  }
});

test('step cap starts another progression after resetting', t => {
  const { api } = database(t);
  const h = staking(api, { stakingScaling: '3' });
  const amounts = [];
  for (let i = 0; i < 5; i++) {
    const stake = h.calculateCurrentStake().stake;
    amounts.push(stake);
    const ticket = String(1280200000 + i);
    api.recordPlacedBet(fixture(ticket, { stake }));
    api.updateBetSettlement(ticket, 'LOST', -stake);
  }
  assert.deepEqual(amounts, [10, 15, 25, 10, 15]);
});

test('historical duplicate ticket rows count as one loss; void tickets preserve progression', t => {
  const { api, sqlite } = database(t);
  api.recordPlacedBet(fixture('1280063081', { stake: 15 }));
  api.updateBetSettlement('1280063081', 'LOST', -15);
  sqlite.exec("INSERT INTO bets(ticket_id,stake,status) VALUES ('1280063081',15,'LOST')");
  api.recordPlacedBet(fixture('1280073179', { status: 'VOID' }));
  const h = staking(api);
  assert.equal(h.getConsecutiveLossStreak().count, 1);
  assert.equal(h.getConsecutiveLossStreak().accumulatedLoss, 15);
  assert.equal(h.calculateCurrentStake().stake, 25);
});

test('recovered historical losses sort by placement time before a newer win', t => {
  const { api, sqlite } = database(t);
  api.recordPlacedBet(fixture('1280082624', { status: 'WON' }));
  api.recordPlacedBet(fixture('1280063081', { status: 'LOST', stake: 15 }));
  sqlite.exec("UPDATE bets SET placed_at=CASE ticket_id WHEN '1280082624' THEN '2026-11-06 10:43:27' ELSE '2026-11-06 10:37:21' END");
  assert.equal(staking(api).calculateCurrentStake().stake, 10);
});

test('production ticket parser handles screenshot cards, fixture IDs, currency, and hidden status labels', async t => {
  const { api } = database(t);
  const h = staking(api);
  h.context.document.body.innerText = `TICKET: #1280082624\n#4013611 SUN - LEE\nWeek 9\nStatus: OPEN\nSingle (x1)\nTotal stake: ₦15\nWon: ₦0\nTICKET: #1280073179\n#4013603 CRY - FUL\nWeek 8\nStatus:\nLOST\nSingle (x1)\nTotal stake: ₦15\nWon: ₦0\nTICKET: #1280063081\n#4013594 SUN - HLL\nWeek 7\nLOST\nStatus: Single (x1)\nTotal stake: #15\nWon: #0`;
  const frame = { isDetached: () => false, evaluate: async fn => fn() };
  const tickets = await h.readMyBetsTickets(frame);
  assert.equal(tickets.length, 3);
  assert.deepEqual(Array.from(tickets, t => t.status), ['OPEN', 'LOST', 'LOST']);
  assert.equal(tickets[2].matchCode, 'SUN-HLL');
});

test('bookmaker settlement advances persisted progression once with correct profit/loss', async t => {
  const { api } = database(t);
  api.recordPlacedBet(fixture('1280063081', { stake: 15 }));
  const h = staking(api);
  h.context.document.body.innerText = 'TICKET: #1280063081\nStatus: LOST\nTotal stake: ₦15\nWon: ₦0';
  const frame = { isDetached: () => false, evaluate: async fn => fn() };
  await h.syncSettledTicketsFromFrame(frame);
  await h.syncSettledTicketsFromFrame(frame);
  assert.equal(h.context.sessionStats.lostCount, 1);
  assert.equal(api.getRecentBets()[0].profit_loss, -15);
  assert.equal(h.getUnsettledActiveBet(), null);
  assert.equal(h.calculateCurrentStake().stake, 25);
});

test('confirmation rejects another match, week, or stake instead of falling back to any open ticket', async () => {
  const confirmSource = slice('async function confirmBetPlacementInMyBets(', '// ─── Locate & Physically Click Target Odds Button');
  for (const overrides of [{ matchCode: 'CRY-FUL' }, { week: 8 }, { stake: 14 }, { stake: null }, {}]) {
    let tick = 0;
    const ticket = { ticketId: '1280063081', status: 'OPEN', week: 7, stake: 15, matchCode: 'SUN-HLL', marketText: 'Over 3.5 Goals', ...overrides };
    const submission = { pick: { home_team: 'Sunderland', away_team: 'Hull', round_number: 7 }, stake: 15, baselineIds: [] };
    const confirm = vm.runInNewContext(confirmSource + '\nconfirmBetPlacementInMyBets', {
      Date: { now: () => tick++ }, delay: async () => {},
      readMyBetsTickets: async () => [ticket], switchToMyBetsTab: async () => true,
      matchTeams: (team, code) => ({ Sunderland: 'SUN', Hull: 'HLL' })[team] === code,
      pendingSubmission: submission,
      createConfirmationIO: async () => ({ openMyBets: async () => {}, readMyBets: async () => [ticket], readHistory: async () => [], readRejection: async () => null,
        matchTeams: (team, code) => ({ Sunderland: 'SUN', Hull: 'HLL' })[team] === code, matchesMarket: () => true }),
      confirmSubmission: (s, io, options) => confirmSubmission(s, io, { ...options, now: () => tick++, sleep: async () => {} })
    });
    const frame = { isDetached: () => false, evaluate: async () => null };
    const result = await confirm(frame, {}, { home_team: 'Sunderland', away_team: 'Hull', round_number: 7 }, 15, 5);
    assert.equal(result.confirmed, Object.keys(overrides).length === 0);
  }
});

function placementHarness({ enteredStake = 25, confirmed = false, databaseFails = false, slipOk = true } = {}) {
  const clicks = [];
  const keys = [];
  const records = [];
  const context = {
    path, VISION_DIR: 'unused', currencySymbol: 'NGN ', autoBet: true, placementPersistenceError: null,
    liveStatus: { currentWeek: 7, recentTickets: [] }, sessionStats: { placedCount: 0, totalStaked: 0, wonCount: 0, lostCount: 0 },
    logger: { info() {}, warn() {}, error() {} }, publishLiveStatus() {},
    scrollPageToTop: async () => {}, switchToBetslipTab: async () => true,
    verifyBetslipContainsPick: async () => ({ ok: slipOk, fixtureId: '4013611', reason: 'betslip_fixture_mismatch' }),
    pendingSubmission: null, requestedAutoBet: true, randomUUID: () => 'test-submission',
    submissionJournal: { save: entry => ({ ...entry }) },
    readMyBetsTickets: async () => [], extractBoardState: async () => ({ weekNumber: 7, remainingSec: 120 }),
    createConfirmationIO: async () => ({ readRejection: async () => null }),
    placedPickIds: new Set(), placedRoundTeams: new Set(), lastPlacedWeek: null, settledTicketTracker: new Map(),
    confirmedSessionTickets: new Set(),
    getFrameOffset: async () => ({ fOffsetX: 0, fOffsetY: 0 }),
    hardwareClickAt: async (_page, x, y) => clicks.push([x, y]),
    randomDelay: async () => {}, delay: async () => {}, readSportyBetBalance: async () => {},
    confirmBetPlacementInMyBets: async () => ({ confirmed, ticketId: '1280063081', stake: 25 }),
    db: { getRecentBets: () => records, recordPlacedBet: record => { records.push(record); return databaseFails ? null : 1; } }
  };
  const recordHelpers = slice('function pauseSubmission(', 'async function reconcilePendingSubmission(');
  const submit = vm.runInNewContext(recordHelpers + slice('async function submitBetslipPlacement(', '// ─── Exact Strategy Selection') + '\nsubmitBetslipPlacement', context);
  const responses = [
    { inputX: 1, inputY: 2, blurX: 3, blurY: 4 }, enteredStake,
    { found: true, disabled: false, x: 5, y: 6, bsText: '' }
  ];
  const frame = { evaluate: async () => responses.shift(), evaluateHandle: async () => null };
  const page = {
    screenshot: async () => {},
    keyboard: { press: async key => keys.push(key), down: async () => {}, up: async () => {}, type: async () => {} }
  };
  return { submit: () => submit(frame, page, 25, { id: 17202, round_number: 7, home_team: 'Sunderland', away_team: 'Hull', market: 'Over 3.5 Goals' }, { odd: 3.31 }), context, clicks, keys, records };
}

test('unknown confirmation pauses placement instead of allowing a duplicate retry', async () => {
  const h = placementHarness();
  assert.equal((await h.submit()).reason, 'placement_uncertain');
  assert.equal(h.context.autoBet, false);
  assert.match(h.context.placementPersistenceError, /could not be confirmed/);
  assert.equal(h.clicks.length, 3); // Input, blur, one submission.
  assert.ok(!h.keys.includes('Enter')); // Enter must not submit a second wager.
  assert.equal(h.records.length, 0);
  const clicks = h.clicks.length;
  assert.equal((await h.submit()).reason, 'reconciliation_pending');
  assert.equal(h.clicks.length, clicks);
});

test('stake readback prevents submitting a value changed by the bookmaker', async () => {
  const h = placementHarness({ enteredStake: 30 });
  assert.equal((await h.submit()).reason, 'stake_input_mismatch');
  assert.equal(h.clicks.length, 2); // No Place Bet click.
  assert.equal(h.records.length, 0);
});

test('a mismatched betslip never reaches stake entry or submission', async () => {
  const h = placementHarness({ slipOk: false });
  assert.equal((await h.submit()).reason, 'betslip_fixture_mismatch');
  assert.equal(h.clicks.length, 0);
  assert.equal(h.records.length, 0);
  assert.equal(h.context.autoBet, true); // A rejected selection can be retried safely.
});

test('confirmed bookmaker stake is persisted before continuing progression', async () => {
  const h = placementHarness({ confirmed: true });
  assert.equal((await h.submit()).placed, true);
  assert.equal(h.records[0].stake, 25);
  assert.equal(h.records[0].ticket_id, '1280063081');
  assert.equal(h.context.autoBet, true);
});

test('database failure after an accepted ticket pauses without retrying the wager', async () => {
  const h = placementHarness({ confirmed: true, databaseFails: true });
  assert.equal((await h.submit()).placed, true);
  assert.equal(h.context.autoBet, false);
  assert.match(h.context.placementPersistenceError, /could not be persisted/);
});

test('accepted receipt survives a database failure and recovery persists it exactly once without another click', async t => {
  const h = placementHarness({ confirmed: true, databaseFails: true });
  await h.submit();
  const accepted = h.context.pendingSubmission;
  assert.equal(accepted.confirmation.confirmed, true);
  const { api } = database(t);
  h.context.db = api;
  h.context.lastReconciliationAt = 0;
  const reconcile = vm.runInNewContext(slice('async function reconcilePendingSubmission(', '// ─── Locate & Physically Click Target Odds Button') + '\nreconcilePendingSubmission', h.context);
  const before = h.clicks.length;
  await reconcile({}, {});
  await reconcile({}, {});
  assert.equal(h.clicks.length, before);
  assert.equal(api.getRecentBets().length, 1);
  assert.equal(h.context.pendingSubmission, null);
  assert.equal(h.context.autoBet, true);
  assert.equal(h.context.sessionStats.placedCount, 1);
  assert.equal(api.getRecentBets()[0].placed_at, accepted.submittedAt.slice(0, 19).replace('T', ' '));
});

test('settled history recovery records actual payout and advances the next stake from the actual loss', async t => {
  const h = placementHarness({ confirmed: true, databaseFails: true });
  await h.submit();
  h.context.pendingSubmission.confirmation = { ...h.context.pendingSubmission.confirmation, status: 'LOST', won: 0, source: 'bet_history' };
  const { api } = database(t);
  h.context.db = api;
  h.context.lastReconciliationAt = 0;
  const reconcile = vm.runInNewContext(slice('async function reconcilePendingSubmission(', '// ─── Locate & Physically Click Target Odds Button') + '\nreconcilePendingSubmission', h.context);
  await reconcile({}, {});
  assert.equal(api.getRecentBets()[0].status, 'LOST');
  assert.equal(api.getRecentBets()[0].profit_loss, -25);
  assert.equal(staking(api).calculateCurrentStake().stake, 40);
  assert.equal(h.context.sessionStats.lostCount, 1);
});

test('recovered win uses bookmaker payout instead of recalculating rounded winnings from odds', async t => {
  const h = placementHarness({ confirmed: true, databaseFails: true });
  await h.submit();
  h.context.pendingSubmission.confirmation = { ...h.context.pendingSubmission.confirmation, status: 'WON', won: 80, source: 'provider_receipt' };
  const { api } = database(t);
  h.context.db = api; h.context.lastReconciliationAt = 0;
  const reconcile = vm.runInNewContext(slice('async function reconcilePendingSubmission(', '// ─── Locate & Physically Click Target Odds Button') + '\nreconcilePendingSubmission', h.context);
  await reconcile({}, {});
  assert.equal(api.getRecentBets()[0].profit_loss, 55);
  assert.equal(staking(api).calculateCurrentStake().stake, 10);
  assert.equal(h.context.sessionStats.wonCount, 1);
});

test('expired provider authorization preserves the journal and requests session recovery', async () => {
  const h = placementHarness();
  await h.submit();
  h.context.lastReconciliationAt = 0;
  h.context.confirmBetPlacementInMyBets = async () => ({ confirmed: false, reason: 'provider_auth_expired', evidence: [] });
  const reconcile = vm.runInNewContext(slice('async function reconcilePendingSubmission(', '// ─── Locate & Physically Click Target Odds Button') + '\nreconcilePendingSubmission', h.context);
  const result = await reconcile({}, {});
  assert.equal(result.refreshProviderSession, true);
  assert.ok(h.context.pendingSubmission);
  assert.equal(h.context.autoBet, false);
});
