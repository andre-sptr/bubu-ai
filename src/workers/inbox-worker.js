const { classifyOperationalError } = require('../utils/error-policy');
const { cleanupOrphanStorageFiles } = require('../utils/storage-cleanup');

class InboxWorker {
  constructor({
    db, handler, logger, onDeadLetter = null,
    pollMs = 500, maxAttempts = 5, staleMs = 120000,
    staleSweepIntervalMs = 30000,
    maxConcurrentJobs = 1,
    pruneIntervalMs = 3600000,
    heartbeatIntervalMs = null,
    storageDir = null,
    pipelineEvents = null
  }) {
    this.db = db;
    this.handler = handler;
    this.logger = logger;
    this.onDeadLetter = onDeadLetter;
    this.pipelineEvents = pipelineEvents;
    this.pollMs = pollMs;
    this.maxAttempts = maxAttempts;
    this.staleMs = staleMs;
    this.staleSweepIntervalMs = staleSweepIntervalMs;
    this.maxConcurrentJobs = Math.max(1, Number(maxConcurrentJobs) || 1);
    const parsedPrune = (pruneIntervalMs === null || pruneIntervalMs === undefined || pruneIntervalMs === '')
      ? 3600000
      : Number(pruneIntervalMs);
    this.pruneIntervalMs = Number.isFinite(parsedPrune) && parsedPrune >= 0 ? parsedPrune : 3600000;
    const defaultHeartbeat = Math.max(5000, Math.min(30000, Math.floor((Number(staleMs) || 120000) / 3)));
    const parsedHeartbeat = (heartbeatIntervalMs === null || heartbeatIntervalMs === undefined || heartbeatIntervalMs === '')
      ? defaultHeartbeat
      : Number(heartbeatIntervalMs);
    this.heartbeatIntervalMs = Number.isFinite(parsedHeartbeat) && parsedHeartbeat > 0 ? parsedHeartbeat : defaultHeartbeat;
    this.storageDir = storageDir || null;
    this.lastStaleSweepAt = 0;
    this.lastPruneAt = 0;
    this.activeCount = 0;
    this.inFlightEventIds = new Set();
    this.running = false;
    this.stopped = false;
  }

  isHealthy() {
    return !this.stopped;
  }

  getStats() {
    return {
      activeCount: this.activeCount,
      maxConcurrentJobs: this.maxConcurrentJobs,
      healthy: this.isHealthy(),
      queue: this.db.getQueueStats?.() || null
    };
  }

  sweepStaleIfDue(now = Date.now()) {
    let recovered = 0;
    if (now - this.lastStaleSweepAt >= this.staleSweepIntervalMs) {
      this.lastStaleSweepAt = now;
      recovered = (this.inFlightEventIds.size > 0
        ? this.db.recoverStaleEvents?.(this.staleMs, { excludeEventIds: [...this.inFlightEventIds] })
        : this.db.recoverStaleEvents?.(this.staleMs)) || 0;
      const recoveredApprovals = this.db.recoverStaleApprovals?.(this.staleMs) || 0;
      const recoveredTools = this.db.recoverStaleToolExecutions?.(this.staleMs) || 0;
      const recoveredResponses = this.db.recoverStaleTaskResponses?.(this.staleMs) || 0;
      if (recovered || recoveredApprovals || recoveredTools || recoveredResponses) {
        this.logger?.warn?.({
          recovered,
          recoveredApprovals,
          recoveredTools,
          recoveredResponses
        }, 'Recovered stale inbox/task state');
      }
    }

    if (this.pruneIntervalMs > 0 && now - this.lastPruneAt >= this.pruneIntervalMs) {
      this.lastPruneAt = now;
      try {
        const pruned = this.db.pruneHistoryAndQueue?.();
        if (pruned && (
          pruned.deletedCompletedEvents ||
          pruned.deletedDeadEvents ||
          pruned.deletedModelUsage ||
          pruned.deletedAuditLogs ||
          pruned.deletedTasks ||
          pruned.deletedToolExecutions ||
          pruned.deletedApprovals ||
          pruned.deletedMemoryExtractions ||
          pruned.deletedRateLimitEvents
        )) {
          this.logger?.info?.(pruned, 'Pruned expired queue and telemetry history');
        }
      } catch (error) {
        this.logger?.warn?.({ error: error?.message }, 'Periodic queue/history prune failed');
      }

      if (this.storageDir) {
        try {
          cleanupOrphanStorageFiles({
            db: this.db,
            storageDir: this.storageDir,
            logger: this.logger
          });
        } catch (error) {
          this.logger?.warn?.({ error: error?.message }, 'Periodic orphan storage cleanup failed');
        }
      }
    }

    return recovered;
  }

