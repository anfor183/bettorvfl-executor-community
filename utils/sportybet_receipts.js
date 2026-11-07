const validTicketId = id => /^\d{8,12}$/.test(String(id));

function normalizeProviderTicket(ticket) {
  const events = ticket?.details?.events;
  if (!validTicketId(ticket?.ticketId) || ticket.numBets !== 1 || events?.length !== 1 || events[0].bets?.length !== 1) return null;
  const event = events[0], bet = event.bets[0], teams = event.data?.participants;
  if (teams?.length !== 2 || !Number.isFinite(Number(ticket.stake))) return null;
  let market = String(bet.marketId || '').replace(/_/g, ' ');
  let selection = String(bet.oddId || '').replace(/_/g, ' ');
  selection = selection.replace(/\b(over|under)\s+(\d+)\s+(\d+)\b/i, '$1 $2.$3');
  if (/half.*(?:full|time)/i.test(market)) selection = selection.replace(/\b(home|away|draw|[12x])\s+(home|away|draw|[12x])\b/i, '$1/$2');
  if (/double.*chance/i.test(market)) market = 'Double Chance';
  if (/goal.*goal|both.*teams/i.test(market)) market = 'Goal Goal/No Goal';
  const rawStatus = String(ticket.status || 'UNKNOWN').toUpperCase().replace(/[\s_]/g, '');
  const status = rawStatus === 'PAIDOUT' ? 'WON' : /^(?:CANCELLED|CANCELED|REFUNDED)$/.test(rawStatus) ? 'VOID' : rawStatus;
  // Paid-out tickets retain zero at bet.wonAmount; the credited total is in wonData.
  const won = Number.isFinite(ticket.wonData?.wonAmount) ? ticket.wonData.wonAmount : Number.isFinite(bet.wonAmount) ? bet.wonAmount : null;
  return { ticketId: String(ticket.ticketId), fixtureId: String(event.eventId),
    matchCode: teams.map(t => t.fifaCode).join('-'), week: Number(event.data?.data?.matchDay),
    marketText: `${market} ${selection}`, stake: Number(ticket.stake),
    status, won,
    registeredAt: ticket.timeRegister || ticket.timeSend, eventTime: event.eventTime };
}

class ProviderReceiptObserver {
  constructor(client, now = Date.now) {
    this.client = client;
    this.now = now;
    this.requests = new Map();
    this.receipts = [];
    this.history = null;
    this.authExpired = false;
    this.onSent = e => this.receive('sent', e);
    this.onReceived = e => this.receive('received', e);
  }
  async start() {
    // Reuse Puppeteer's frame session; never disable Network or detach this shared session.
    this.client.on('Network.webSocketFrameSent', this.onSent);
    this.client.on('Network.webSocketFrameReceived', this.onReceived);
    try { await this.client.send('Network.enable'); }
    catch (e) { this.stop(); throw e; }
    return this;
  }
  stop() {
    this.client.off('Network.webSocketFrameSent', this.onSent);
    this.client.off('Network.webSocketFrameReceived', this.onReceived);
  }
  receive(direction, event) {
    let message;
    try { message = JSON.parse(event.response.payloadData); } catch { return; }
    const key = `${event.requestId}:${message.xs}`;
    if (direction === 'sent') {
      const req = message.req;
      if (message.type !== 'REQUEST' || !req || req.host !== 'wss://virtual-proxy.virtustec.com' || !/^\/tickets?(?:\/|$)/.test(req.resource || '')) return;
      // Retain correlation metadata only. Headers, credentials, and account objects are discarded.
      this.requests.set(key, { resource: req.resource, method: req.method, startTime: req.query?.startTime });
      if (this.requests.size > 100) this.requests.delete(this.requests.keys().next().value);
      return;
    }
    const request = this.requests.get(key);
    if (!request || message.type !== 'RESPONSE') return;
    this.requests.delete(key);
    if (message.res?.statusCode === 401 || message.res?.statusCode === 403) {
      this.authExpired = true;
      return;
    }
    if (message.res?.statusCode !== 200 || message.res?.validResponse === false) return;
    const body = message.res.body;
    const values = Array.isArray(body) ? body : [body?.ticket || body];
    const tickets = values.map(normalizeProviderTicket).filter(Boolean);
    this.receipts = [...this.receipts, ...tickets].slice(-100);
    if (request.resource === '/tickets/findByTime' && request.method === 'GET' && Array.isArray(body)) {
      this.history = { tickets, ids: body.map(t => String(t.ticketId)).filter(validTicketId),
        receivedAt: this.now(), serverTime: Number(message.ts), requestedAt: Date.parse(request.startTime),
        responseId: key, fresh: true };
    }
  }
}

module.exports = { ProviderReceiptObserver, normalizeProviderTicket };
