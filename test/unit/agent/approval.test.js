const test = require('node:test');
const assert = require('node:assert/strict');
const { ApprovalManager } = require('../../../src/agent/approval-manager');

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

test('pre-send validation and missing file return failed rather than uncertain', async () => {
  const finished = [];
  const db = {
    claimApproval: (id) => id === 'bad-target'
      ? { tool_name: 'send_whatsapp_message', arguments: { targetId: 'invalid', message: 'Hi' } }
      : { tool_name: 'send_whatsapp_file', arguments: { targetId: '6282@c.us', filePath: '/no/such/bubu-missing-file.pdf', filename: 'a.pdf' } },
    finishApproval: (...args) => finished.push(args)
  };
  const manager = new ApprovalManager({
    db, ownerJid: '6281@c.us',
    waha: { sendText: async () => assert.fail('must not send'), sendFile: async () => assert.fail('must not send') }
  });

  const badTarget = await manager.resolve({ id: 'bad-target', actorId: '6281@c.us', approved: true });
  assert.deepEqual(badTarget, { ok: false, reason: 'invalid_target' });
  assert.equal(finished[0][1], 'failed');

  const missingFile = await manager.resolve({ id: 'missing-file', actorId: '6281@c.us', approved: true });
  assert.deepEqual(missingFile, { ok: false, reason: 'missing_file' });
  assert.equal(finished[1][1], 'failed');
});

test('approved message forwards optional replyTo to WhatsApp delivery', async () => {
  const sent = [];
  const db = {
    claimApproval: () => ({ tool_name: 'send_whatsapp_message', arguments: { targetId: '6282@c.us', message: 'Balasan', replyTo: 'orig-msg-9' } }),
    finishApproval: () => {}
  };
  const manager = new ApprovalManager({
    db, ownerJid: '6281@c.us',
    waha: { sendText: async (text, chatId, opts) => sent.push({ text, chatId, opts }) }
  });
  const res = await manager.resolve({ id: 'ap-reply', actorId: '6281@c.us', approved: true });
  assert.equal(res.sent, true);
  assert.deepEqual(sent, [{ text: 'Balasan', chatId: '6282@c.us', opts: { replyTo: 'orig-msg-9' } }]);
});