  async notifyDeadLetter(event, policy, error) {
    if (!this.onDeadLetter || policy.category === 'delivery_uncertain') return;
    try {
      await this.onDeadLetter({
        event,
        category: policy.category,
        message: policy.userMessage
      });
    } catch (notifyError) {
      this.logger?.error?.({
        eventId: event.event_id,
        category: policy.category,
        error: notifyError.message
      }, 'Failed to notify user about terminal inbox failure');
    }
  }

  async _processEvent(event) {
    this.activeCount += 1;
    this.running = this.activeCount > 0;
    this.inFlightEventIds.add(event.event_id);
    const runId = String(event?.event_id || '').slice(0, 12);
    const scope = String(event?.chat_id || '').endsWith('@g.us') ? 'group' : 'personal';
    const queueStats = this.db.getQueueStats?.() || null;
    this.pipelineEvents?.emitStage?.({
      runId,
      stage: 'queue',
      phase: 'started',
      label: 'Worker mengklaim pesan dari antrean FIFO',
      chatId: event.chat_id,
      scope,
      meta: {
        priority: event.priority ?? 5,
        attempts: event.attempts ?? 1,
        ...(queueStats ? {
          queuePending: queueStats.pendingCount,
          queueProcessing: queueStats.processingCount,
          queueFailed: queueStats.failedCount,
          queueDead: queueStats.deadCount
        } : {})
      }
    });
    let heartbeatTimer = null;
    if (typeof this.db?.touchEventLock === 'function' && this.heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
        try {
          this.db.touchEventLock(event.event_id);
        } catch (err) {
          this.logger?.warn?.({ eventId: event.event_id, error: err?.message }, 'Inbox event lock heartbeat failed');
        }
      }, this.heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    }
    try {
      await this.handler(event.payload, {
        eventId: event.event_id,
        chatId: event.chat_id,
        senderId: event.sender_id
      });
      this.db.finishEvent(event.event_id);
      this.pipelineEvents?.emitStage?.({
        runId,
        stage: 'queue',
        phase: 'completed',
        label: 'Event antrean selesai diproses',
        chatId: event.chat_id,
        scope
      });
      this.pipelineEvents?.finalizeRunIfActive?.(runId, 'completed');
    } catch (error) {
      const policy = classifyOperationalError(error);
      const terminal = !policy.retryable || event.attempts >= this.maxAttempts;
      // Non-retryable errors are moved directly to dead-letter state.
      // Uncertain WAHA deliveries must never be replayed automatically.
      const attemptsForState = terminal ? this.maxAttempts : event.attempts;
      this.db.failEvent(
        event.event_id,
        `${policy.category}: ${error.message || 'Unknown error'}`,
        attemptsForState,
        this.maxAttempts
      );
      this.pipelineEvents?.emitStage?.({
        runId,
        stage: 'queue',
        phase: 'failed',
        label: terminal ? 'Event dipindahkan ke dead-letter' : 'Penjadwalan ulang retry terbatas',
        chatId: event.chat_id,
        scope,
        meta: {
          errorCategory: policy.category,
          attempts: event.attempts,
          terminal
        }
      });

      const log = {
        eventId: event.event_id,
        chatId: event.chat_id,
        attempts: event.attempts,
        maxAttempts: this.maxAttempts,
        category: policy.category,
        retryable: policy.retryable,
        terminal,
        err: error
      };
      if (terminal) {
        this.logger?.error?.(log, 'Inbox event moved to dead-letter state');
        await this.notifyDeadLetter(event, policy, error);
      } else {
        this.logger?.warn?.(log, 'Inbox event scheduled for bounded retry');
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      this.inFlightEventIds.delete(event.event_id);
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.running = this.activeCount > 0;
    }
  }

  async tick() {
    if (this.stopped || this.activeCount >= this.maxConcurrentJobs) return;
    this.sweepStaleIfDue();

    if (this.maxConcurrentJobs === 1) {
      const event = this.db.claimNextEvent();
      if (!event) return;
      await this._processEvent(event);
      return;
    }

    const availableSlots = Math.max(0, this.maxConcurrentJobs - this.activeCount);
    const events = [];
    for (let i = 0; i < availableSlots; i++) {
      if (this.stopped) break;
      const event = this.db.claimNextEvent();
      if (!event) break;
      events.push(event);
    }
    if (!events.length) return;
    await Promise.all(events.map((event) => this._processEvent(event)));
  }

  start() {
    this.stopped = false;
    const recovered = this.db.recoverStaleEvents?.(this.staleMs) || 0;
    if (recovered) {
      this.logger?.warn?.({ recovered }, 'Recovered stale inbox events');
    }
    this.lastStaleSweepAt = Date.now();
    this.timer = setInterval(() => this.tick().catch((err) => this.logger?.error?.(err)), this.pollMs);
    this.timer.unref?.();
    return this;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    while (this.running || this.activeCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

module.exports = { InboxWorker };
