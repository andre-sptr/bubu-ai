const productivityRepository = {
  createReminder({ chatId, requesterId, message, dueAt, sourceEventId = null }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`INSERT OR IGNORE INTO reminders(source_event_id,chat_id,requester_id,message,due_at,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'pending',?,?)`).run(sourceEventId, chatId, requesterId, message, dueAt, now, now);
    if (result.changes) return Number(result.lastInsertRowid);
    if (sourceEventId) {
      const existing = this.db.prepare('SELECT id FROM reminders WHERE source_event_id=?').get(sourceEventId);
      if (existing) return Number(existing.id);
    }
    throw new Error('Unable to create reminder');
  },

  claimDueReminders(now = new Date().toISOString()) {
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM reminders WHERE status='pending' AND due_at<=? ORDER BY due_at LIMIT 20").all(now);
      const update = this.db.prepare("UPDATE reminders SET status='sending',attempts=attempts+1,updated_at=? WHERE id=? AND status='pending'");
      const claimed = [];
      for (const row of rows) {
        if (update.run(new Date().toISOString(), row.id).changes) claimed.push({ ...row, status: 'sending' });
      }
      return claimed;
    });
    return tx();
  },

  finishReminder(id, success, error = null) {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE reminders SET status=?,delivery_uncertain=?,updated_at=?
      WHERE id=? AND status='sending'`)
      .run(success ? 'sent' : 'failed', success ? 0 : 1, now, id);
    if (!success) {
      this.audit({
        action: 'reminder_delivery_uncertain',
        outcome: 'manual_review',
        details: { reminderId: id, error: String(error || '').slice(0, 300) }
      });
    }
  },

  recoverStaleReminders(staleMs = 120000) {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    return this.db.prepare(`UPDATE reminders SET status='failed',delivery_uncertain=1,updated_at=?
      WHERE status='sending' AND updated_at<?`)
      .run(new Date().toISOString(), cutoff).changes;
  },

  listReminders({ chatId, requesterId, status = 'pending', limit = 20 }) {
    return this.db.prepare(`SELECT id,message,due_at,status,delivery_uncertain,created_at
      FROM reminders WHERE chat_id=? AND requester_id=? AND (? IS NULL OR status=?)
      ORDER BY due_at LIMIT ?`).all(chatId, requesterId, status, status, Math.max(1, Math.min(limit, 50)));
  },

  cancelReminder({ id, chatId, requesterId }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE reminders
      SET status = 'cancelled',
          updated_at = ?
      WHERE id = ?
        AND chat_id = ?
        AND requester_id = ?
        AND status = 'pending'
    `).run(now, id, chatId, requesterId);
    return result.changes === 1;
  },

  createUserTask(task) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO user_tasks
      (id,scope,owner_id,chat_id,title,description,status,priority,due_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?, 'open',?,?,?,?)`).run(
      task.id, task.scope, task.ownerId || null, task.chatId || null,
      task.title, task.description || null, task.priority || 'normal',
      task.dueAt || null, now, now
    );
    return this.getUserTask(task.id, task.scope, task.ownerId || null, task.chatId || null);
  },

  getUserTask(id, scope, ownerId = null, chatId = null) {
    return this.db.prepare(`SELECT * FROM user_tasks WHERE id=? AND scope=? AND
      ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))`)
      .get(id, scope, ownerId, chatId) || null;
  },

  listUserTasks({ scope, ownerId = null, chatId = null, status = null, limit = 20 }) {
    return this.db.prepare(`SELECT id,title,description,status,priority,due_at,created_at,updated_at
      FROM user_tasks WHERE scope=? AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
      AND (? IS NULL OR status=?)
      ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,due_at ASC,created_at DESC LIMIT ?`)
      .all(scope, ownerId, chatId, status, status, Math.max(1, Math.min(limit, 50)));
  },

  updateUserTask({ id, scope, ownerId = null, chatId = null, fields }) {
    const allowed = ['title', 'description', 'status', 'priority', 'due_at'];
    const keys = Object.keys(fields).filter((key) => allowed.includes(key));
    if (!keys.length) return this.getUserTask(id, scope, ownerId, chatId);
    const assignments = keys.map((key) => `${key}=@${key}`).join(',');
    const result = this.db.prepare(`UPDATE user_tasks SET ${assignments},updated_at=@updated_at
      WHERE id=@id AND scope=@scope AND
      ((scope='personal' AND owner_id=@ownerId) OR (scope='group' AND chat_id=@chatId))`)
      .run({ ...fields, id, scope, ownerId, chatId, updated_at: new Date().toISOString() });
    return result.changes ? this.getUserTask(id, scope, ownerId, chatId) : null;
  }
};

module.exports = { productivityRepository };
