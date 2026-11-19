const agentTaskRepository = {
  createTask(task) {
    this.db.prepare(`INSERT OR IGNORE INTO tasks(id,source_event_id,chat_id,requester_id,scope,status,request_text,created_at,updated_at)
      VALUES(?,?,?,?,?,'running',?,?,?)`).run(task.id, task.sourceEventId || null, task.chatId, task.requesterId, task.scope,
      task.requestText, new Date().toISOString(), new Date().toISOString());
    return this.getTask(task.id);
  },

  getTask(id) {
    return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) || null;
  },

  beginToolExecution({ idempotencyKey, taskId, toolName }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`INSERT OR IGNORE INTO tool_executions
      (idempotency_key,task_id,tool_name,status,created_at,updated_at)
      VALUES(?,?,?,'executing',?,?)`).run(idempotencyKey, taskId, toolName, now, now);
    if (result.changes === 1) return { state: 'claimed' };
    const existing = this.db.prepare('SELECT * FROM tool_executions WHERE idempotency_key=?').get(idempotencyKey);
    if (existing.status === 'completed') return { state: 'completed', output: JSON.parse(existing.output_json) };
    if (existing.status === 'uncertain' || existing.status === 'executing') return { state: 'uncertain', error: existing.error };
    if (existing.status === 'failed') {
      const retry = this.db.prepare(`UPDATE tool_executions SET status='executing',error=NULL,updated_at=?
        WHERE idempotency_key=? AND status='failed'`).run(now, idempotencyKey);
      if (retry.changes) return { state: 'claimed' };
    }
    return { state: existing.status, error: existing.error };
  },

  completeToolExecution(idempotencyKey, output) {
    this.db.prepare(`UPDATE tool_executions SET status='completed',output_json=?,error=NULL,updated_at=?
      WHERE idempotency_key=? AND status='executing'`)
      .run(JSON.stringify(output), new Date().toISOString(), idempotencyKey);
  },

  failToolExecution(idempotencyKey, error, uncertain = false) {
    this.db.prepare(`UPDATE tool_executions SET status=?,error=?,updated_at=?
      WHERE idempotency_key=? AND status='executing'`)
      .run(uncertain ? 'uncertain' : 'failed', String(error).slice(0, 1000), new Date().toISOString(), idempotencyKey);
  },

  recoverStaleToolExecutions(staleMs = 120000) {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare("SELECT DISTINCT task_id FROM tool_executions WHERE status='executing' AND updated_at<?").all(cutoff);
      const changed = this.db.prepare(`UPDATE tool_executions SET status='uncertain',
        error='Recovered interrupted tool execution; manual reconciliation may be required',updated_at=?
        WHERE status='executing' AND updated_at<?`).run(now, cutoff).changes;
      const updateTask = this.db.prepare("UPDATE tasks SET status='uncertain',error='A tool execution was interrupted; automatic replay is blocked',updated_at=? WHERE id=? AND status IN ('running','awaiting_approval')");
      for (const row of rows) updateTask.run(now, row.task_id);
      return changed;
    });
    return tx();
  },

  updateTask(id, fields) {
    const allowed = ['status', 'result_text', 'response_status', 'response_text', 'response_updated_at', 'model_tier', 'tool_calls', 'error'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) return;
    const sql = `UPDATE tasks SET ${keys.map((k) => `${k}=@${k}`).join(',')},updated_at=@updated_at WHERE id=@id`;
    this.db.prepare(sql).run({ ...fields, id, updated_at: new Date().toISOString() });
  },

  queueTaskResponse(taskId, text) {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE tasks SET response_text=?,response_status='pending',
      response_updated_at=?,updated_at=? WHERE id=? AND response_status IN ('none','pending')`)
      .run(text, now, now, taskId);
  },

  claimTaskResponse(taskId) {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const row = this.db.prepare('SELECT response_text,response_status FROM tasks WHERE id=?').get(taskId);
      if (!row || row.response_status !== 'pending') return null;
      const changed = this.db.prepare("UPDATE tasks SET response_status='sending',response_updated_at=?,updated_at=? WHERE id=? AND response_status='pending'")
        .run(now, now, taskId).changes;
      return changed ? row.response_text : null;
    });
    return tx();
  },

  finishTaskResponse(taskId, status) {
    this.db.prepare('UPDATE tasks SET response_status=?,response_updated_at=?,updated_at=? WHERE id=? AND response_status=?')
      .run(status, new Date().toISOString(), new Date().toISOString(), taskId, 'sending');
  },

  recoverStaleTaskResponses(staleMs = 120000) {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    return this.db.prepare("UPDATE tasks SET response_status='uncertain',response_updated_at=?,updated_at=? WHERE response_status='sending' AND response_updated_at<?")
      .run(new Date().toISOString(), new Date().toISOString(), cutoff).changes;
  },

  countTaskSteps(taskId) {
    return this.db.prepare('SELECT COUNT(*) AS count FROM task_steps WHERE task_id=?').get(taskId).count;
  },

  addTaskStep({ taskId, stepNo, toolName, input, output, status, durationMs }) {
    this.db.prepare(`INSERT OR IGNORE INTO task_steps(task_id,step_no,tool_name,input_json,output_json,status,duration_ms,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(taskId, stepNo, toolName || null,
      input == null ? null : JSON.stringify(input), output == null ? null : JSON.stringify(output),
      status, durationMs ?? null, new Date().toISOString());
  },

  createApproval(item) {
    this.db.prepare(`INSERT INTO approvals(id,task_id,chat_id,requester_id,tool_name,arguments_json,status,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'pending',?,?,?)`).run(item.id, item.taskId || null, item.chatId, item.requesterId, item.toolName,
      JSON.stringify(item.arguments), item.expiresAt, new Date().toISOString(), new Date().toISOString());
  },

  getApproval(id) {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
    return row ? { ...row, arguments: JSON.parse(row.arguments_json) } : null;
  },

  getPendingApprovalForTask(taskId) {
    const row = this.db.prepare("SELECT * FROM approvals WHERE task_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1").get(taskId);
    return row ? { ...row, arguments: JSON.parse(row.arguments_json) } : null;
  },

  getPendingApprovalsForChat(chatId) {
    const now = new Date().toISOString();
    return this.db.prepare(`
      SELECT id, task_id, tool_name, expires_at, created_at
      FROM approvals
      WHERE chat_id=? AND status='pending' AND expires_at>?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(chatId, now);
  },

  claimApproval(id, ownerId, configuredOwnerId) {
    if (ownerId !== configuredOwnerId) return null;
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM approvals WHERE id=? AND status='pending'").get(id);
      if (!row) return null;
      if (Date.parse(row.expires_at) < Date.now()) {
        this.db.prepare("UPDATE approvals SET status='expired',updated_at=? WHERE id=?").run(now, id);
        if (row.task_id) this.updateTask(row.task_id, { status: 'cancelled', result_text: 'Approval expired.' });
        return null;
      }
      const result = this.db.prepare("UPDATE approvals SET status='executing',updated_at=? WHERE id=? AND status='pending'").run(now, id);
      return result.changes ? { ...row, arguments: JSON.parse(row.arguments_json) } : null;
    });
    return tx();
  },

  failPendingApproval(id, error) {
    this.db.prepare("UPDATE approvals SET status='failed',execution_error=?,updated_at=? WHERE id=? AND status='pending'")
      .run(String(error).slice(0, 1000), new Date().toISOString(), id);
  },

  denyApproval(id) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE approvals SET status='denied',updated_at=?
      WHERE id=? AND status='pending' AND expires_at>?`).run(now, id, now);
    if (result.changes) {
      const row = this.db.prepare('SELECT task_id FROM approvals WHERE id=?').get(id);
      if (row?.task_id) this.updateTask(row.task_id, { status: 'cancelled', result_text: 'Owner denied the action.' });
      return true;
    }
    this.db.prepare(`UPDATE approvals SET status='expired',updated_at=?
      WHERE id=? AND status='pending' AND expires_at<=?`).run(now, id, now);
    const row = this.db.prepare('SELECT task_id FROM approvals WHERE id=?').get(id);
    if (row?.task_id) this.updateTask(row.task_id, { status: 'cancelled', result_text: 'Approval expired.' });
    return false;
  },

  finishApproval(id, status, error = null) {
    this.db.prepare('UPDATE approvals SET status=?,execution_error=?,updated_at=? WHERE id=? AND status=?')
      .run(status, error, new Date().toISOString(), id, 'executing');
    const row = this.db.prepare('SELECT task_id FROM approvals WHERE id=?').get(id);
    if (row?.task_id) {
      this.updateTask(row.task_id, {
        status: status === 'approved' ? 'completed' : status === 'uncertain' ? 'uncertain' : 'failed',
        result_text: status === 'approved' ? 'Approved external action executed.' : null,
        error: error || null
      });
    }
  },

  recoverStaleApprovals(staleMs = 120000) {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare("SELECT task_id FROM approvals WHERE status='executing' AND updated_at<? AND task_id IS NOT NULL").all(cutoff);
      const changed = this.db.prepare("UPDATE approvals SET status='uncertain',execution_error='Recovered interrupted approval; remote send status must be checked manually',updated_at=? WHERE status='executing' AND updated_at<?")
        .run(now, cutoff).changes;
      const updateTask = this.db.prepare("UPDATE tasks SET status='uncertain',error='Approval execution interrupted; check WhatsApp delivery manually',updated_at=? WHERE id=?");
      for (const row of rows) updateTask.run(now, row.task_id);
      return changed;
    });
    return tx();
  }
};

module.exports = { agentTaskRepository };
