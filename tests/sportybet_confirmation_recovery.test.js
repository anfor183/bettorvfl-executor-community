const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { parseMyBetsText, parseHistoryDetail, matchingTickets, confirmSubmission, SubmissionJournal } = require('../utils/sportybet_confirmation');
const { normalizeProviderTicket, ProviderReceiptObserver } = require('../utils/sportybet_receipts');

const submission = (changes = {}) => ({ id: 'attempt-17980', state: 'pending',
  pick: { id: 17980, home_team: 'Ipswich Town', away_team: 'Fulham', market: 'Over 3.5 Goals', round_number: 36 },
  fixtureId: '4015787', stake: 205, odds: 3.35, baselineIds: ['1282029990'],
  submittedAt: '2026-11-06T21:34:26.567Z', acceptanceDeadline: '2026-11-06T21:37:00Z', ...changes });
const ticket = (changes = {}) => ({ ticketId: '1282031000', fixtureId: '4015787', stake: 205, matchCode: 'IPS-FUL', week: 36,
  marketText: 'Over/Under 3.5 Over 3.5', status: 'OPEN', ...changes });
const matchTeams = (team, code) => ({ 'Ipswich Town': 'IPS', Fulham: 'FUL' })[team] === code;
const matchesMarket = text => /\bover 3\.5\b/i.test(text);
function clock(start = 0) { let time = start; return { now: () => time, sleep: async ms => { time += ms; } }; }
function io(changes = {}) { return { matchTeams, matchesMarket, openMyBets: async () => {}, readMyBets: async () => [],
  readHistory: async () => [], readRejection: async () => null, readReceipts: async () => [], ...changes }; }

test('new receipts must match event ID, ordered teams, week, market and exact stake', () => {
  for (const changes of [{ fixtureId: '4015700' }, { matchCode: 'FUL-IPS' }, { week: 35 }, { marketText: 'Under 3.5' }, { stake: 200 }, { ticketId: '1282029990' }, { ticketId: '4015787' }]) {
    assert.equal(matchingTickets([ticket(changes)], submission(), matchTeams, matchesMarket).length, 0);
  }
  assert.equal(matchingTickets([ticket()], submission(), matchTeams, matchesMarket).length, 1);
});

test('stale cards force opening My Bets, then independent history finds a settled receipt', async () => {
  const calls = [];
  const result = await confirmSubmission(submission(), io({
    openMyBets: async () => calls.push('open'), readMyBets: async () => [ticket({ ticketId: '1282029990' })],
    readHistory: async () => { calls.push('history'); return [ticket({ status: 'WON', won: 685 })]; }
  }), { ...clock(), timeoutMs: 30000 });
  assert.equal(result.confirmed, true);
  assert.equal(result.source, 'bet_history');
  assert.equal(result.status, 'WON');
  assert.equal(calls[0], 'open');
});

test('a delayed provider receipt can confirm even when the UI and history view fail', async () => {
  let reads = 0;
  const result = await confirmSubmission(submission(), io({
    readReceipts: async () => ++reads > 3 ? [ticket()] : [],
    readMyBets: async () => { throw Error('detached view'); }, readHistory: async () => { throw Error('history rendering unavailable'); }
  }), { ...clock(), timeoutMs: 30000 });
  assert.equal(result.confirmed, true);
  assert.equal(result.source, 'provider_receipt');
});

test('unknown transport outcomes remain unresolved; confirmation has no submission operation', async () => {
  const result = await confirmSubmission(submission(), io({ readHistory: async () => { throw Error('offline'); } }), { ...clock(), timeoutMs: 30000 });
  assert.equal(result.confirmed, false);
  assert.equal(result.rejected, undefined);
  assert.equal(result.notSubmitted, undefined);
  assert.match(result.evidence.join(' '), /offline/);
});

test('multiple new matching tickets remain ambiguous instead of guessing which one is ours', async () => {
  const result = await confirmSubmission(submission(), io({ readMyBets: async () => [ticket(), ticket({ ticketId: '1282031001' })] }), { ...clock() });
  assert.equal(result.confirmed, false);
  assert.equal(result.ambiguous, true);
});

