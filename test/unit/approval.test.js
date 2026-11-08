const test = require('node:test');
const assert = require('node:assert/strict');
const { ApprovalManager } = require('../../src/agent/approval-manager');

test('approval rejects non-owner', async () => {
  const manager = new ApprovalManager({ db: {}, waha: {}, ownerJid: '6281@c.us' });
  assert.deepEqual(await manager.resolve({ id: 'x', actorId: '6282@c.us', approved: true }), {
    ok: false, reason: 'not_owner'
  });
});

test('approval request is persisted and returns one prompt for the response outbox', async () => {
  let persisted = false;
  let sent = false;
  const db = { createApproval: () => { persisted = true; } };
  const waha = { sendText: async () => { sent = true; } };
  const manager = new ApprovalManager({ db, waha, ownerJid: '6281@c.us' });
  const result = await manager.create({
    taskId: 'task-1', chatId: '6281@c.us', requesterId: '6281@c.us',
    toolName: 'send_whatsapp_message',
    args: { targetId: '6282@c.us', message: 'Hi' }
  });
  assert.equal(persisted, true);
  assert.equal(sent, false);
  assert.equal(result.pendingApproval, true);
  assert.match(result.prompt, /approve/);
});

test('approved send executes exactly once and records success', async () => {
  let sends = 0;
  let finished = null;
  const db = {
    claimApproval: () => ({ tool_name: 'send_whatsapp_message', arguments: { targetId: '6282@c.us', message: 'Hi' } }),
    finishApproval: (...args) => { finished = args; }
  };
  const manager = new ApprovalManager({
    db, ownerJid: '6281@c.us',
    waha: { sendText: async () => { sends++; } }
  });
  const result = await manager.resolve({ id: 'ap1', actorId: '6281@c.us', approved: true });
  assert.equal(result.sent, true);
  assert.equal(sends, 1);
  assert.equal(finished[1], 'approved');
});

test('ambiguous outbound error is not retried automatically', async () => {
  let sends = 0;
  let finished = null;
  const db = {
    claimApproval: () => ({ tool_name: 'send_whatsapp_message', arguments: { targetId: '6282@c.us', message: 'Hi' } }),
    finishApproval: (...args) => { finished = args; }
  };
  const manager = new ApprovalManager({
    db, ownerJid: '6281@c.us',
    waha: { sendText: async () => { sends++; throw new Error('timeout'); } }
  });
  const result = await manager.resolve({ id: 'ap1', actorId: '6281@c.us', approved: true });
  assert.equal(result.reason, 'send_result_uncertain');
  assert.equal(sends, 1);
  assert.equal(finished[1], 'uncertain');
});
