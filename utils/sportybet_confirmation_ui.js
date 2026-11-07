const { parseHistoryDetail, isNewTicket, money } = require('./sportybet_confirmation');

// All mutations are physical mouse/keyboard actions supplied by the executor.
function createHistoryReader({ frame, page, observer, getFrameOffset, hardwareClickAt, hardwareScroll, hardwareMouseMove, delay }) {
  async function click(kind, ticketId = '') {
    const locate = async () => frame.evaluate(({ kind, ticketId }) => {
      const history = document.querySelector('app-bet-history');
      let elements;
      if (kind === 'close') elements = history ? [...history.querySelectorAll('button.close[aria-label="Close"]')] : [];
      else if (kind === 'refresh') elements = history ? [...history.querySelectorAll('button')].filter(e => e.querySelector('.fa-refresh')) : [];
      else if (kind === 'ticket') elements = history ? [...history.querySelectorAll('.ticket-history-item-ticket-id')].filter(e => (e.innerText || '').trim() === '#' + ticketId) : [];
      else if (kind === 'more') elements = history ? [...history.querySelectorAll('*')].filter(e => /^load more tickets$/i.test((e.innerText || '').trim())) : [];
      else elements = [...document.querySelectorAll('*')].filter(e => /^bets?\s*history$/i.test((e.innerText || '').trim()));
      const el = elements.filter(e => e.offsetWidth > 10 && e.offsetWidth < 300).sort((a, b) => a.offsetWidth * a.offsetHeight - b.offsetWidth * b.offsetHeight)[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const panel = history?.querySelector('.modal-body-content')?.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2,
        panel: panel ? { x: panel.x + panel.width / 2, y: panel.y + panel.height / 2, top: panel.top, bottom: panel.bottom } : null };
    }, { kind, ticketId });
    let target = await locate();
    if (!target) return false;
    let offset = await getFrameOffset(frame);
    if (target.panel && (kind === 'ticket' || kind === 'more') && (target.y < target.panel.top + 15 || target.y > target.panel.bottom - 15)) {
      await hardwareMouseMove(page, target.panel.x + offset.fOffsetX, target.panel.y + offset.fOffsetY);
      await hardwareScroll(page, target.y - target.panel.y);
      await delay(250);
      target = await locate();
      if (!target || target.y < target.panel.top || target.y > target.panel.bottom) return false;
      offset = await getFrameOffset(frame);
    }
    if (!await hardwareClickAt(page, target.x + offset.fOffsetX, target.y + offset.fOffsetY)) return false;
    await delay(600);
    return true;
  }

  async function summaries() {
    return frame.evaluate(() => {
      const root = document.querySelector('app-bet-history');
      if (!root) throw new Error('History panel unavailable');
      const rows = [...root.querySelectorAll('.ticket-history-item')];
      return rows.map(row => ({
        ticketId: row.querySelector('.ticket-history-item-ticket-id')?.innerText.match(/\d{8,12}/)?.[0],
        stakeText: row.querySelector('.ticket-history-item-stake')?.innerText,
        wonText: row.querySelector('.ticket-history-item-win')?.innerText,
        status: row.querySelector('.ticket-history-item-status [title]')?.getAttribute('title')?.toUpperCase() || 'UNKNOWN',
        date: row.querySelector('.ticket-history-item-date')?.innerText.trim()
      }));
    });
  }

  return async function readHistory(submission) {
    const tickets = [];
    const openedAt = Date.now();
    try {
      const visible = await frame.evaluate(() => !!document.querySelector('app-bet-history'));
      if (visible) { if (!await click('refresh')) throw new Error('History refresh unavailable'); }
      else if (!await click('open')) throw new Error('History link unavailable');
      if (observer) {
        for (let attempt = 0; attempt < 8; attempt++) {
          if (observer.authExpired) throw new Error('provider_auth_expired');
          if (observer.history?.receivedAt >= openedAt) return observer.history;
          await delay(350);
        }
      }
      let rows = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        rows = await summaries();
        if (rows.length) break;
        await delay(500);
      }
      const inspected = new Set();
      for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
        const candidates = rows.filter(row => isNewTicket(row.ticketId, submission) &&
          money(row.stakeText) != null && Math.abs(money(row.stakeText) - submission.stake) < 0.01);
        for (const row of candidates.slice(0, 6)) {
          if (inspected.has(row.ticketId)) continue;
          inspected.add(row.ticketId);
          if (!await click('ticket', row.ticketId)) throw new Error(`History ticket ${row.ticketId} could not be opened`);
          let detail = null;
          for (let attempt = 0; attempt < 5; attempt++) {
            const text = await frame.evaluate(() => document.querySelector('app-bet-history')?.innerText || '');
            const status = row.status.replace(/[\s_]/g, '') === 'PAIDOUT' ? 'WON' : row.status;
            detail = parseHistoryDetail(text, { ticketId: row.ticketId, stake: money(row.stakeText), won: money(row.wonText), status, date: row.date });
            if (detail) break;
            await delay(350);
          }
          if (detail) tickets.push(detail);
        }
        // Existing IDs bound the search to receipts issued after the submission baseline.
        if (rows.some(row => !isNewTicket(row.ticketId, submission)) || tickets.length || !await click('more')) break;
        rows = await summaries();
      }
      return tickets;
    } finally {
      const opened = await frame.evaluate(() => !!document.querySelector('app-bet-history')).catch(() => false);
      if (opened && !await click('close')) throw new Error('History could not be closed; placement remains blocked');
    }
  };
}

module.exports = { createHistoryReader };
