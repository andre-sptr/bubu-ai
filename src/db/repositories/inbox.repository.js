function normalizePriority(priority = 5) {
  if (priority === null || priority === undefined || priority === '' || typeof priority === 'boolean') {
    return 5;
  }
  const parsed = Number(priority);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(10, parsed)) : 5;
}

function toCutoffIso(days, nowMs, fallbackDays) {
  const parsed = (days === null || days === undefined || days === '') ? fallbackDays : Number(days);
  const safeDays = Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackDays;
  return new Date(nowMs - safeDays * 86400000).toISOString();
}

const inboxRepository = {
  enqueueEvent({ eventId, chatId, senderId, payload, priority = 5 }) {
    const now = new Date().toISOString();
    const prio = normalizePriority(priority);
    const result = this.db.prepare(`INSERT OR IGNORE INTO inbox_events
      (event_id,chat_id,sender_id,payload_json,priority,status,attempts,available_at,created_at,updated_at)
      VALUES(?,?,?,?,?,'pending',0,?,?,?)`)
      .run(eventId, chatId, senderId, JSON.stringify(payload), prio, now, now, now);
    return result.changes === 1;
  },

  claimNextEvent() {
    const now = new Date().toISOString();
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM inbox_events
        WHERE status IN ('pending','failed')
          AND available_at<=?
          AND chat_id NOT IN (SELECT chat_id FROM inbox_events WHERE status='processing')
        ORDER BY COALESCE(priority, 5) ASC, created_at ASC, rowid ASC
        LIMIT 1`).get(now);
      if (!row) return null;
      const update = this.db.prepare(`UPDATE inbox_events SET status='processing',
        attempts=attempts+1,locked_at=?,updated_at=?
        WHERE event_id=? AND status IN ('pending','failed')`).run(now, now, row.event_id);
      if (!update.changes) return null;
      return {
        ...row,
        priority: row.priority ?? 5,
        status: 'processing',
        attempts: row.attempts + 1,
        payload: JSON.parse(row.payload_json)
      };
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
  },

  getQueueStats() {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END), 0) AS pendingCount,
        COALESCE(SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END), 0) AS processingCount,
        COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END), 0) AS failedCount,
        COALESCE(SUM(CASE WHEN status='dead' THEN 1 ELSE 0 END), 0) AS deadCount,
        COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END), 0) AS completedCount,
        MIN(CASE WHEN status='pending' THEN created_at END) AS oldestPendingAt
      FROM inbox_events
    `).get();
    return {
      pendingCount: Number(row?.pendingCount || 0),
      processingCount: Number(row?.processingCount || 0),
      failedCount: Number(row?.failedCount || 0),
      deadCount: Number(row?.deadCount || 0),
      completedCount: Number(row?.completedCount || 0),
      oldestPendingAt: row?.oldestPendingAt || null
    };
  },

  listDeadEvents({ chatId = null, limit = 10 } = {}) {
    const parsedLimit = (limit === null || limit === undefined || limit === '') ? 10 : Number(limit);
    const safeLimit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(50, Math.trunc(parsedLimit))) : 10;
    const baseSql = `
      SELECT event_id, chat_id, sender_id, attempts, COALESCE(priority, 5) AS priority,
        last_error, created_at, updated_at
      FROM inbox_events
      WHERE status='dead'
    `;
    if (chatId) {
      return this.db.prepare(`${baseSql} AND chat_id=? ORDER BY updated_at DESC, created_at DESC LIMIT ?`)
        .all(chatId, safeLimit);
    }
    return this.db.prepare(`${baseSql} ORDER BY updated_at DESC, created_at DESC LIMIT ?`)
      .all(safeLimit);
  },

  requeueDeadEvent(eventId) {
    const id = String(eventId || '').trim();
    if (!id) return { requeued: false, reason: 'not_found' };
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT event_id, status, last_error FROM inbox_events WHERE event_id=?').get(id);
      if (!row) return { requeued: false, reason: 'not_found' };
      if (row.status !== 'dead' && row.status !== 'failed') {
        return { requeued: false, reason: 'not_dead_or_failed' };
      }
      if (String(row.last_error || '').trim().toLowerCase().startsWith('delivery_uncertain:')) {
        return { requeued: false, reason: 'delivery_uncertain' };
      }
      const task = this.db.prepare('SELECT status, response_status FROM tasks WHERE source_event_id=? LIMIT 1').get(id);
      if (task && (task.status === 'uncertain' || task.response_status === 'uncertain')) {
        return { requeued: false, reason: 'delivery_uncertain' };
      }
      this.db.prepare(`UPDATE inbox_events
        SET status='pending', attempts=0, available_at=?, locked_at=NULL, last_error=NULL, updated_at=?
        WHERE event_id=? AND status IN ('dead','failed')`).run(now, now, id);
      return { requeued: true, eventId: row.event_id };
    })();
  },

  pruneHistoryAndQueue({
    completedRetentionDays = 7,
    deadRetentionDays = 30,
    telemetryRetentionDays = 30,
    nowMs = Date.now()
  } = {}) {
    const completedCutoff = toCutoffIso(completedRetentionDays, nowMs, 7);
    const deadCutoff = toCutoffIso(deadRetentionDays, nowMs, 30);
    const telemetryCutoff = toCutoffIso(telemetryRetentionDays, nowMs, 30);

    return this.db.transaction(() => {
      const deletedCompletedEvents = this.db.prepare(
        "DELETE FROM inbox_events WHERE status='completed' AND updated_at < ?"
      ).run(completedCutoff).changes;
      const deletedDeadEvents = this.db.prepare(
        "DELETE FROM inbox_events WHERE status='dead' AND updated_at < ?"
      ).run(deadCutoff).changes;
      const deletedModelUsage = this.db.prepare(
        'DELETE FROM model_usage WHERE created_at < ?'
      ).run(telemetryCutoff).changes;
      const deletedAuditLogs = this.db.prepare(
        'DELETE FROM audit_logs WHERE created_at < ?'
      ).run(telemetryCutoff).changes;

      return {
        deletedCompletedEvents,
        deletedDeadEvents,
        deletedModelUsage,
        deletedAuditLogs
      };
    })();
  }
};

module.exports = { inboxRepository };
