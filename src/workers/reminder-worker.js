const { ResponseHandler } = require('../channels/response-handler');

class ReminderWorker {
  constructor({ db, waha, responseHandler = null, logger, pollMs = 5000 }) {
    this.db = db;
    this.waha = waha;
    this.responseHandler = responseHandler || new ResponseHandler({ waha, logger });
    this.logger = logger;
    this.pollMs = pollMs;
    this.running = false;
  }

  start() {
    this.db.recoverStaleReminders();
    this.timer = setInterval(() => this.tick().catch((e) => this.logger.error(e)), this.pollMs);
    this.timer.unref?.();
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const reminder of this.db.claimDueReminders()) {
        try {
          await this.responseHandler.sendText(`⏰ *Reminder Bubu*\n\n${reminder.message}`, reminder.chat_id, { format: false });
          this.db.finishReminder(reminder.id, true);
        } catch (error) {
          this.db.finishReminder(reminder.id, false, error.message);
          this.logger.error({ reminderId: reminder.id, err: error }, 'Reminder delivery failed');
        }
      }
    } finally {
      this.running = false;
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

module.exports = { ReminderWorker };
