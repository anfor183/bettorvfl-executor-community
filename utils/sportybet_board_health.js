// An attached Golden Race iframe can stop updating without detaching.
class SportyBetBoardHealth {
  constructor() {
    this.lastRecoveryAt = -Infinity;
    this.reset();
  }

  reset(now = Date.now()) {
    this.clockKey = null;
    this.lastProgressAt = now;
    this.emptySince = null;
    this.invalidSince = null;
  }

  observe(board, now = Date.now()) {
    const validClock = !board.extractionError && Number.isFinite(board.remainingSec) &&
      board.remainingSec >= 0 && Number.isInteger(board.weekNumber) && board.weekNumber > 0;
    const hasFixtures = Array.isArray(board.fixtures) && board.fixtures.length > 0;
    const key = validClock ? `${board.weekNumber}:${board.remainingSec}` : null;
    if (key !== this.clockKey) {
      this.clockKey = key;
      this.lastProgressAt = now;
    }
    this.emptySince = hasFixtures ? null : (this.emptySince ?? now);
    this.invalidSince = validClock ? null : (this.invalidSince ?? now);

    let reason = null;
    if (this.invalidSince !== null && now - this.invalidSince >= 60000) {
      reason = 'Board timer/week could not be read for 60s';
    } else if (validClock && now - this.lastProgressAt >= 60000) {
      reason = `Week ${board.weekNumber} countdown frozen at ${board.timerText || board.remainingSec} for 60s`;
    } else if (this.emptySince !== null && now - this.emptySince >= 90000) {
      reason = 'No upcoming fixtures for 90s';
    }

    return {
      ready: validClock && hasFixtures && board.remainingSec > 0 && !reason,
      status: reason ? 'stalled' : (validClock && hasFixtures && board.remainingSec > 0 ? 'ready' : 'waiting'),
      reason,
      // Bound repeated reloads if the provider is unavailable.
      shouldRecover: !!reason && now - this.lastRecoveryAt >= 120000
    };
  }

  markRecoveryAttempt(now = Date.now()) {
    this.lastRecoveryAt = now;
  }
}

module.exports = { SportyBetBoardHealth };
