const { classifyOperationalError } = require('../utils/error-policy');

class InboxWorker {
  constructor({
    db, handler, logger, onDeadLetter = null,
    pollMs = 500, maxAttempts = 5, staleMs = 120000,
    staleSweepIntervalMs = 30000,
    maxConcurrentJobs = 1,
    pruneIntervalMs = 3600000
  }) {
    this.db = db;
    this.handler = handler;
    this.logger = logger;
    this.onDeadLetter = onDeadLetter;
    this.pollMs = pollMs;
    this.maxAttempts = maxAttempts;
    this.staleMs = staleMs;
    this.staleSweepIntervalMs = staleSweepIntervalMs;
    this.maxConcurrentJobs = Math.max(1, Number(maxConcurrentJobs) || 1);
    const parsedPrune = (pruneIntervalMs === null || pruneIntervalMs === undefined || pruneIntervalMs === '')
      ? 3600000
      : Number(pruneIntervalMs);
    this.pruneIntervalMs = Number.isFinite(parsedPrune) && parsedPrune >= 0 ? parsedPrune : 3600000;
    this.lastStaleSweepAt = 0;
    this.lastPruneAt = 0;
    this.activeCount = 0;
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
      recovered = this.db.recoverStaleEvents?.(this.staleMs) || 0;
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
          pruned.deletedAuditLogs
        )) {
          this.logger?.info?.(pruned, 'Pruned expired queue and telemetry history');
        }
      } catch (error) {
        this.logger?.warn?.({ error: error?.message }, 'Periodic queue/history prune failed');
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
    try {
      await this.handler(event.payload);
      this.db.finishEvent(event.event_id);
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
