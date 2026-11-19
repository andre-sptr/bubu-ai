const telemetryRepository = {
  logModelUsage({ taskId, modelId, tier, usage, latencyMs, outcome }) {
    this.db.prepare(`INSERT INTO model_usage(task_id,model_id,tier,input_tokens,output_tokens,latency_ms,outcome,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(taskId, modelId, tier, usage?.prompt_tokens ?? null,
      usage?.completion_tokens ?? null, latencyMs, outcome, new Date().toISOString());
  },

  consumeRateLimit(rateKey, { limit = 10, windowMs = 60000, now = Date.now() } = {}) {
    const cutoff = now - windowMs;
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM rate_limit_events WHERE created_at_ms<?').run(cutoff);
      const row = this.db.prepare(`SELECT COUNT(*) AS count, MIN(created_at_ms) AS oldest
        FROM rate_limit_events WHERE rate_key=? AND created_at_ms>=?`).get(rateKey, cutoff);
      if (row.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: Math.max(1, windowMs - (now - row.oldest))
        };
      }
      this.db.prepare('INSERT INTO rate_limit_events(rate_key,created_at_ms) VALUES(?,?)').run(rateKey, now);
      return { allowed: true, remaining: limit - row.count - 1, retryAfterMs: 0 };
    });
    return tx();
  },

  audit({ chatId = null, actorId = null, action, outcome, details = {} }) {
    this.db.prepare(`INSERT INTO audit_logs(chat_id,actor_id,action,outcome,details_json,created_at)
      VALUES(?,?,?,?,?,?)`).run(chatId, actorId, action, outcome, JSON.stringify(details), new Date().toISOString());
  }
};

module.exports = { telemetryRepository };
