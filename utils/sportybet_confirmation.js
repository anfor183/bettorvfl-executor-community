const fs = require('fs');
const path = require('path');

const validTicket = id => /^\d{8,12}$/.test(String(id));
const money = value => {
  const number = String(value ?? '').replace(/[,\s₦#]/g, '').replace(/^NGN/i, '');
  return /^\d+(?:\.\d+)?$/.test(number) ? Number(number) : null;
};

function parseMyBetsText(text) {
  const tickets = [];
  const pattern = /\bTICKET\s*:\s*#?(\d{8,12})\b([\s\S]*?)(?=\bTICKET\s*:\s*#?\d{8,12}\b|$)/gi;
  for (const match of String(text || '').matchAll(pattern)) {
    const block = match[2];
    const fixture = block.match(/#(\d{6,7})\s+([A-Z]{3})\s*-\s*([A-Z]{3})\b/);
    const teams = fixture || block.match(/\b([A-Z]{3})\s*-\s*([A-Z]{3})\b/);
    const stake = block.match(/Total\s*stake:\s*((?:NGN|₦|#)?\s*[\d,]+(?:\.\d+)?)/i);
    const won = block.match(/Won:\s*((?:NGN|₦|#)?\s*[\d,]+(?:\.\d+)?)/i);
    let status = block.match(/Status:\s*(OPEN|PENDING|WON|LOST|VOID|CANCELLED)\b/i)?.[1]?.toUpperCase();
    if (!status) status = block.match(/\b(LOST|OPEN|VOID|CANCELLED|PENDING)\b/i)?.[1]?.toUpperCase();
    if (!status && won && money(won[1]) > 0) status = 'WON';
    const week = block.match(/\bWeek\s*(\d+|I)\b/i);
    tickets.push({ ticketId: match[1], status: status || 'UNKNOWN', stake: stake ? money(stake[1]) : null,
      won: won ? money(won[1]) : null, fixtureId: fixture?.[1] || null,
      matchCode: teams ? (fixture ? `${fixture[2]}-${fixture[3]}` : `${teams[1]}-${teams[2]}`) : null,
      week: week ? (week[1].toUpperCase() === 'I' ? 1 : Number(week[1])) : null,
      marketText: block.match(/\bWeek\s*(?:\d+|I)\s*([\s\S]*?)(?:Status\s*:|Single\s*\(|Total\s*stake:)/i)?.[1] || '',
      rawPreview: block.slice(0, 160).replace(/\s+/g, ' ') });
  }
  return tickets;
}

function parseHistoryDetail(text, summary) {
  if (!validTicket(summary.ticketId)) return null;
  const escapedId = String(summary.ticketId);
  const block = String(text).match(new RegExp(`#${escapedId}\\b([\\s\\S]*?)(?=\\n#\\d{8,12}\\b|$)`))?.[1];
  if (!block || !/Single\s*\(x1\)/i.test(block)) return null;
  const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const index = lines.findIndex(l => /^[A-Z]{3}\s*-\s*[A-Z]{3}$/.test(l));
  if (index < 1) return null;
  const fixtureId = lines[index - 1].match(/^#(\d{6,7})$/)?.[1];
  const week = block.match(/\bWeek\s*:\s*(\d+)/i);
  if (!fixtureId || !week) return null;
  return { ...summary, fixtureId, week: Number(week[1]), matchCode: lines[index].replace(/\s/g, ''),
    marketText: `${lines[index + 1] || ''} ${lines[index + 2] || ''}`,
    rawPreview: block.slice(0, 180).replace(/\s+/g, ' ') };
}

function isNewTicket(ticketId, submission) {
  if (!validTicket(ticketId)) return false;
  const baseline = (submission.baselineIds || []).filter(validTicket).map(String);
  if (baseline.includes(String(ticketId))) return false;
  // Ticket IDs are increasing provider-issued IDs; a pruned old card cannot become a new receipt.
  return !baseline.length || BigInt(ticketId) > baseline.reduce((max, id) => BigInt(id) > max ? BigInt(id) : max, 0n);
}

function matchingTickets(tickets, submission, matchTeams, matchesMarket) {
  const matches = tickets.filter(ticket => {
    if (!isNewTicket(ticket.ticketId, submission)) return false;
    if (ticket.stake == null || Math.abs(Number(ticket.stake) - submission.stake) > 0.009) return false;
    if (Number(ticket.week) !== Number(submission.pick.round_number)) return false;
    if (submission.fixtureId && String(ticket.fixtureId) !== String(submission.fixtureId)) return false;
    const teams = String(ticket.matchCode || '').split('-');
    return teams.length === 2 && matchTeams(submission.pick.home_team, teams[0]) &&
      matchTeams(submission.pick.away_team, teams[1]) && matchesMarket(ticket.marketText, submission.pick);
  });
  return [...new Map(matches.map(ticket => [String(ticket.ticketId), ticket])).values()];
}

// IO only observes receipts and opens read-only history. It never clicks Place Bet.
async function confirmSubmission(submission, io, { timeoutMs = 30000, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const started = now();
  const evidence = [];
  let noReceiptEvidence = submission.noReceiptEvidence || null;
  let earlyRejection = null;
  try { earlyRejection = await io.readRejection(); } catch {}
  const resultFor = (tickets, source) => {
    const matches = matchingTickets(tickets, submission, io.matchTeams, io.matchesMarket);
    if (matches.length > 1) return { confirmed: false, reason: 'multiple_matching_tickets', evidence, ambiguous: true };
    return matches.length === 1 ? { ...matches[0], confirmed: true, source, evidence } : null;
  };
  // Opening My Bets is mandatory, even if old cards are already present in the DOM.
  try { await io.openMyBets(); } catch (e) { evidence.push(`my_bets_open: ${e.message}`); }
  let pass = 0;
  while (now() - started < timeoutMs) {
    if (io.readReceipts) {
      try {
        const result = resultFor(await io.readReceipts(), 'provider_receipt');
        if (result) return result;
      } catch (e) { evidence.push(`provider_receipt: ${e.message}`); }
    }
    try {
      const result = resultFor(await io.readMyBets(), 'my_bets');
      if (result) return result;
    } catch (e) { evidence.push(`my_bets_read: ${e.message}`); }
    if (io.providerAuthExpired?.()) return { confirmed: false, reason: 'provider_auth_expired', evidence };
    // Independent server history works when My Bets is stale, hidden, empty, or already cleared.
    if (pass === 1 || pass === 5) {
      try {
        const history = await io.readHistory(submission);
        const result = resultFor(Array.isArray(history) ? history : history.tickets, 'bet_history');
        if (result) return result;
        // Only a successful fresh server reply can prove absence. Empty/stale DOM never does.
        const baseline = (submission.baselineIds || []).filter(validTicket).map(String);
        const latest = baseline.reduce((max, id) => BigInt(id) > BigInt(max) ? id : max, '0');
        const closedAt = Date.parse(submission.acceptanceDeadline);
        if (history.fresh && Number.isFinite(closedAt) && history.serverTime > closedAt + 60000 &&
            history.requestedAt > closedAt + 60000 && history.ids.includes(latest) &&
            !history.ids.some(id => isNewTicket(id, submission))) {
          if (noReceiptEvidence?.baselineId === latest && history.responseId !== noReceiptEvidence.responseId && now() - noReceiptEvidence.checkedAt >= 20000) {
            return { confirmed: false, notSubmitted: true, reason: 'no_receipt_after_closed_round', evidence,
              noReceiptEvidence: { ...noReceiptEvidence, verifiedAt: now(), responseId: history.responseId } };
          }
          noReceiptEvidence ||= { baselineId: latest, checkedAt: now(), responseId: history.responseId };
        }
      } catch (e) { evidence.push(`history_read: ${e.message}`); }
      if (io.providerAuthExpired?.()) return { confirmed: false, reason: 'provider_auth_expired', evidence };
      try { await io.openMyBets(); } catch (e) { evidence.push(`my_bets_reopen: ${e.message}`); }
    }
    try {
      const rejection = earlyRejection || await io.readRejection();
      if (rejection && pass >= 1) return { confirmed: false, rejected: true, reason: rejection, evidence };
    } catch (e) { evidence.push(`rejection_read: ${e.message}`); }
    await sleep(Math.min(1000 + pass * 500, 3500));
    pass++;
  }
  return { confirmed: false, reason: 'awaiting_bookmaker_evidence', evidence: evidence.slice(-8), noReceiptEvidence };
}

class SubmissionJournal {
  constructor(file) { this.file = file; }
  read() {
    if (!fs.existsSync(this.file)) return null;
    const entry = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (entry.version !== 1 || !['pending', 'confirmed', 'rejected', 'not_submitted'].includes(entry.state)) throw new Error('Invalid submission journal');
    if (entry.state === 'pending' && (!entry.id || !entry.pick?.home_team || !entry.pick?.away_team || !entry.pick?.market ||
      !Number.isInteger(Number(entry.pick.round_number)) || !Number.isFinite(entry.stake) || entry.stake <= 0 ||
      !Number.isFinite(Date.parse(entry.submittedAt)) || !Array.isArray(entry.baselineIds))) throw new Error('Incomplete submission journal');
    return entry;
  }
  pending() { const entry = this.read(); return entry?.state === 'pending' ? entry : null; }
  save(entry) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const next = { ...entry, version: 1, updatedAt: new Date().toISOString() };
    const temp = this.file + '.tmp';
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
    return next;
  }
}

module.exports = { parseMyBetsText, parseHistoryDetail, isNewTicket, matchingTickets, confirmSubmission, SubmissionJournal, money };