test('repeated observations of the same receipt are one ticket, with the newest settlement', async () => {
  const result = await confirmSubmission(submission(), io({ readReceipts: async () => [ticket(), ticket({ status: 'LOST', won: 0 })] }), { ...clock() });
  assert.equal(result.confirmed, true);
  assert.equal(result.status, 'LOST');
});

test('explicit bookmaker rejection is distinct from a timeout', async () => {
  const result = await confirmSubmission(submission(), io({ readRejection: async () => 'insufficient_funds' }), { ...clock() });
  assert.equal(result.rejected, true);
  assert.equal(result.reason, 'insufficient_funds');
});

function historyReply(now, changes = {}) { return { tickets: [], ids: ['1282029990', '1282025355'], fresh: true,
  requestedAt: now, serverTime: now, receivedAt: now, responseId: String(now), ...changes }; }

test('a closed round needs two fresh server checks before resolving a genuinely missed submission', async () => {
  const after = Date.parse('2026-11-06T21:40:00Z');
  const firstClock = clock(after);
  const first = await confirmSubmission(submission(), io({ readHistory: async () => historyReply(firstClock.now()) }), { ...firstClock, timeoutMs: 8000 });
  assert.equal(first.notSubmitted, undefined);
  assert.equal(first.noReceiptEvidence.baselineId, '1282029990');
  const secondClock = clock(after + 31000);
  const second = await confirmSubmission(submission({ noReceiptEvidence: first.noReceiptEvidence }), io({ readHistory: async () => historyReply(secondClock.now()) }), { ...secondClock, timeoutMs: 8000 });
  assert.equal(second.notSubmitted, true);
  assert.equal(second.reason, 'no_receipt_after_closed_round');
});

test('absence never resolves from stale DOM, an open round, empty history, missing baseline or another new ticket', async () => {
  const after = Date.parse('2026-11-06T21:40:00Z');
  for (const changes of [{ fresh: false }, { serverTime: Date.parse('2026-11-06T21:37:10Z') }, { ids: [] }, { ids: ['1282025355'] }, { ids: ['1282031000', '1282029990'] }]) {
    const c = clock(after);
    const result = await confirmSubmission(submission({ noReceiptEvidence: { baselineId: '1282029990', checkedAt: after - 60000, responseId: 'old' } }),
      io({ readHistory: async () => historyReply(c.now(), changes) }), { ...c, timeoutMs: 8000 });
    assert.equal(result.notSubmitted, undefined, JSON.stringify(changes));
  }
});

test('production parser accepts currency and spacing variants without turning an OPEN zero payout into a loss', () => {
  const text = 'TICKET : #1282031000\n#4015787 IPS - FUL\nWeek 36\nOver/Under 3.5\nOver 3.5 3.35\nStatus: OPEN\nSingle (x1)\nTotal stake: NGN 205\nWon: NGN 0';
  const [parsed] = parseMyBetsText(text);
  assert.equal(parsed.status, 'OPEN');
  assert.equal(parsed.stake, 205);
  assert.equal(matchingTickets([parsed], submission(), matchTeams, matchesMarket).length, 1);
});

test('expanded history detail is matched independently of the summary stake alone', () => {
  const text = 'Bets History\n#1282031000\n06/11/2026 22:34\n₦205\n₦0\nBets\nEVENT\nMARKET\nSELECTION\nFootball League: England\n#10555 Week: 36\n06/11/2026\n#4015787\nIPS - FUL\nOver/Under 3.5\nOver 3.5\n3.35\n1 : 0\n₦205\n₦0\nCombination groups (1)\nSingle (x1)\n#1282029990\nold ticket';
  const detail = parseHistoryDetail(text, { ticketId: '1282031000', stake: 205, status: 'LOST', won: 0 });
  assert.equal(detail.fixtureId, '4015787');
  assert.equal(matchingTickets([detail], submission(), matchTeams, matchesMarket).length, 1);
});

function rawTicket() { return { ticketId: 1282031000, numBets: 1, stake: 205, status: 'LOST', timeRegister: '2026-11-06T21:34:28Z',
  details: { events: [{ eventId: 4015787, eventTime: '2026-11-06T21:37:00Z', data: { participants: [{ fifaCode: 'IPS' }, { fifaCode: 'FUL' }], data: { matchDay: 36 } },
    bets: [{ marketId: 'Over_Under_3_5', oddId: 'over_3_5', wonAmount: 0 }] }] } }; }

