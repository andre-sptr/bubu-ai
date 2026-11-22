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

test('approved message forwards optional mentions alongside replyTo to WhatsApp delivery', async () => {
  const sent = [];
  const db = {
    claimApproval: (id) => id === 'ap-mentions-only'
      ? {
          tool_name: 'send_whatsapp_message',
          arguments: { targetId: '120363@g.us', message: 'Halo @6283', mentions: ['6283@c.us'] }
        }
      : {
          tool_name: 'send_whatsapp_message',
          arguments: { targetId: '120363@g.us', message: 'Halo tim', replyTo: 'm-1', mentions: ['6283@c.us', '6284@c.us'] }
        },
    finishApproval: () => {}
  };
  const manager = new ApprovalManager({
    db,
    ownerJid: '6281@c.us',
    waha: { sendText: async (text, chatId, opts) => sent.push({ text, chatId, opts }) }
  });

  const res1 = await manager.resolve({ id: 'ap-mentions-only', actorId: '6281@c.us', approved: true });
  assert.equal(res1.sent, true);
  assert.deepEqual(sent[0], {
    text: 'Halo @6283',
    chatId: '120363@g.us',
    opts: { mentions: ['6283@c.us'] }
  });

  const res2 = await manager.resolve({ id: 'ap-both', actorId: '6281@c.us', approved: true });
  assert.equal(res2.sent, true);
  assert.deepEqual(sent[1], {
    text: 'Halo tim',
    chatId: '120363@g.us',
    opts: { replyTo: 'm-1', mentions: ['6283@c.us', '6284@c.us'] }
  });
});

test('ApprovalManager formats prompts, validates arguments, and sends approved poll, location, and contact vCard', async () => {
  const created = [];
  const finished = [];
  const deliveries = [];
  const items = new Map();

  const db = {
    createApproval: (item) => {
      created.push(item);
      items.set(item.id, { tool_name: item.toolName, arguments: item.arguments });
    },
    claimApproval: (id) => items.get(id) || null,
    finishApproval: (...args) => finished.push(args)
  };
  const waha = {
    sendPoll: async (chatId, poll) => { deliveries.push({ type: 'poll', chatId, poll }); return { id: 'p1' }; },
    sendLocation: async (chatId, loc) => { deliveries.push({ type: 'location', chatId, loc }); return { id: 'l1' }; },
    sendContactVcard: async (chatId, contacts, options) => { deliveries.push({ type: 'contact', chatId, contacts, options }); return { id: 'c1' }; }
  };
  const manager = new ApprovalManager({ db, waha, ownerJid: '6281@c.us' });

  // 1. send_whatsapp_poll
  const pollReq = await manager.create({
    taskId: 't-poll',
    chatId: '6281@c.us',
    requesterId: '6281@c.us',
    toolName: 'send_whatsapp_poll',
    args: {
      targetId: '120363@g.us',
      question: 'Jadwal rapat?',
      options: ['Senin', 'Selasa'],
      multipleAnswers: true,
      replyTo: 'msg-0'
    }
  });
  assert.match(pollReq.prompt, /Konfirmasi pengiriman polling Bubu/);
  assert.match(pollReq.prompt, /Jadwal rapat\?/);
  const pollRes = await manager.resolve({ id: pollReq.approvalId, actorId: '6281@c.us', approved: true });
  assert.deepEqual(pollRes, { ok: true, sent: true });
  assert.deepEqual(deliveries[0], {
    type: 'poll',
    chatId: '120363@g.us',
    poll: { name: 'Jadwal rapat?', options: ['Senin', 'Selasa'], multipleAnswers: true, replyTo: 'msg-0' }
  });

  // 2. send_whatsapp_location
  const locReq = await manager.create({
    taskId: 't-loc',
    chatId: '6281@c.us',
    requesterId: '6281@c.us',
    toolName: 'send_whatsapp_location',
    args: {
      targetId: '6282@s.whatsapp.net',
      latitude: -6.1754,
      longitude: 106.8272,
      title: 'Monas',
      replyTo: 'msg-loc'
    }
  });
  assert.match(locReq.prompt, /Konfirmasi pengiriman lokasi Bubu/);
  assert.match(locReq.prompt, /-6\.1754, 106\.8272/);
  const locRes = await manager.resolve({ id: locReq.approvalId, actorId: '6281@c.us', approved: true });
  assert.deepEqual(locRes, { ok: true, sent: true });
  assert.deepEqual(deliveries[1], {
    type: 'location',
    chatId: '6282@c.us',
    loc: { latitude: -6.1754, longitude: 106.8272, title: 'Monas', replyTo: 'msg-loc' }
  });

  // 3. send_whatsapp_contact
  const contactReq = await manager.create({
    taskId: 't-contact',
    chatId: '6281@c.us',
    requesterId: '6281@c.us',
    toolName: 'send_whatsapp_contact',
    args: {
      targetId: '6282@c.us',
      fullName: 'Budi Santoso',
      phoneNumber: '+628123456789',
      organization: 'PT Bubu',
      replyTo: 'msg-c'
    }
  });
  assert.match(contactReq.prompt, /Konfirmasi pengiriman kontak Bubu/);
  assert.match(contactReq.prompt, /Budi Santoso/);
  const contactRes = await manager.resolve({ id: contactReq.approvalId, actorId: '6281@c.us', approved: true });
  assert.deepEqual(contactRes, { ok: true, sent: true });
  assert.deepEqual(deliveries[2], {
    type: 'contact',
    chatId: '6282@c.us',
    contacts: [{ fullName: 'Budi Santoso', phoneNumber: '+628123456789', organization: 'PT Bubu' }],
    options: { replyTo: 'msg-c' }
  });

  // 4. Pre-send validation failures mark failed without calling WAHA
  items.set('bad-poll', {
    tool_name: 'send_whatsapp_poll',
    arguments: { targetId: '120363@g.us', question: 'Q', options: ['Same', 'same'] }
  });
  items.set('bad-loc', {
    tool_name: 'send_whatsapp_location',
    arguments: { targetId: '6282@c.us', latitude: 95, longitude: 106.8 }
  });
  items.set('bad-contact', {
    tool_name: 'send_whatsapp_contact',
    arguments: { targetId: '6282@c.us', fullName: 'Budi', phoneNumber: '123' }
  });

  assert.deepEqual(await manager.resolve({ id: 'bad-poll', actorId: '6281@c.us', approved: true }), {
    ok: false,
    reason: 'invalid_arguments'
  });
  assert.deepEqual(await manager.resolve({ id: 'bad-loc', actorId: '6281@c.us', approved: true }), {
    ok: false,
    reason: 'invalid_arguments'
  });
  assert.deepEqual(await manager.resolve({ id: 'bad-contact', actorId: '6281@c.us', approved: true }), {
    ok: false,
    reason: 'invalid_arguments'
  });
  assert.equal(deliveries.length, 3);
});

