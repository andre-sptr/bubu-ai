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
  },

  getTelemetrySummary({ windowHours = 24, nowMs = Date.now() } = {}) {
    const parsedHours = (windowHours === null || windowHours === undefined || windowHours === '')
      ? 24
      : Number(windowHours);
    const safeHours = Number.isFinite(parsedHours) && parsedHours > 0 ? parsedHours : 24;
    const cutoffIso = new Date(nowMs - safeHours * 3600000).toISOString();

    const totals = this.db.prepare(`
      SELECT
        COUNT(*) AS totalCalls,
        COALESCE(SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END), 0) AS successCalls,
        COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS totalInputTokens,
        COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS totalOutputTokens,
        AVG(latency_ms) AS avgLatencyMs
      FROM model_usage
      WHERE created_at >= ?
    `).get(cutoffIso);

    const tierRows = this.db.prepare(`
      SELECT
        tier,
        COUNT(*) AS calls,
        COALESCE(SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END), 0) AS successCalls,
        COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS inputTokens,
        COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS outputTokens,
        AVG(latency_ms) AS avgLatencyMs
      FROM model_usage
      WHERE created_at >= ?
      GROUP BY tier
      ORDER BY calls DESC, tier ASC
    `).all(cutoffIso);

    const byTier = {};
    for (const row of tierRows) {
      const key = row.tier || 'unknown';
      byTier[key] = {
        calls: Number(row.calls || 0),
        successCalls: Number(row.successCalls || 0),
        inputTokens: Number(row.inputTokens || 0),
        outputTokens: Number(row.outputTokens || 0),
        avgLatencyMs: Math.round(Number(row.avgLatencyMs || 0))
      };
    }

    return {
      windowHours: safeHours,
      totalCalls: Number(totals?.totalCalls || 0),
      successCalls: Number(totals?.successCalls || 0),
      totalInputTokens: Number(totals?.totalInputTokens || 0),
      totalOutputTokens: Number(totals?.totalOutputTokens || 0),
      avgLatencyMs: Math.round(Number(totals?.avgLatencyMs || 0)),
      byTier
    };
  }
};

module.exports = { telemetryRepository };
