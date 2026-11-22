const { ResponseHandler } = require('../channels/response-handler');
const { computeNextRecurrenceIso, getLocalDateParts } = require('../utils/recurrence');

function formatClock(iso, timezone) {
  try {
    return new Date(iso).toLocaleTimeString('id-ID', {
      timeZone: timezone || 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return String(iso || '');
  }
}

class ReminderWorker {
  constructor({
    db,
    waha,
    responseHandler = null,
    logger,
    pollMs = 5000,
    staleMs = 120000,
    staleSweepIntervalMs = 30000,
    timezone = 'Asia/Jakarta',
    briefingEnabled = false,
    briefingHour = 7,
    ownerJid = ''
  }) {
    this.db = db;
    this.waha = waha;
    this.responseHandler = responseHandler || new ResponseHandler({ waha, logger });
    this.logger = logger;
    this.pollMs = pollMs;
    this.staleMs = staleMs;
    this.staleSweepIntervalMs = staleSweepIntervalMs;
    this.timezone = String(timezone || 'Asia/Jakarta').trim() || 'Asia/Jakarta';
    this.briefingEnabled = Boolean(briefingEnabled);
    this.briefingHour = Number.isInteger(Number(briefingHour)) ? Number(briefingHour) : 7;
    this.ownerJid = String(ownerJid || '').trim();
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

  async maybeSendDailyBriefing(nowMs = Date.now()) {
    if (!this.briefingEnabled || !this.ownerJid) return false;
    if (typeof this.db?.getDailyBriefingData !== 'function') return false;

    const { dateKey, hour } = getLocalDateParts(nowMs, this.timezone);
    if (hour < this.briefingHour) return false;

    if (typeof this.db.getAppSetting === 'function' && this.db.getAppSetting('daily_briefing_last_date') === dateKey) {
      return false;
    }

    const data = this.db.getDailyBriefingData({
      ownerId: this.ownerJid,
      chatId: this.ownerJid,
      nowMs
    });
    if (!data) return false;

    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const reminders = Array.isArray(data.reminders) ? data.reminders : [];
    const deadLetterCount = Number(data.deadLetterCount || 0);

    const lines = [`☀️ *Briefing Harian Bubu* (${dateKey})`];
    if (tasks.length > 0) {
      lines.push('', '*Tugas Prioritas / Jatuh Tempo:*');
      for (const t of tasks.slice(0, 6)) {
        const dueLabel = t.due_at ? ` (${formatClock(t.due_at, this.timezone)})` : '';
        lines.push(`• [${t.priority}] ${t.title}${dueLabel}`);
      }
    } else {
      lines.push('', '• Tidak ada tugas mendesak atau jatuh tempo dalam 24 jam ke depan.');
    }

    if (reminders.length > 0) {
      lines.push('', '*Reminder 24 Jam ke Depan:*');
      for (const r of reminders.slice(0, 6)) {
        const rec = r.recurrence ? ` [${r.recurrence}]` : '';
        lines.push(`• ${formatClock(r.due_at, this.timezone)}${rec}: ${r.message}`);
      }
    }

    if (deadLetterCount > 0) {
      lines.push('', `⚠️ Antrean dead-letter: ${deadLetterCount} event (cek /queue dead).`);
    }

    // Persist sent marker before delivery so restarts never duplicate morning digests.
    this.db.setAppSetting?.('daily_briefing_last_date', dateKey);
    try {
      await this.responseHandler.sendText(lines.join('\n'), this.ownerJid, { format: false });
      return true;
    } catch (error) {
      this.logger?.error?.({ err: error, dateKey }, 'Daily briefing delivery failed');
      return false;
    }
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
          const text = reminder.recurrence
            ? `⏰ *Reminder Bubu* (${reminder.recurrence})\n\n${reminder.message}`
            : `⏰ *Reminder Bubu*\n\n${reminder.message}`;
          await this.responseHandler.sendText(text, reminder.chat_id, { format: false });
          if (reminder.recurrence && typeof this.db.rescheduleRecurringReminder === 'function') {
            const nextDueAt = computeNextRecurrenceIso(reminder.due_at, reminder.recurrence, {
              timezone: this.timezone
            });
            if (nextDueAt) {
              this.db.rescheduleRecurringReminder(reminder.id, nextDueAt);
            } else {
              this.db.finishReminder(reminder.id, true);
            }
          } else {
            this.db.finishReminder(reminder.id, true);
          }
        } catch (error) {
          this.db.finishReminder(reminder.id, false, error.message);
          this.logger?.error?.({ reminderId: reminder.id, err: error }, 'Reminder delivery failed');
        }
      }
      await this.maybeSendDailyBriefing();
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
