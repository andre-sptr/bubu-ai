const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const PIPELINE_STAGES = Object.freeze([
  'ingress',
  'queue',
  'gate',
  'multimodal',
  'context',
  'llm',
  'tools',
  'delivery'
]);

const VALID_STAGE_SET = new Set(PIPELINE_STAGES);
const VALID_PHASE_SET = new Set(['started', 'progress', 'bypassed', 'waiting', 'completed', 'failed']);
const VALID_SCOPE_SET = new Set(['personal', 'group', 'system']);

const ALLOWED_STRING_META = new Set([
  'inputKind',
  'mediaKind',
  'extractionMode',
  'visualMode',
  'taskClass',
  'modelId',
  'modelTier',
  'escalatedFromTier',
  'fallbackFromModel',
  'toolName',
  'toolGroup',
  'outputMode',
  'slashCommand',
  'errorCategory',
  'wahaStatus',
  'approvalStatus'
]);

const ALLOWED_NUMBER_META = new Set([
  'priority',
  'attempts',
  'round',
  'maxRounds',
  'toolCount',
  'toolSchemaCount',
  'chunks',
  'durationMs',
  'latencyMs',
  'inputTokens',
  'outputTokens',
  'memoryCount',
  'projectCount',
  'docCount',
  'charCount',
  'queuePending',
  'queueProcessing',
  'queueFailed',
  'queueDead',
  'frameCount'
]);

const ALLOWED_BOOLEAN_META = new Set([
  'isGroup',
  'isFastPath',
  'ttsUsed',
  'parallel',
  'pendingApproval',
  'terminal',
  'bypassed',
  'replayed',
  'postTurn'
]);

const ALLOWED_ARRAY_META = new Set([
  'parallelTools',
  'toolGroups'
]);

