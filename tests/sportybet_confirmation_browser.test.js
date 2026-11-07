const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { confirmSubmission, parseMyBetsText } = require('../utils/sportybet_confirmation');
const { createHistoryReader } = require('../utils/sportybet_confirmation_ui');

test('offline Chrome: stale My Bets cards fall back to real history controls and close the modal', { timeout: 25000 }, async t => {
  const executable = process.env.CONFIRMATION_TEST_CHROME || (process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
  if (!fs.existsSync(executable)) return t.skip('Set CONFIRMATION_TEST_CHROME to run the offline Chrome integration test');
  const puppeteer = require('rebrowser-puppeteer-core');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bettor-confirmation-browser-'));
  const browser = await puppeteer.launch({ executablePath: executable, userDataDir: profile, headless: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1366, height: 768 } });
  t.after(async () => {
    await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (browser.process()?.exitCode === null) browser.process().kill();
    if (path.resolve(profile).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    }
  });
  const page = await browser.newPage();
  const detail = 'Bets\nEVENT\nMARKET\nSELECTION\nFootball League: England\n#10555 Week: 36\n06/11/2026\n#4015787\nIPS - FUL\nOver/Under 3.5\nOver 3.5\n3.35\n1 : 0\n₦205\n₦0\nCombination groups (1)\nSingle (x1)';
  // Structure and class names reproduced from the downloaded live history panel.
  const history = `<app-bet-history><div class="modal-header"><span>Bets History</span><button class="refresh"><span class="fa-refresh">Refresh</span></button><button class="close" aria-label="Close">×</button></div>
    <div class="modal-body-content"><div>Ticket ID</div><app-bet-history-item><div class="ticket-history-item">
      <div class="ticket-history-item-ticket-id"><strong>#1282031000</strong></div><div class="ticket-history-item-date">06/11/2026 22:34</div>
      <div class="ticket-history-item-stake">₦205</div><div class="ticket-history-item-win">₦0</div><div class="ticket-history-item-status"><span title="Lost">Lost</span></div>
    </div><pre class="ticket-history-details"></pre></app-bet-history-item></div></app-bet-history>`;
  await page.setContent(`<style>app-bet-history{display:block;position:fixed;left:300px;top:100px;width:600px;background:white;border:1px solid black}.modal-header{display:flex;justify-content:space-between;padding:8px}.modal-body-content{height:500px;overflow:auto;padding:10px}.ticket-history-item>div{padding:6px}.ticket-history-item-ticket-id{width:100px;cursor:pointer}pre{white-space:pre-wrap}button{padding:10px}</style>
    <button id="open">Bets History</button><div style="height:500px;width:210px">My Bets <button id="my-bets">My Bets 57</button><pre>TICKET: #1282029990
    #4015765 IPS - TOT
    Week 34
    Match result Home
    Status: LOST
    Total stake: ₦135</pre></div>
    <script>document.getElementById('open').addEventListener('click',()=>{document.body.insertAdjacentHTML('beforeend',${JSON.stringify(history)});const root=document.querySelector('app-bet-history');root.querySelector('button.close').addEventListener('click',()=>root.remove());root.querySelector('.ticket-history-item-ticket-id').addEventListener('click',()=>{root.querySelector('pre').textContent=${JSON.stringify(detail)};});});document.getElementById('my-bets').addEventListener('click',()=>{document.body.dataset.myBetsOpened='true';});</script>`);
  const frame = page.mainFrame();
  const actions = {
    getFrameOffset: async () => ({ fOffsetX: 0, fOffsetY: 0 }),
    hardwareClickAt: async (_page, x, y) => { await page.mouse.click(x, y); return true; },
    hardwareMouseMove: async (_page, x, y) => page.mouse.move(x, y),
    hardwareScroll: async (_page, delta) => page.mouse.wheel({ deltaY: delta }),
    delay: ms => new Promise(r => setTimeout(r, ms)), randomDelay: async () => {}
  };
  const source = fs.readFileSync(path.join(__dirname, '../sportybet_executor.js'), 'utf8');
  const start = source.indexOf('async function switchToMyBetsTab(');
  const end = source.indexOf('// ─── Verify Pick Presence', start);
  const helpers = vm.runInNewContext(source.slice(start, end) + '\n({switchToMyBetsTab,readMyBetsTickets})', { ...actions, parseMyBetsText });
  const pending = { pick: { home_team: 'Ipswich Town', away_team: 'Fulham', round_number: 36, market: 'Over 3.5 Goals' }, fixtureId: '4015787', stake: 205, baselineIds: ['1282029990'] };
  const result = await confirmSubmission(pending, {
    openMyBets: () => helpers.switchToMyBetsTab(frame, page), readMyBets: () => helpers.readMyBetsTickets(frame),
    readHistory: createHistoryReader({ frame, page, ...actions }), readRejection: async () => null,
    matchTeams: (team, code) => ({ 'Ipswich Town': 'IPS', Fulham: 'FUL' })[team] === code,
    matchesMarket: text => /Over 3\.5/i.test(text)
  }, { timeoutMs: 12000 });
  assert.equal(result.confirmed, true, JSON.stringify(result));
  assert.equal(result.source, 'bet_history');
  assert.equal(result.ticketId, '1282031000');
  assert.equal(result.status, 'LOST');
  assert.equal(await page.evaluate(() => document.body.dataset.myBetsOpened), 'true');
  assert.equal(await page.$('app-bet-history'), null);
});
