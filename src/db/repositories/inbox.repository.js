const inboxRepository = {
  enqueueEvent({ eventId, chatId, senderId, payload }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`INSERT OR IGNORE INTO inbox_events
      (event_id,chat_id,sender_id,payload_json,status,attempts,available_at,created_at,updated_at)
      VALUES(?,?,?,?,'pending',0,?,?,?)`)
      .run(eventId, chatId, senderId, JSON.stringify(payload), now, now, now);
    return result.changes === 1;
  },

  claimNextEvent() {
    const now = new Date().toISOString();
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM inbox_events
        WHERE status IN ('pending','failed') AND available_at<=?
        ORDER BY created_at LIMIT 1`).get(now);
      if (!row) return null;
      const update = this.db.prepare(`UPDATE inbox_events SET status='processing',
        attempts=attempts+1,locked_at=?,updated_at=?
        WHERE event_id=? AND status IN ('pending','failed')`).run(now, now, row.event_id);
      if (!update.changes) return null;
      return { ...row, status: 'processing', attempts: row.attempts + 1, payload: JSON.parse(row.payload_json) };
    });
    return claim();
  },

  finishEvent(eventId) {
    this.db.prepare(`UPDATE inbox_events SET status='completed',locked_at=NULL,updated_at=? WHERE event_id=?`)
      .run(new Date().toISOString(), eventId);
  },

  failEvent(eventId, error, attempts, maxAttempts = 5) {
    const dead = attempts >= maxAttempts;
    const delay = Math.min(300000, 1000 * (2 ** Math.max(0, attempts - 1)));
    this.db.prepare(`UPDATE inbox_events SET status=?,last_error=?,locked_at=NULL,
      available_at=?,updated_at=? WHERE event_id=?`).run(
      dead ? 'dead' : 'failed', String(error).slice(0, 1000),
      new Date(Date.now() + delay).toISOString(), new Date().toISOString(), eventId
    );
  },

  recoverStaleEvents(staleMs = 120000) {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    return this.db.prepare(`UPDATE inbox_events SET status='failed',locked_at=NULL,
      available_at=?,last_error='Recovered stale processing event',updated_at=?
      WHERE status='processing' AND locked_at<?`)
      .run(new Date().toISOString(), new Date().toISOString(), cutoff).changes;
  }
};

module.exports = { inboxRepository };
