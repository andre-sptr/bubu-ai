const test = require('node:test');
const assert = require('node:assert/strict');
const { ReminderWorker } = require('../../../src/workers/reminder-worker');

test('reminder worker sends through the shared response handler and records success', async () => {
  const sent = [];
  let finished = null;
  const worker = new ReminderWorker({
    db: {
      recoverStaleReminders: () => 0,
      claimDueReminders: () => [{ id: 1, chat_id: 'chat@c.us', message: 'Meeting dimulai.' }],
      finishReminder: (...args) => { finished = args; }
    },
    responseHandler: {
      sendText: async (...args) => { sent.push(args); return { ok: true, type: 'text' }; }
    },
    logger: { error: () => {} }
  });

  await worker.tick();

  assert.deepEqual(sent, [['⏰ *Reminder Bubu*\n\nMeeting dimulai.', 'chat@c.us', { format: false }]]);
  assert.deepEqual(finished, [1, true]);
});

test('reminder worker records uncertain delivery when shared handler fails', async () => {
  let finished = null;
  const worker = new ReminderWorker({
    db: {
      claimDueReminders: () => [{ id: 2, chat_id: 'chat@c.us', message: 'Reminder.' }],
      finishReminder: (...args) => { finished = args; }
    },
    responseHandler: {
      sendText: async () => { throw new Error('delivery uncertain'); }
    },
    logger: { error: () => {} }
  });

  await worker.tick();
  assert.equal(finished[0], 2);
  assert.equal(finished[1], false);
  assert.equal(finished[2], 'delivery uncertain');
});

test('reminder worker reports isHealthy(), runs throttled periodic stale recovery in tick(), and stops cleanly', async () => {
  const recoveredCalls = [];
  const worker = new ReminderWorker({
    db: {
      recoverStaleReminders: (ms) => { recoveredCalls.push(ms); return 1; },
      claimDueReminders: () => []
    },
    responseHandler: { sendText: async () => ({ ok: true }) },
    logger: { warn: () => {}, error: () => {} },
    staleMs: 60000,
    staleSweepIntervalMs: 5000
  });

  assert.equal(worker.isHealthy(), true);
  await worker.tick();
  assert.deepEqual(recoveredCalls, [60000]);

  await worker.tick();
  assert.equal(recoveredCalls.length, 1);

  worker.lastStaleSweepAt = Date.now() - 6000;
  await worker.tick();
  assert.equal(recoveredCalls.length, 2);

  await worker.stop();
  assert.equal(worker.isHealthy(), false);
  await worker.tick();
  assert.equal(recoveredCalls.length, 2);
});

test('Stage 3: reminder worker reschedules recurring reminders on success, blocks reschedule on failure, and sends daily briefing once per day', async () => {
  const { computeNextRecurrenceIso, normalizeRecurrence } = require('../../../src/utils/recurrence');

  assert.equal(normalizeRecurrence('DAILY'), 'daily');
  assert.equal(normalizeRecurrence('every:2h'), 'every:2h');
  assert.throws(() => normalizeRecurrence('hourly-bad'), /Unsupported recurrence/);

  const sent = [];
  const rescheduled = [];
  const finished = [];
  const settings = new Map();
  let dueQueue = [
    { id: 10, chat_id: 'owner@c.us', message: 'Minum air', due_at: '2026-11-23T01:00:00.000Z', recurrence: 'every:2h' }
  ];

  const worker = new ReminderWorker({
    db: {
      claimDueReminders: () => {
        const out = dueQueue;
        dueQueue = [];
        return out;
      },
      rescheduleRecurringReminder: (id, nextDueAt) => {
        rescheduled.push({ id, nextDueAt });
        return true;
      },
      finishReminder: (...args) => finished.push(args),
      getAppSetting: (k) => settings.get(k) || null,
      setAppSetting: (k, v) => { settings.set(k, v); return true; },
      getDailyBriefingData: () => ({
        tasks: [{ id: 't1', title: 'Audit VPS', priority: 'high', due_at: '2026-11-23T05:00:00.000Z' }],
        reminders: [{ id: 10, message: 'Minum air', due_at: '2026-11-23T03:00:00.000Z', recurrence: 'every:2h' }],
        deadLetterCount: 1
      })
    },
    responseHandler: {
      sendText: async (text, chatId) => {
        sent.push({ text, chatId });
        return { ok: true };
      }
    },
    logger: { warn: () => {}, error: () => {} },
    timezone: 'Asia/Jakarta',
    briefingEnabled: true,
    briefingHour: 0,
    ownerJid: 'owner@c.us'
  });

  await worker.tick();
  assert.equal(rescheduled.length, 1);
  assert.equal(rescheduled[0].id, 10);
  assert.ok(Date.parse(rescheduled[0].nextDueAt) > Date.parse('2026-11-23T01:00:00.000Z'));
  assert.match(sent[0].text, /\(every:2h\)/);
  assert.match(sent[1].text, /Briefing Harian Bubu/);
  assert.match(sent[1].text, /Audit VPS/);
  assert.match(sent[1].text, /dead-letter: 1/);

  // Second tick same calendar day must NOT re-send briefing
  await worker.tick();
  assert.equal(sent.length, 2);

  // Delivery failure on recurring reminder marks failed/uncertain without rescheduling
  dueQueue = [{ id: 11, chat_id: 'owner@c.us', message: 'Standup', due_at: '2026-11-23T02:00:00.000Z', recurrence: 'daily' }];
  worker.responseHandler.sendText = async () => { throw new Error('waha timeout'); };
  await worker.tick();
  assert.equal(rescheduled.length, 1);
  assert.equal(finished.length, 1);
  assert.equal(finished[0][0], 11);
  assert.equal(finished[0][1], false);

  const nextMonthly = computeNextRecurrenceIso('2026-01-31T01:00:00.000Z', 'monthly', {
    nowMs: Date.parse('2026-01-31T02:00:00.000Z'),
    timezone: 'Asia/Jakarta'
  });
  assert.equal(nextMonthly.startsWith('2026-02-28'), true);
});
