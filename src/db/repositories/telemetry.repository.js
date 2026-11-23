const {
  DEFAULT_USD_TO_IDR,
  estimateModelCostUsd,
  estimateCostIdr
} = require('../../utils/model-pricing');

const telemetryRepository = {
  logModelUsage({ taskId, modelId, tier, usage, latencyMs, outcome }) {
    this.db.prepare(`INSERT INTO model_usage(task_id,model_id,tier,input_tokens,output_tokens,latency_ms,outcome,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(taskId, modelId, tier, usage?.prompt_tokens ?? null,
      usage?.completion_tokens ?? null, latencyMs, outcome, new Date().toISOString());
  },

  consumeRateLimit(rateKey, { limit = 10, windowMs = 60000, now = Date.now() } = {}) {
    const cutoff = now - windowMs;
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM rate_limit_events WHERE rate_key=? AND created_at_ms<?').run(rateKey, cutoff);
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

  getTelemetrySummary({ windowHours = 24, nowMs = Date.now(), usdToIdr = DEFAULT_USD_TO_IDR } = {}) {
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

    const modelRows = this.db.prepare(`
      SELECT
        model_id AS modelId,
        tier,
        COUNT(*) AS calls,
        COALESCE(SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END), 0) AS successCalls,
        COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS inputTokens,
        COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS outputTokens,
        AVG(latency_ms) AS avgLatencyMs
      FROM model_usage
      WHERE created_at >= ?
      GROUP BY tier, model_id
      ORDER BY calls DESC, model_id ASC
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

    const byModel = {};
    const costByTier = {};
    let totalCostUsd = 0;

    for (const row of modelRows) {
      const modelKey = row.modelId || 'unknown';
      const tierKey = row.tier || 'unknown';
      const calls = Number(row.calls || 0);
      const successCalls = Number(row.successCalls || 0);
      const inputTokens = Number(row.inputTokens || 0);
      const outputTokens = Number(row.outputTokens || 0);
      const costUsd = estimateModelCostUsd({ modelId: modelKey, tier: tierKey, inputTokens, outputTokens });
      totalCostUsd += costUsd;

      if (!costByTier[tierKey]) {
        costByTier[tierKey] = {
          failedCalls: 0,
          estimatedCostUsd: 0,
          estimatedCostIdr: 0
        };
      }
      costByTier[tierKey].failedCalls += Math.max(0, calls - successCalls);
      costByTier[tierKey].estimatedCostUsd += costUsd;

      if (!byModel[modelKey]) {
        byModel[modelKey] = {
          calls: 0,
          successCalls: 0,
          failedCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      }
      byModel[modelKey].calls += calls;
      byModel[modelKey].successCalls += successCalls;
      byModel[modelKey].failedCalls += Math.max(0, calls - successCalls);
      byModel[modelKey].inputTokens += inputTokens;
      byModel[modelKey].outputTokens += outputTokens;
      byModel[modelKey].estimatedCostUsd += costUsd;
    }

    for (const info of Object.values(costByTier)) {
      info.estimatedCostUsd = Number(info.estimatedCostUsd.toFixed(6));
      info.estimatedCostIdr = estimateCostIdr(info.estimatedCostUsd, usdToIdr);
    }
    for (const info of Object.values(byModel)) {
      info.estimatedCostUsd = Number(info.estimatedCostUsd.toFixed(6));
      info.estimatedCostIdr = estimateCostIdr(info.estimatedCostUsd, usdToIdr);
    }

    const totalCalls = Number(totals?.totalCalls || 0);
    const successCalls = Number(totals?.successCalls || 0);
    const roundedCostUsd = Number(totalCostUsd.toFixed(6));

    return {
      windowHours: safeHours,
      totalCalls,
      successCalls,
      failedCalls: Math.max(0, totalCalls - successCalls),
      totalInputTokens: Number(totals?.totalInputTokens || 0),
      totalOutputTokens: Number(totals?.totalOutputTokens || 0),
      avgLatencyMs: Math.round(Number(totals?.avgLatencyMs || 0)),
      estimatedCostUsd: roundedCostUsd,
      estimatedCostIdr: estimateCostIdr(roundedCostUsd, usdToIdr),
      byTier,
      costByTier,
      byModel
    };
  },

  listRecentVisualizerRuns({ limit = 15 } = {}) {
    const parsed = (limit === null || limit === undefined || limit === '') ? 15 : Number(limit);
    const safeLimit = Number.isFinite(parsed) ? Math.max(1, Math.min(30, Math.trunc(parsed))) : 15;

    const tasks = this.db.prepare(`
      SELECT id, source_event_id, chat_id, scope, status, response_status, model_tier, tool_calls, created_at, updated_at
      FROM tasks
      ORDER BY created_at DESC
      LIMIT ?
    `).all(safeLimit);

    if (!tasks.length) return [];

    const usageStmt = this.db.prepare(`
      SELECT model_id, tier, input_tokens, output_tokens, latency_ms, outcome, created_at
      FROM model_usage
      WHERE task_id = ?
      ORDER BY id ASC
    `);
    const stepsStmt = this.db.prepare(`
      SELECT step_no, tool_name, status, duration_ms, created_at
      FROM task_steps
      WHERE task_id = ?
      ORDER BY step_no ASC
    `);

    return tasks.map((row) => ({
      id: row.id,
      sourceEventId: row.source_event_id || null,
      chatId: row.chat_id,
      scope: row.scope,
      status: row.status,
      responseStatus: row.response_status,
      modelTier: row.model_tier || null,
      toolCalls: Number(row.tool_calls || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      modelUsage: usageStmt.all(row.id).map((u) => ({
        modelId: u.model_id,
        tier: u.tier,
        inputTokens: Number(u.input_tokens || 0),
        outputTokens: Number(u.output_tokens || 0),
        latencyMs: Number(u.latency_ms || 0),
        outcome: u.outcome,
        createdAt: u.created_at
      })),
      steps: stepsStmt.all(row.id).map((s) => ({
        stepNo: Number(s.step_no || 0),
        toolName: s.tool_name,
        status: s.status,
        durationMs: Number(s.duration_ms || 0),
        createdAt: s.created_at
      }))
    }));
  }
};

module.exports = { telemetryRepository };