function stripControlChars(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function sanitizeString(value, maxLen = 80) {
  const cleaned = stripControlChars(value);
  if (!cleaned) return '';
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function anonymizeChatId(chatId, salt = '') {
  const raw = String(chatId || '').trim().toLowerCase();
  if (!raw) return 'SYS';
  const prefix = raw.endsWith('@g.us') ? 'GRP-' : 'DM-';
  const digest = crypto
    .createHash('sha256')
    .update(`${String(salt || '')}|${raw}`)
    .digest('hex')
    .slice(0, 4);
  return `${prefix}${digest}`;
}

function sanitizeMeta(rawMeta) {
  if (!rawMeta || typeof rawMeta !== 'object' || Array.isArray(rawMeta)) {
    return {};
  }
  const clean = {};
  for (const [key, value] of Object.entries(rawMeta)) {
    if (value === undefined || value === null) continue;
    if (ALLOWED_STRING_META.has(key)) {
      const str = sanitizeString(value, 80);
      if (str) clean[key] = str;
    } else if (ALLOWED_NUMBER_META.has(key)) {
      const num = Number(value);
      if (Number.isFinite(num) && num >= 0) {
        clean[key] = Math.round(num);
      }
    } else if (ALLOWED_BOOLEAN_META.has(key)) {
      clean[key] = Boolean(value);
    } else if (ALLOWED_ARRAY_META.has(key) && Array.isArray(value)) {
      const arr = value
        .map((item) => sanitizeString(item, 48))
        .filter(Boolean)
        .slice(0, 8);
      if (arr.length > 0) clean[key] = arr;
    }
  }
  return clean;
}

function resolveToolGroup(toolRegistry, toolName) {
  if (!toolName) return 'core';
  try {
    const tool = typeof toolRegistry?.get === 'function' ? toolRegistry.get(toolName) : null;
    if (tool?.group) return sanitizeString(tool.group, 32) || 'core';
  } catch {
    // Fallback to heuristic group below.
  }
  const name = String(toolName).toLowerCase();
  if (name.includes('memory') || name.includes('remember') || name.includes('forget') || name.includes('project') || name.includes('note')) {
    return 'memory';
  }
  if (name.includes('task') || name.includes('reminder')) return 'productivity';
  if (name.includes('web')) return 'web';
  if (name.includes('document') || name.includes('pdf') || name.includes('spreadsheet') || name.includes('file')) {
    return 'documents';
  }
  if (name.includes('whatsapp') || name.includes('poll') || name.includes('waha') || name.includes('group') || name.includes('react') || name.includes('location') || name.includes('contact') || name.includes('link_preview') || name.includes('bot_message') || name.includes('recent_chat')) {
    return 'waha';
  }
  if (name.includes('usage') || name.includes('bubu_usage') || name.includes('system')) {
    return 'system';
  }
  return 'core';
}

function cloneRunForOutput(run) {
  return {
    runId: run.runId,
    chatRef: run.chatRef,
    scope: run.scope,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    currentStage: run.currentStage,
    status: run.status,
    inputKind: run.inputKind,
    taskClass: run.taskClass,
    modelTier: run.modelTier,
    modelId: run.modelId,
    outputMode: run.outputMode,
    ttsUsed: run.ttsUsed,
    hydrated: Boolean(run.hydrated),
    stages: { ...run.stages },
    timeline: Array.isArray(run.timeline) ? [...run.timeline] : []
  };
}

class PipelineEventBus extends EventEmitter {
  constructor({
    maxEvents = 120,
    maxRuns = 25,
    salt = crypto.randomBytes(16).toString('hex'),
    staleRunMs = 300000
  } = {}) {
    super();
    this.setMaxListeners(100);
    this.maxEvents = Math.max(10, Number(maxEvents) || 120);
    this.maxRuns = Math.max(5, Number(maxRuns) || 25);
    this.salt = String(salt || 'bubu-visualizer');
    this.staleRunMs = Math.max(10000, Number(staleRunMs) || 300000);
    this.seq = 0;
    this.events = [];
    this.activeRuns = new Map();
    this.recentRuns = [];
    this.discardedRunIds = new Set();
  }

  _rememberDiscarded(runId) {
    this.discardedRunIds.add(runId);
    if (this.discardedRunIds.size > 100) {
      const oldest = this.discardedRunIds.values().next().value;
      if (oldest) this.discardedRunIds.delete(oldest);
    }
  }

  _pushRecentRun(run) {
    this.recentRuns = [
      cloneRunForOutput(run),
      ...this.recentRuns.filter((item) => item.runId !== run.runId)
    ].slice(0, this.maxRuns);
  }

  _sweepStaleActiveRuns(nowMs = Date.now()) {
    for (const [runId, run] of this.activeRuns.entries()) {
      const updatedMs = Date.parse(run.updatedAt || run.startedAt || '');
      if (Number.isFinite(updatedMs) && nowMs - updatedMs > this.staleRunMs) {
        run.status = run.status === 'failed' ? 'failed' : 'completed';
        run.updatedAt = new Date(nowMs).toISOString();
        this.activeRuns.delete(runId);
        this._pushRecentRun(run);
      }
    }
  }

  _applyStageToRun(run, { seq, ts, stage, phase, label, chatRef, scope, meta }) {
    run.updatedAt = ts;
    if (!meta.postTurn) {
      run.currentStage = stage;
    }
    if (run.chatRef === 'SYS' && chatRef !== 'SYS') run.chatRef = chatRef;
    if (run.scope === 'system' && scope !== 'system') run.scope = scope;
    if (meta.inputKind && !run.inputKind) run.inputKind = meta.inputKind;
    if (meta.taskClass) run.taskClass = meta.taskClass;
    if (meta.modelTier) run.modelTier = meta.modelTier;
    if (meta.modelId) run.modelId = meta.modelId;
    if (meta.outputMode) run.outputMode = meta.outputMode;
    if (meta.ttsUsed !== undefined) run.ttsUsed = Boolean(meta.ttsUsed);

    if (phase === 'waiting') {
      run.status = 'waiting_approval';
    } else if (phase === 'failed' && meta.terminal !== false && stage === 'queue') {
      run.status = 'failed';
    } else if (run.status === 'waiting_approval' && (phase === 'started' || phase === 'completed')) {
      run.status = 'running';
    }

    const prevStage = run.stages[stage] || {};
    const nextDuration = meta.durationMs ?? meta.latencyMs ?? prevStage.durationMs ?? null;
    const isEndPhase = phase === 'completed' || phase === 'bypassed' || phase === 'failed';
    run.stages[stage] = {
      phase: meta.postTurn && prevStage.phase ? prevStage.phase : phase,
      label,
      startedAt: prevStage.startedAt || ts,
      completedAt: isEndPhase ? ts : (prevStage.completedAt || null),
      durationMs: nextDuration,
      meta: { ...(prevStage.meta || {}), ...meta }
    };

    run.timeline.push({ seq, ts, stage, phase, label, meta });
    if (run.timeline.length > 40) {
      run.timeline.shift();
    }
  }

  emitStage({
    runId,
    stage,
    phase = 'progress',
    label = '',
    chatId = '',
    scope = 'system',
    meta = {},
    runCompleted = undefined
  } = {}) {
    try {
      if (!VALID_STAGE_SET.has(stage) || !VALID_PHASE_SET.has(phase)) {
        return null;
      }

      const nowMs = Date.now();
      this._sweepStaleActiveRuns(nowMs);

      const seq = ++this.seq;
      const ts = new Date(nowMs).toISOString();
      const safeRunId = sanitizeString(runId || `run-${seq}`, 32) || `run-${seq}`;
      if (this.discardedRunIds.has(safeRunId)) {
        return null;
      }
      const chatRef = anonymizeChatId(chatId, this.salt);
      const safeScope = VALID_SCOPE_SET.has(scope) ? scope : 'system';
      const safeLabel = sanitizeString(label, 140) || `${stage}:${phase}`;
      const safeMeta = sanitizeMeta(meta);

      const event = {
        seq,
        ts,
        runId: safeRunId,
        stage,
        phase,
        label: safeLabel,
        chatRef,
        scope: safeScope,
        meta: safeMeta
      };

      this.events.push(event);
      if (this.events.length > this.maxEvents) {
        this.events.shift();
      }

      let run = this.activeRuns.get(safeRunId);
      const existingRecent = !run ? this.recentRuns.find((item) => item.runId === safeRunId) : null;

      if (existingRecent && (safeMeta.postTurn || (stage === 'queue' && phase === 'completed'))) {
        this._applyStageToRun(existingRecent, event);
      } else {
        if (!run) {
          run = {
            runId: safeRunId,
            chatRef,
            scope: safeScope,
            startedAt: ts,
            updatedAt: ts,
            currentStage: stage,
            status: 'running',
            inputKind: safeMeta.inputKind || null,
            taskClass: safeMeta.taskClass || null,
            modelTier: safeMeta.modelTier || null,
            modelId: safeMeta.modelId || null,
            outputMode: safeMeta.outputMode || null,
            ttsUsed: Boolean(safeMeta.ttsUsed),
            hydrated: false,
            stages: {},
            timeline: []
          };
          this.activeRuns.set(safeRunId, run);
        }

        this._applyStageToRun(run, event);

        const shouldFinalize =
          runCompleted === true ||
          (runCompleted !== false && stage === 'delivery' && phase === 'completed') ||
          (stage === 'queue' && phase === 'failed' && safeMeta.terminal === true);

        if (shouldFinalize) {
          run.status = phase === 'failed' ? 'failed' : 'completed';
          this.activeRuns.delete(safeRunId);
          this._pushRecentRun(run);
        }
      }

      this.emit('stage', event);
      return event;
    } catch {
      return null;
    }
  }

  finalizeRunIfActive(runId, status = 'completed') {
    try {
      const safeRunId = sanitizeString(runId, 32);
      if (!safeRunId) return null;
      const run = this.activeRuns.get(safeRunId);
      if (!run) return null;
      run.status = status === 'failed' ? 'failed' : (status === 'waiting_approval' ? 'waiting_approval' : 'completed');
      run.updatedAt = new Date().toISOString();
      this.activeRuns.delete(safeRunId);
      this._pushRecentRun(run);
      return cloneRunForOutput(run);
    } catch {
      return null;
    }
  }

  discardActiveRun(runId) {
    try {
      const safeRunId = sanitizeString(runId, 32);
      if (!safeRunId) return false;
      this._rememberDiscarded(safeRunId);
      return this.activeRuns.delete(safeRunId);
    } catch {
      return false;
    }
  }

  emitHealth(healthPayload = {}) {
    try {
      const safePayload = {
        ts: new Date().toISOString(),
        ...(healthPayload.waha ? {
          waha: {
            session: sanitizeString(healthPayload.waha.session, 40) || 'default',
            status: sanitizeString(healthPayload.waha.status, 32) || 'UNKNOWN',
            healthy: Boolean(healthPayload.waha.healthy)
          }
        } : {}),
        ...(healthPayload.worker ? {
          worker: {
            healthy: Boolean(healthPayload.worker.healthy),
            activeCount: Number(healthPayload.worker.activeCount || 0),
            maxConcurrentJobs: Number(healthPayload.worker.maxConcurrentJobs || 1),
            queue: healthPayload.worker.queue || null
          }
        } : {})
      };
      this.emit('health', safePayload);
      return safePayload;
    } catch {
      return null;
    }
  }

  hydrateFromDatabase(db) {
    try {
      if (!db || typeof db.listRecentVisualizerRuns !== 'function') return 0;
      const rows = db.listRecentVisualizerRuns({ limit: Math.min(15, this.maxRuns) }) || [];
      const hydratedRuns = [];

      for (const item of rows) {
        const rawRunId = item.sourceEventId || item.id;
        const safeRunId = sanitizeString(String(rawRunId || '').slice(0, 12), 32);
        if (!safeRunId) continue;

        const chatRef = anonymizeChatId(item.chatId, this.salt);
        const scope = VALID_SCOPE_SET.has(item.scope) ? item.scope : 'personal';
        const startedAt = item.createdAt || new Date().toISOString();
        const updatedAt = item.updatedAt || startedAt;
        const modelUsage = Array.isArray(item.modelUsage) ? item.modelUsage : [];
        const steps = Array.isArray(item.steps) ? item.steps : [];
        const primaryModel = modelUsage[modelUsage.length - 1] || modelUsage[0] || null;

        const totalLatencyMs = modelUsage.reduce((acc, m) => acc + Math.max(0, Number(m.latencyMs || 0)), 0);
        const totalIn = modelUsage.reduce((acc, m) => acc + Math.max(0, Number(m.inputTokens || 0)), 0);
        const totalOut = modelUsage.reduce((acc, m) => acc + Math.max(0, Number(m.outputTokens || 0)), 0);
        const totalToolMs = steps.reduce((acc, s) => acc + Math.max(0, Number(s.durationMs || 0)), 0);

        const mappedStatus = item.status === 'failed'
          ? 'failed'
          : (item.status === 'awaiting_approval' ? 'waiting_approval' : 'completed');

        const stages = {
          ingress: { phase: 'completed', label: 'Webhook WAHA diterima', startedAt, completedAt: startedAt, durationMs: null, meta: {} },
          queue: { phase: 'completed', label: 'Antrean SQLite WAL diklaim', startedAt, completedAt: startedAt, durationMs: null, meta: {} },
          gate: { phase: 'completed', label: 'Verifikasi scope & presence', startedAt, completedAt: startedAt, durationMs: null, meta: { isGroup: scope === 'group' } },
          multimodal: { phase: 'bypassed', label: 'Riwayat historis media/teks', startedAt, completedAt: startedAt, durationMs: null, meta: { bypassed: true } },
          context: { phase: 'completed', label: 'Memori & konteks dimuat', startedAt, completedAt: startedAt, durationMs: null, meta: {} },
          llm: {
            phase: item.status === 'failed' ? 'failed' : 'completed',
            label: primaryModel ? `Model ${sanitizeString(primaryModel.modelId, 60)}` : 'Penalaran model Sumopod',
            startedAt,
            completedAt: updatedAt,
            durationMs: totalLatencyMs || null,
            meta: sanitizeMeta({
              modelId: primaryModel?.modelId,
              modelTier: item.modelTier || primaryModel?.tier,
              round: modelUsage.length || 1,
              inputTokens: totalIn,
              outputTokens: totalOut,
              latencyMs: totalLatencyMs
            })
          },
          tools: steps.length > 0
            ? {
                phase: steps.some((s) => s.status === 'failed') ? 'failed' : 'completed',
                label: `${steps.length} eksekusi tool`,
                startedAt,
                completedAt: updatedAt,
                durationMs: totalToolMs || null,
                meta: sanitizeMeta({
                  toolName: steps[steps.length - 1]?.toolName,
                  toolGroup: resolveToolGroup(null, steps[steps.length - 1]?.toolName),
                  toolCount: steps.length
                })
              }
            : { phase: 'bypassed', label: 'Tanpa pemanggilan tool', startedAt, completedAt: startedAt, durationMs: null, meta: { bypassed: true } },
          delivery: {
            phase: item.responseStatus === 'sent' || mappedStatus === 'completed' ? 'completed' : (mappedStatus === 'failed' ? 'failed' : 'waiting'),
            label: item.responseStatus === 'sent' ? 'Balasan terkirim ke WhatsApp' : `Status respons: ${sanitizeString(item.responseStatus, 24) || mappedStatus}`,
            startedAt: updatedAt,
            completedAt: updatedAt,
            durationMs: null,
            meta: sanitizeMeta({ outputMode: 'text' })
          }
        };

        const timeline = [
          { seq: 0, ts: startedAt, stage: 'ingress', phase: 'completed', label: stages.ingress.label, meta: {} },
          { seq: 0, ts: startedAt, stage: 'queue', phase: 'started', label: stages.queue.label, meta: {} },
          { seq: 0, ts: startedAt, stage: 'gate', phase: 'completed', label: stages.gate.label, meta: stages.gate.meta },
          { seq: 0, ts: startedAt, stage: 'multimodal', phase: 'bypassed', label: stages.multimodal.label, meta: { bypassed: true } },
          { seq: 0, ts: startedAt, stage: 'context', phase: 'completed', label: stages.context.label, meta: {} },
          { seq: 0, ts: startedAt, stage: 'llm', phase: stages.llm.phase, label: stages.llm.label, meta: stages.llm.meta },
          ...(steps.length > 0
            ? steps.map((s) => ({
                seq: 0,
                ts: s.createdAt || updatedAt,
                stage: 'tools',
                phase: s.status === 'failed' ? 'failed' : 'completed',
                label: `Tool ${sanitizeString(s.toolName, 48)}`,
                meta: sanitizeMeta({
                  toolName: s.toolName,
                  toolGroup: resolveToolGroup(null, s.toolName),
                  durationMs: s.durationMs
                })
              }))
            : [{ seq: 0, ts: startedAt, stage: 'tools', phase: 'bypassed', label: 'Tanpa pemanggilan tool', meta: { bypassed: true } }]),
          { seq: 0, ts: updatedAt, stage: 'delivery', phase: stages.delivery.phase, label: stages.delivery.label, meta: stages.delivery.meta }
        ];

        hydratedRuns.push({
          runId: safeRunId,
          chatRef,
          scope,
          startedAt,
          updatedAt,
          currentStage: 'delivery',
          status: mappedStatus,
          inputKind: 'text',
          taskClass: null,
          modelTier: item.modelTier || primaryModel?.tier || null,
          modelId: primaryModel?.modelId || null,
          outputMode: 'text',
          ttsUsed: false,
          hydrated: true,
          stages,
          timeline
        });
      }

      if (hydratedRuns.length > 0) {
        this.recentRuns = hydratedRuns.slice(0, this.maxRuns);
      }
      return hydratedRuns.length;
    } catch {
      return 0;
    }
  }

  getSnapshotData() {
    this._sweepStaleActiveRuns();
    return {
      activeRuns: [...this.activeRuns.values()].map(cloneRunForOutput),
      recentRuns: this.recentRuns.map(cloneRunForOutput),
      recentEvents: this.events.slice(-40)
    };
  }
}

module.exports = {
  PipelineEventBus,
  PIPELINE_STAGES,
  VALID_STAGE_SET,
  VALID_PHASE_SET,
  anonymizeChatId,
  sanitizeMeta,
  resolveToolGroup
};