test('Stage 3: /approvals lists active items and /approve or /deny works without ID when exactly one pending approval exists', async () => {
  const { handleSlashCommand, RECOGNIZED_SLASH_COMMANDS } = require('../../../src/agent/command-handler');
  assert.equal(RECOGNIZED_SLASH_COMMANDS.has('/approvals'), true);

  const sent = [];
  const resolved = [];
  let pending = [
    {
      id: 'solo1234',
      tool_name: 'send_whatsapp_message',
      arguments: { targetId: '628222@c.us', message: 'Halo tim' },
      expires_at: new Date(Date.now() + 180000).toISOString()
    }
  ];
  const processor = {
    config: { ownerJid: '6281@c.us', appTimezone: 'Asia/Jakarta' },
    responseHandler: { sendText: async (text, chatId) => sent.push({ text, chatId }) },
    approvalManager: {
      resolve: async (req) => {
        resolved.push(req);
        pending = pending.filter((p) => p.id !== req.id);
        return { ok: true, sent: req.approved };
      }
    },
    db: {
      listPendingApprovalsDetailed: () => pending,
      addMessage: () => true
    }
  };

  // /approvals lists the single pending approval
  await handleSlashCommand(processor, {
    text: '/approvals', msg: { chatId: '6281@c.us' }, senderId: '6281@c.us', owner: true, isGroup: false, scope: 'personal', eventId: 'e1'
  });
  assert.match(sent[0].text, /Persetujuan Tertunda \(1\)/);
  assert.match(sent[0].text, /solo1234/);
  assert.match(sent[0].text, /628222@c\.us/);

  // /approve without ID auto-resolves single active item
  await handleSlashCommand(processor, {
    text: '/approve', msg: { chatId: '6281@c.us' }, senderId: '6281@c.us', owner: true, isGroup: false, scope: 'personal', eventId: 'e2'
  });
  assert.deepEqual(resolved[0], { id: 'solo1234', actorId: '6281@c.us', approved: true });
  assert.match(sent[1].text, /Persetujuan solo1234 berhasil/);

  // Multiple pending -> lists options without executing
  pending = [
    { id: 'aa11', tool_name: 'send_whatsapp_message', arguments: { targetId: '6283@c.us', message: 'Satu' }, expires_at: new Date(Date.now() + 60000).toISOString() },
    { id: 'bb22', tool_name: 'send_whatsapp_file', arguments: { targetId: '6284@c.us', filename: 'lap.pdf' }, expires_at: new Date(Date.now() + 60000).toISOString() }
  ];
  await handleSlashCommand(processor, {
    text: '/deny', msg: { chatId: '6281@c.us' }, senderId: '6281@c.us', owner: true, isGroup: false, scope: 'personal', eventId: 'e3'
  });
  assert.equal(resolved.length, 1);
  assert.match(sent[2].text, /Ada 2 persetujuan aktif/);
  assert.match(sent[2].text, /aa11/);
  assert.match(sent[2].text, /bb22/);

  // Single pending -> /deny without ID denies it
  pending = [pending[0]];
  await handleSlashCommand(processor, {
    text: '/deny', msg: { chatId: '6281@c.us' }, senderId: '6281@c.us', owner: true, isGroup: false, scope: 'personal', eventId: 'e4'
  });
  assert.deepEqual(resolved[1], { id: 'aa11', actorId: '6281@c.us', approved: false });
  assert.match(sent[3].text, /dibatalkan/);
});
