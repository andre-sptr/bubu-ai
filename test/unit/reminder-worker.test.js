const test = require('node:test');
const assert = require('node:assert/strict');
const { ReminderWorker } = require('../../src/workers/reminder-worker');

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
