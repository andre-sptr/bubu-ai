const { classifyOperationalError } = require('../utils/error-policy');

class InboxWorker {
  constructor({
    db, handler, logger, onDeadLetter = null,
    pollMs = 500, maxAttempts = 5, staleMs = 120000
  }) {
    this.db = db;
    this.handler = handler;
    this.logger = logger;
    this.onDeadLetter = onDeadLetter;
    this.pollMs = pollMs;
    this.maxAttempts = maxAttempts;
    this.staleMs = staleMs;
    this.running = false;
    this.stopped = false;
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
      this.logger.error?.({
        eventId: event.event_id,
        category: policy.category,
        error: notifyError.message
      }, 'Failed to notify user about terminal inbox failure');
    }
  }

  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const event = this.db.claimNextEvent();
      if (!event) return;
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
          this.logger.error?.(log, 'Inbox event moved to dead-letter state');
          await this.notifyDeadLetter(event, policy, error);
        } else {
          this.logger.warn?.(log, 'Inbox event scheduled for bounded retry');
        }
      }
    } finally {
      this.running = false;
    }
  }

  start() {
    const recovered = this.db.recoverStaleEvents(this.staleMs);
    if (recovered) {
      this.logger.warn({ recovered }, 'Recovered stale inbox events');
    }
    this.timer = setInterval(() => this.tick().catch((err) => this.logger.error(err)), this.pollMs);
    this.timer.unref?.();
    return this;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

module.exports = { InboxWorker };
