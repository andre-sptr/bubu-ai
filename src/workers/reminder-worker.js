const { ResponseHandler } = require('../channels/response-handler');

class ReminderWorker {
  constructor({ db, waha, responseHandler = null, logger, pollMs = 5000, staleMs = 120000, staleSweepIntervalMs = 30000 }) {
    this.db = db;
    this.waha = waha;
    this.responseHandler = responseHandler || new ResponseHandler({ waha, logger });
    this.logger = logger;
    this.pollMs = pollMs;
    this.staleMs = staleMs;
    this.staleSweepIntervalMs = staleSweepIntervalMs;
    this.lastStaleSweepAt = 0;
    this.running = false;
    this.stopped = false;
  }

  isHealthy() {
    return !this.stopped;
  }

  sweepStaleIfDue(now = Date.now()) {
    if (now - this.lastStaleSweepAt < this.staleSweepIntervalMs) return 0;
    this.lastStaleSweepAt = now;
    const recovered = this.db.recoverStaleReminders?.(this.staleMs) || 0;
    if (recovered) {
      this.logger?.warn?.({ recovered }, 'Recovered stale reminders');
    }
    return recovered;
  }

  start() {
    this.stopped = false;
    const recovered = this.db.recoverStaleReminders?.(this.staleMs) || 0;
    if (recovered) {
      this.logger?.warn?.({ recovered }, 'Recovered stale reminders');
    }
    this.lastStaleSweepAt = Date.now();
    this.timer = setInterval(() => this.tick().catch((e) => this.logger?.error?.(e)), this.pollMs);
    this.timer.unref?.();
    return this;
  }

  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      this.sweepStaleIfDue();
      for (const reminder of this.db.claimDueReminders()) {
        try {
          await this.responseHandler.sendText(`⏰ *Reminder Bubu*\n\n${reminder.message}`, reminder.chat_id, { format: false });
          this.db.finishReminder(reminder.id, true);
        } catch (error) {
          this.db.finishReminder(reminder.id, false, error.message);
          this.logger?.error?.({ reminderId: reminder.id, err: error }, 'Reminder delivery failed');
        }
      }
    } finally {
      this.running = false;
    }
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

module.exports = { ReminderWorker };
