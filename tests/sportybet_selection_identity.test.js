const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../sportybet_executor.js'), 'utf8');
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const aliases = slice('const TEAM_ALIASES =', '// ─── Golden Race Frame Locator');
const verifier = slice('function matchesBetslipMarket(', '// ─── Confirm Placed Bet in My Bets');

test('rejects the reported HLL-MCI betslip for the requested BOU-CHE HT/FT signal', async () => {
  const pick = { home_team: 'Bournemouth', away_team: 'Chelsea', round_number: 1, market: 'HT/FT 2/2' };
  const cases = [
    ['HLL - MCI', 1, 'Away/Away', 1, false],
    ['BOU - MCI', 1, 'Away/Away', 1, false],
    ['CHE - BOU', 1, 'Away/Away', 1, false],
    ['BOU - CHE', 2, 'Away/Away', 1, false],
    ['BOU - CHE', 1, 'Home/Away', 1, false],
    ['BOU - CHE', 1, 'Away/Away', 2, false],
    ['BOU - CHE', 1, 'Away/Away', 1, true]
  ];
  for (const [teams, week, selection, count, expected] of cases) {
    const betslip = {
      innerText: `Clear All (${count}) #4014297 ${teams} Football League - England Week ${week} Half Time/Full Time ${selection} 2.01 Stake mode Stake per bet Single (x1) Total stake: ₦10`,
      querySelectorAll: () => [{ offsetWidth: 100 }]
    };
    const verify = vm.runInNewContext(aliases + verifier + '\nverifyBetslipContainsPick', { document: { querySelector: () => betslip } });
    const result = await verify({ isDetached: () => false, evaluate: async fn => fn() }, pick);
    assert.equal(result.ok, expected, `${teams}, week ${week}, ${selection}, count ${count}`);
  }
});

test('market checks distinguish supported selections instead of accepting any nonempty betslip', () => {
  const matches = vm.runInNewContext(verifier + '\nmatchesBetslipMarket');
  for (const [market, text, expected] of [
    ['Over 3.5 Goals', 'Over/Under Over 3.5 3.46', true],
    ['Over 3.5 Goals', 'Over/Under Under 3.5 1.54', false],
    ['Over 3.5 Goals', 'Over/Under Over 2.5 2.01', false],
    ['X2', 'Double Chance Draw or Away 3.67', true],
    ['X2', 'Double Chance Home or Draw 1.4', false],
    ['Home Win', 'Match result Home 3.42', true],
    ['Home Win', 'Match result Away 3.42', false],
    ['Draw', 'Match result Draw 3.2', true],
    ['BTTS Yes', 'Goal Goal/No Goal GG 1.9', true],
    ['BTTS Yes', 'Goal Goal/No Goal NG 1.9', false],
    ['BTTS No', 'Goal Goal/No Goal NG 1.9', true]
  ]) assert.equal(matches(text, { market }), expected, `${market} / ${text}`);
});

function element(text, x, y, width = 50, height = 30) {
  return {
    innerText: text, children: [], offsetWidth: width, offsetHeight: height,
    getBoundingClientRect: () => ({ left: x - width / 2, right: x + width / 2, top: y - height / 2, bottom: y + height / 2, width, height })
  };
}

test('HT/FT selects the requested fixture button, excluding the previous fixture within 95px', async () => {
  const nodes = [element('Market filter', 100, 80),
    element('HLL', 220, 200), element('MCI', 280, 200),
    element('BOU', 220, 320), element('CHE', 280, 320),
    element('2/2\n2.01', 650, 244, 160, 40), // Previously selected: only 76px from the requested row.
    element('2/2\n3.42', 650, 364, 160, 40)
  ];
  const clicks = [];
  const locate = vm.runInNewContext(aliases + slice('async function locateAndClickOddsButton(', '// ─── Betslip Stake Entry') + '\nlocateAndClickOddsButton', {
    document: { querySelectorAll: () => nodes }, logger: { info() {}, warn() {} },
    clearBetslipPhysically: async () => {}, selectMarketFilter: async () => {}, randomDelay: async () => {},
    switchToBetslipTab: async () => {}, verifyBetslipContainsPick: async () => ({ ok: true }),
    getFrameOffset: async () => ({ fOffsetX: 0, fOffsetY: 0 }),
    hardwareClickAt: async (_page, x, y) => clicks.push([x, y])
  });
  const result = await locate({ evaluate: async (fn, args) => fn(args) }, { evaluate: async () => 900 }, {
    home_team: 'Bournemouth', away_team: 'Chelsea', market: 'HT/FT 2/2', round_number: 1
  });
  assert.equal(result.found, true);
  assert.equal(result.matchedPair, 'BOU - CHE');
  assert.equal(result.odd, 3.42);
  assert.deepEqual(clicks, [[650, 364]]);
});