test('normalizes real provider receipt structure and refuses multi-event or ID-only acknowledgements', () => {
  const parsed = normalizeProviderTicket(rawTicket());
  assert.equal(matchingTickets([parsed], submission(), matchTeams, matchesMarket).length, 1);
  assert.equal(normalizeProviderTicket({ ticketId: 1282031000 }), null);
  assert.equal(normalizeProviderTicket({ ...rawTicket(), numBets: 2 }), null);
});

test('real PAIDOUT receipt uses wonData credited winnings, not the zero retained on the bet object', () => {
  const parsed = normalizeProviderTicket({ ...rawTicket(), status: 'PAIDOUT', wonData: { wonAmount: 685, wonCount: 1 } });
  assert.equal(parsed.status, 'WON');
  assert.equal(parsed.won, 685);
});

test('provider observer correlates websocket request and response, discards secrets and does not detach shared Network', async () => {
  const client = new EventEmitter(); const commands = [];
  client.send = async command => commands.push(command);
  const observer = await new ProviderReceiptObserver(client, () => 42).start();
  const frame = data => ({ requestId: 'provider-socket', response: { payloadData: JSON.stringify(data) } });
  client.emit('Network.webSocketFrameSent', frame({ type: 'REQUEST', xs: 7, req: { host: 'wss://virtual-proxy.virtustec.com', resource: '/tickets/findByTime', method: 'GET', query: { startTime: '2026-11-06T21:40:00Z' }, headers: { Authorization: 'DO_NOT_STORE' } } }));
  client.emit('Network.webSocketFrameReceived', frame({ type: 'RESPONSE', xs: 8, res: { statusCode: 200, body: [rawTicket()] } }));
  assert.equal(observer.receipts.length, 0);
  client.emit('Network.webSocketFrameReceived', frame({ type: 'RESPONSE', xs: 7, ts: Date.parse('2026-11-06T21:40:01Z'), res: { statusCode: 200, validResponse: true, body: [{ ...rawTicket(), unit: { secret: 'DO_NOT_STORE' } }] } }));
  assert.equal(observer.receipts.length, 1);
  assert.equal(observer.history.fresh, true);
  assert.ok(!JSON.stringify({ receipts: observer.receipts, history: observer.history }).includes('DO_NOT_STORE'));
  observer.stop();
  assert.deepEqual(commands, ['Network.enable']);
  assert.equal(client.listenerCount('Network.webSocketFrameReceived'), 0);
});

test('pending journal survives reconstruction; a resolved receipt is idempotent and corrupt files fail closed', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bettor-confirmation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pending.json');
  const journal = new SubmissionJournal(file);
  journal.save(submission());
  assert.equal(new SubmissionJournal(file).pending().id, 'attempt-17980');
  journal.save({ ...submission(), state: 'confirmed', confirmation: ticket() });
  assert.equal(new SubmissionJournal(file).pending(), null);
  fs.writeFileSync(file, '{');
  assert.throws(() => new SubmissionJournal(file).pending());
});

test('a correlated provider 401 requests session renewal and never counts as rejection or absence', async () => {
  const client = new EventEmitter(); client.send = async () => {};
  const observer = await new ProviderReceiptObserver(client).start();
  const event = data => ({ requestId: 'socket', response: { payloadData: JSON.stringify(data) } });
  client.emit('Network.webSocketFrameSent', event({ type: 'REQUEST', xs: 9, req: { host: 'wss://virtual-proxy.virtustec.com', method: 'GET', resource: '/tickets/findByTime' } }));
  client.emit('Network.webSocketFrameReceived', event({ type: 'RESPONSE', xs: 9, res: { statusCode: 401 } }));
  const result = await confirmSubmission(submission(), io({ providerAuthExpired: () => observer.authExpired }), { ...clock() });
  assert.equal(result.reason, 'provider_auth_expired');
  assert.equal(result.rejected, undefined);
  assert.equal(result.notSubmitted, undefined);
  assert.equal(observer.history, null);
  observer.stop();
});
