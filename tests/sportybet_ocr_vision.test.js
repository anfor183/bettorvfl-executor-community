const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

// Helper to run Windows native AI OCR on any screenshot
function runOcrOnImage(imageRelativePath) {
  const fullPath = path.resolve(__dirname, '..', imageRelativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Screenshot not found at ${fullPath}`);
  }
  const psScript = path.resolve(__dirname, '..', 'run_ocr.ps1');
  const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${psScript}" -ImagePath "${fullPath}"`;
  const output = cp.execSync(cmd, { encoding: 'utf8', timeout: 30000 });
  return output.replace(/^=== OCR RECOGNIZED TEXT ===\r?\n/, '').trim();
}

// Bot's exact ticket parser logic matching sportybet_executor.js
function parseMyBetsText(text) {
  const results = [];
  const regex = /TICKET:\s*#?(\d{8,12})([\s\S]*?)(?=(?:TICKET:\s*#?\d{8,12}|$))/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const ticketId = match[1];
    const block = match[2];
    const statusMatch = block.match(/Status:\s*([A-Z]+)/i);
    const stakeMatch = block.match(/Total stake:.*?(\d+)/i);
    const wonMatch = block.match(/Won:\s*[₦#"]?\s*([\d,]+(?:\.\d+)?)/i);
    const matchInfo = block.match(/(?:#\d+\s+)?([A-Z]{3}\s*-\s*[A-Z]{3})/i);
    const weekMatches = [...block.matchAll(/Week\s*(\d+|I)/gi)];

    let weekNum = null;
    if (weekMatches.length > 0) {
      const wStr = weekMatches[weekMatches.length - 1][1];
      weekNum = wStr.toUpperCase() === 'I' ? 1 : parseInt(wStr, 10);
    }

    let status = statusMatch ? statusMatch[1].toUpperCase() : 'UNKNOWN';
    if (status === 'SINGLE' || status === 'UNKNOWN') {
      if (/\bLOST\b/i.test(block) || (wonMatch && parseFloat(wonMatch[1]) === 0)) status = 'LOST';
      else if (/\bWON\b/i.test(block) || (wonMatch && parseFloat(wonMatch[1]) > 0)) status = 'WON';
      else if (/\bOPEN\b/i.test(block)) status = 'OPEN';
    }

    results.push({
      ticketId,
      status,
      stake: stakeMatch ? parseInt(stakeMatch[1], 10) : null,
      won: wonMatch ? parseFloat(wonMatch[1].replace(/,/g, '')) : null,
      matchCode: matchInfo ? matchInfo[1].replace(/\s+/g, '') : null,
      week: weekNum,
      rawPreview: block.slice(0, 120).replace(/\n+/g, ' ')
    });
  }
  return results;
}

test('[OCR Vision] Reads actual confirmed bet screenshot and extracts 10-digit ticket with BOU - FUL match', () => {
  const ocrText = runOcrOnImage('data/vision_checks/latest_bet_confirmed.png');
  assert.ok(ocrText.length > 50, 'OCR output should contain recognized text');
  assert.match(ocrText, /TICKET:\s*#?1277788530/i, 'OCR should read ticket #1277788530');
  assert.match(ocrText, /BOU\s*-\s*FUL/i, 'OCR should read match BOU - FUL');

  const tickets = parseMyBetsText(ocrText);
  assert.ok(tickets.length >= 1, 'Should find at least 1 ticket from OCR vision text');

  const topTicket = tickets.find(t => t.ticketId === '1277788530');
  assert.ok(topTicket, 'Ticket #1277788530 must be found');
  assert.equal(topTicket.ticketId, '1277788530');
  assert.equal(topTicket.matchCode, 'BOU-FUL');
  assert.equal(topTicket.week, 1);

  // Fixture match event ID #4009739 must NOT be mistaken for a ticket ID
  assert.notEqual(topTicket.ticketId, '4009739');
  assert.ok(!tickets.some(t => t.ticketId === '4009739'), 'Fixture ID #4009739 must never be parsed as a ticket');
});

test('[OCR Vision] Distinguishes multiple settled tickets in ticket history from screenshot', () => {
  const ocrText = runOcrOnImage('data/vision_checks/latest_bet_confirmed.png');
  const tickets = parseMyBetsText(ocrText);

  // Second ticket in the list: #1277765252 (FUL - CHE, Week 37)
  const secondTicket = tickets.find(t => t.ticketId === '1277765252');
  assert.ok(secondTicket, 'Ticket #1277765252 must be identified');
  assert.equal(secondTicket.ticketId, '1277765252');
  assert.equal(secondTicket.matchCode, 'FUL-CHE');
  assert.equal(secondTicket.week, 37);

  // Third ticket in the list: #1277742598
  const thirdTicket = tickets.find(t => t.ticketId === '1277742598');
  assert.ok(thirdTicket, 'Ticket #1277742598 must be identified');
});

test('[OCR Vision] Unplaced betslip screenshot strictly yields ZERO confirmed tickets', () => {
  const ocrText = runOcrOnImage('data/vision_checks/latest_betslip_staked.png');
  assert.match(ocrText, /Betslip/i, 'OCR should recognize Betslip header');
  assert.match(ocrText, /Place\s*Bet/i, 'OCR should recognize Place Bet button in unplaced slip');
  assert.match(ocrText, /BOU\s*-\s*FUL/i, 'OCR should recognize selected match BOU - FUL');

  // Verify that an unplaced betslip NEVER produces a confirmed ticket
  const tickets = parseMyBetsText(ocrText);
  assert.equal(tickets.length, 0, 'Unplaced betslip must produce 0 confirmed tickets');
});

test('[Strict Human Clicks] sportybet_executor.js strictly contains ZERO synthetic JS clicks or dispatchEvent controls', () => {
  const code = fs.readFileSync(path.resolve(__dirname, '..', 'sportybet_executor.js'), 'utf8');

  // Check for forbidden javascript synthetic clicks
  const forbiddenPatterns = [
    /\.click\s*\(/g,
    /\.dispatchEvent\s*\(/g,
    /document\.execCommand/g
  ];

  for (const pattern of forbiddenPatterns) {
    const matches = code.match(pattern);
    assert.equal(matches, null, `Forbidden synthetic JS control found matching ${pattern}`);
  }

  // Ensure genuine hardware CDP mouse click and keyboard typing are used
  assert.ok(code.includes('targetPage.mouse.down'), 'Must use CDP mouse.down');
  assert.ok(code.includes('targetPage.mouse.up'), 'Must use CDP mouse.up');
  assert.ok(code.includes('targetPage.keyboard.type'), 'Must use CDP keyboard.type');
  assert.ok(code.includes('hardwareClickAt'), 'Must use hardwareClickAt helper');
  assert.ok(code.includes('switchToMyBetsTab'), 'Must use switchToMyBetsTab helper');
  assert.ok(code.includes('switchToBetslipTab'), 'Must use switchToBetslipTab helper');
  assert.ok(code.includes('confirmBetPlacementInMyBets'), 'Must use confirmBetPlacementInMyBets helper');
});
