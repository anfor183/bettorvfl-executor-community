const test = require('node:test');
const assert = require('node:assert/strict');

// Test ticket parser regex logic directly
function parseMyBetsText(text) {
  const results = [];
  const regex = /TICKET:\s*#?(\d{8,12})([\s\S]*?)(?=(?:TICKET:\s*#?\d{8,12}|$))/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const ticketId = match[1];
    const block = match[2];
    const statusMatch = block.match(/Status:\s*([A-Z]+)/i);
    const stakeMatch = block.match(/Total stake:\s*[₦#]?\s*([\d,]+(?:\.\d+)?)/i);
    const wonMatch = block.match(/Won:\s*[₦#]?\s*([\d,]+(?:\.\d+)?)/i);
    const matchInfo = block.match(/(?:#\d+\s+)?([A-Z]{3}\s*-\s*[A-Z]{3})/i);
    const weekMatch = block.match(/Week\s*(\d+)/i);

    results.push({
      ticketId,
      status: statusMatch ? statusMatch[1].toUpperCase() : 'UNKNOWN',
      stake: stakeMatch ? parseFloat(stakeMatch[1].replace(/,/g, '')) : null,
      won: wonMatch ? parseFloat(wonMatch[1].replace(/,/g, '')) : null,
      matchCode: matchInfo ? matchInfo[1].replace(/\s+/g, '') : null,
      week: weekMatch ? parseInt(weekMatch[1], 10) : null
    });
  }
  return results;
}

test('strictly parses 10-digit ticket numbers and ignores 7-digit fixture event IDs', () => {
  const sampleText = `
Clear Completed 🗑️
▲ TICKET: #1277788530
#4009739 BOU - FUL 01:45
Football League - England
Week 1
Match result
Away 3.31 ⏱️
Status: OPEN
Single (x1)
Total stake: #10

▲ TICKET: #1277765252
#4009711 FUL - CHE 02:16
Football League - England
Week 37
Match result
Home 3.32
Status: LOST
Single (x1)
Total stake: #385
Won: #0
`;

  const parsed = parseMyBetsText(sampleText);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].ticketId, '1277788530');
  assert.equal(parsed[0].status, 'OPEN');
  assert.equal(parsed[0].stake, 10);
  assert.equal(parsed[0].week, 1);
  assert.equal(parsed[0].matchCode, 'BOU-FUL');

  assert.equal(parsed[1].ticketId, '1277765252');
  assert.equal(parsed[1].status, 'LOST');
  assert.equal(parsed[1].stake, 385);
  assert.equal(parsed[1].week, 37);
});

test('never accepts fixture ID as a ticket ID from betslip or DOM', () => {
  const unplacedBetslipText = `
Clear All (1)
#4009704 CHE - BOU 02:17
Football League - England
Week 36
Match result
Away 4.76
Stake mode Stake per bet
Single (x1) # 255
Total stake: #255
Max Potential Winnings: #1,210
Place Bet
`;

  const parsed = parseMyBetsText(unplacedBetslipText);
  // Must return 0 tickets because no "TICKET: #(\d{8,12})" exists in unplaced betslip
  assert.equal(parsed.length, 0);
});
