const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWahaTools } = require('../../../src/channels/waha/waha-tools');
const { createCoreTools, registerAllTools } = require('../../../src/agent/tool-registry');
const { ResponseHandler, ResponseDeliveryError } = require('../../../src/channels/response-handler');
const { WahaSessionMonitor } = require('../../../src/channels/waha/session-monitor');
const { AgentRuntime } = require('../../../src/agent/runtime');
const { MessageProcessor } = require('../../../src/agent/message-processor');
const { buildAgentMessages, SYSTEM_PROMPT } = require('../../../src/agent/prompt-builder');
const { createProductivityTools } = require('../../../src/productivity/productivity-tools');
const { DatabaseStore } = require('../../../src/db/database');

function makeWahaHarness({ sessionMonitor = null, approvalManager = null } = {}) {
  const calls = [];
  const approvals = [];
  const waha = {
    session: 'default',
    sendReaction: async (chatId, messageId, reaction) => {
      calls.push({ method: 'sendReaction', chatId, messageId, reaction });
      return { id: 'react-msg-1' };
    },
    sendPoll: async (chatId, poll) => {
      calls.push({ method: 'sendPoll', chatId, poll });
      return { id: 'poll-msg-1' };
    },
    sendLocation: async (chatId, loc) => {
      calls.push({ method: 'sendLocation', chatId, loc });
      return { id: 'loc-msg-1' };
    },
    sendContactVcard: async (chatId, contacts, options) => {
      calls.push({ method: 'sendContactVcard', chatId, contacts, options });
      return { id: 'contact-msg-1' };
    },
    sendLinkCustomPreview: async (chatId, payload) => {
      calls.push({ method: 'sendLinkCustomPreview', chatId, payload });
      return { id: 'link-msg-1' };
    },
    editMessage: async (chatId, messageId, text, options) => {
      calls.push({ method: 'editMessage', chatId, messageId, text, options });
      return { id: messageId };
    },
    deleteMessage: async (chatId, messageId) => {
      calls.push({ method: 'deleteMessage', chatId, messageId });
      return { id: messageId };
    },
    getGroupInfo: async (chatId) => {
      calls.push({ method: 'getGroupInfo', chatId });
      return { id: chatId, subject: 'Tim Produk', description: 'Diskusi mingguan' };
    },
    getGroupParticipants: async (chatId) => {
      calls.push({ method: 'getGroupParticipants', chatId });
      return [
        { id: '628111@c.us', isSuperAdmin: true },
        { id: '628222@c.us', isAdmin: true },
        { id: '628333@c.us' }
      ];
    },
    checkNumberStatus: async (phone) => {
      calls.push({ method: 'checkNumberStatus', phone });
      return { numberExists: true, chatId: `${phone}@c.us` };
    },
    getChatMessages: async (chatId, options) => {
      calls.push({ method: 'getChatMessages', chatId, options });
      return [
        { id: { _serialized: 'false_6281@c.us_M1' }, fromMe: false, timestamp: 1700000001, body: 'Pesan masuk', hasMedia: false },
        { id: 'true_6281@c.us_M2', fromMe: true, timestamp: 1700000002, body: 'Balasan Bubu', hasMedia: true }
      ];
    },
    sessionStatus: async () => {
      calls.push({ method: 'sessionStatus' });
      return { name: 'default', status: 'WORKING', me: { id: '628999@c.us', pushName: 'Bubu' } };
    }
  };
  const effectiveApprovalManager = approvalManager || {
    create: async (item) => {
      approvals.push(item);
      return { pendingApproval: true, approvalId: `ap-${approvals.length}`, prompt: `Approve ${item.toolName}` };
    }
  };
  const responseHandler = new ResponseHandler({ waha, logger: { info: () => {}, warn: () => {}, error: () => {} } });
  const tools = createWahaTools({
    waha,
    responseHandler,
    approvalManager: effectiveApprovalManager,
    sessionMonitor
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { waha, responseHandler, approvalManager: effectiveApprovalManager, tools, byName, calls, approvals };
}

test('registerAllTools includes all 14 Phase 4 WAHA tools while keeping createCoreTools intact', () => {
  const core = createCoreTools({ db: {}, approvalManager: {}, memoryService: null });
  assert.deepEqual([...core.tools.keys()], ['save_note', 'search_notes', 'create_reminder', 'send_whatsapp_message']);

  const { waha, responseHandler, approvalManager } = makeWahaHarness();
  const registry = registerAllTools({
    db: {},
    approvalManager,
    waha,
    responseHandler,
    sessionMonitor: new WahaSessionMonitor(),
    memoryService: null,
    documentService: {},
    webSearch: null,
    webFetch: null
  });
  for (const name of [
    'react_to_message',
    'send_poll',
    'send_location',
    'send_contact_card',
    'send_link_preview',
    'edit_bot_message',
    'delete_bot_message',
    'send_whatsapp_poll',
    'send_whatsapp_location',
    'send_whatsapp_contact',
    'get_group_info',
    'check_whatsapp_number',
    'get_waha_session_status',
    'list_recent_chat_messages'
  ]) {
    assert.ok(registry.get(name), `Expected ${name} to be registered`);
  }
  const personalNames = registry.list('personal').map((t) => t.name);
  const groupNames = registry.list('group').map((t) => t.name);
  assert.equal(personalNames.includes('get_group_info'), false);
  assert.equal(personalNames.includes('check_whatsapp_number'), true);
  assert.equal(personalNames.includes('get_waha_session_status'), true);
  assert.equal(personalNames.includes('list_recent_chat_messages'), true);
  assert.equal(personalNames.includes('send_whatsapp_poll'), true);
  assert.equal(personalNames.includes('send_whatsapp_location'), true);
  assert.equal(personalNames.includes('send_whatsapp_contact'), true);
  assert.equal(groupNames.includes('get_group_info'), true);
  assert.equal(groupNames.includes('check_whatsapp_number'), false);
  assert.equal(groupNames.includes('get_waha_session_status'), false);
  assert.equal(groupNames.includes('list_recent_chat_messages'), false);
  assert.equal(groupNames.includes('send_whatsapp_poll'), false);
  assert.equal(groupNames.includes('send_whatsapp_location'), false);
  assert.equal(groupNames.includes('send_whatsapp_contact'), false);
});

test('Phase 4 outbound tools enforce strict Zod schemas, target ctx.chatId, and route via ResponseHandler', async () => {
  const h = makeWahaHarness();

  // react_to_message defaults to ctx.incomingMessageId and rejects cross-chat messageIds & extra keys
  assert.throws(() => h.byName.react_to_message.schema.parse({ emoji: '👍', chatId: 'other@c.us' }));
  assert.throws(() => h.byName.react_to_message.schema.parse({ emoji: '   ' }));
  const reactRes = await h.byName.react_to_message.execute(
    h.byName.react_to_message.schema.parse({ emoji: '👍' }),
    { chatId: '123@g.us', scope: 'group', incomingMessageId: 'msg-in-1' }
  );
  assert.equal(reactRes.sent, true);
  assert.equal(reactRes.targetMessageId, 'msg-in-1');
  await assert.rejects(
    () => h.byName.react_to_message.execute(
      { emoji: '👍', messageId: 'false_999@c.us_XYZ' },
      { chatId: '123@g.us', scope: 'group', incomingMessageId: 'msg-in-1' }
    ),
    (err) => err.deliveryStatus === 'failed' && /different WhatsApp chat/i.test(err.message)
  );
  await assert.rejects(
    () => h.byName.react_to_message.execute({ emoji: '👍' }, { chatId: '123@g.us', scope: 'group' }),
    (err) => err.deliveryStatus === 'failed'
  );

  // send_poll validates uniqueness, length bounds 2-12, strict keys, question/name alias
  assert.throws(() => h.byName.send_poll.schema.parse({ question: 'Vote', options: ['OnlyOne'] }));
  assert.throws(() => h.byName.send_poll.schema.parse({ question: 'Vote', options: ['Ya', 'ya'] }));
  assert.throws(() => h.byName.send_poll.schema.parse({
    question: 'Vote',
    options: Array.from({ length: 13 }, (_, i) => `Opt ${i}`)
  }));
  assert.throws(() => h.byName.send_poll.schema.parse({ question: 'Vote', options: ['A', 'B'], targetId: 'other@c.us' }));
  const pollArgs = h.byName.send_poll.schema.parse({
    question: '**Makan siang?**',
    options: ['Nasi Goreng', 'Mie Ayam'],
    replyToCurrent: true
  });
  const pollRes = await h.byName.send_poll.execute(pollArgs, {
    chatId: '123@g.us', scope: 'group', incomingMessageId: 'msg-in-2'
  });
  assert.equal(pollRes.sent, true);
  assert.equal(pollRes.multipleAnswers, false);
  assert.equal(h.calls[1].method, 'sendPoll');
  assert.equal(h.calls[1].chatId, '123@g.us');
  assert.equal(h.calls[1].poll.replyTo, 'msg-in-2');

  // send_location validates coordinate bounds and strict keys
  assert.throws(() => h.byName.send_location.schema.parse({ latitude: 95, longitude: 106.8 }));
  assert.throws(() => h.byName.send_location.schema.parse({ latitude: -6.2, longitude: 185 }));
  assert.throws(() => h.byName.send_location.schema.parse({ latitude: -6.2, longitude: 106.8, chatId: 'evil@c.us' }));
  const locRes = await h.byName.send_location.execute(
    h.byName.send_location.schema.parse({ latitude: -6.2, longitude: 106.8, title: 'Monas', replyToCurrent: true }),
    { chatId: '6281@c.us', scope: 'personal', incomingMessageId: 'msg-in-3' }
  );
  assert.equal(locRes.sent, true);
  assert.equal(h.calls[2].loc.replyTo, 'msg-in-3');

  // send_contact_card validates phone digits and strict keys
  assert.throws(() => h.byName.send_contact_card.schema.parse({ fullName: 'Budi', phoneNumber: '123' }));
  assert.throws(() => h.byName.send_contact_card.schema.parse({ fullName: 'Budi', phoneNumber: '+628123456', extra: 1 }));
  const contactRes = await h.byName.send_contact_card.execute(
    h.byName.send_contact_card.schema.parse({ fullName: 'Budi', phoneNumber: '+62812345678', organization: 'PT Bubu' }),
    { chatId: '6281@c.us', scope: 'personal', incomingMessageId: 'msg-in-4' }
  );
  assert.equal(contactRes.sent, true);
  assert.deepEqual(h.calls[3].contacts, [{ fullName: 'Budi', phoneNumber: '+62812345678', organization: 'PT Bubu' }]);
});

test('Phase 4 read tools enforce scope isolation, participant bounding, and missing method fallbacks', async () => {
  const monitor = new WahaSessionMonitor({ session: 'default' });
  monitor.update({ session: 'default', status: 'WORKING' });
  const h = makeWahaHarness({ sessionMonitor: monitor });

  // get_group_info: group-only & @g.us only
  await assert.rejects(
    () => h.byName.get_group_info.execute({}, { chatId: '6281@c.us', scope: 'personal' }),
    /grup/i
  );
  const groupInfo = await h.byName.get_group_info.execute({}, { chatId: '120363@g.us', scope: 'group' });
  assert.equal(groupInfo.subject, 'Tim Produk');
  assert.equal(groupInfo.participantCount, 3);
  assert.equal(groupInfo.adminCount, 2);
  assert.equal(groupInfo.truncated, false);

  // Bounds participant list > 30 and works when getGroupParticipants is missing
  const largeParticipants = Array.from({ length: 45 }, (_, i) => ({ id: `62800${i}@c.us`, isAdmin: i === 0 }));
  const minimalTools = createWahaTools({
    waha: {
      getGroupInfo: async () => ({ id: '120363@g.us', subject: 'Big Group', participants: largeParticipants })
    },
    responseHandler: h.responseHandler
  });
  const minimalGroupTool = minimalTools.find((t) => t.name === 'get_group_info');
  const bounded = await minimalGroupTool.execute({}, { chatId: '120363@g.us', scope: 'group' });
  assert.equal(bounded.participantCount, 45);
  assert.equal(bounded.participants.length, 30);
  assert.equal(bounded.truncated, true);

  // check_whatsapp_number: personal-only and normalizes digits
  await assert.rejects(
    () => h.byName.check_whatsapp_number.execute({ phoneNumber: '+6281234567' }, { chatId: '120363@g.us', scope: 'group' }),
    /personal/i
  );
  const numRes = await h.byName.check_whatsapp_number.execute(
    { phoneNumber: '+62 812-3456-789' },
    { chatId: '6281@c.us', scope: 'personal' }
  );
  assert.equal(numRes.phoneNumber, '628123456789');
  assert.equal(numRes.numberExists, true);

  // get_waha_session_status: personal-only, combines live + cached, handles live outage gracefully
  await assert.rejects(
    () => h.byName.get_waha_session_status.execute({}, { chatId: '120363@g.us', scope: 'group' }),
    /personal/i
  );
  const statusOk = await h.byName.get_waha_session_status.execute({}, { chatId: '6281@c.us', scope: 'personal' });
  assert.equal(statusOk.status, 'WORKING');
  assert.equal(statusOk.healthy, true);
  assert.equal(statusOk.cached.status, 'WORKING');

  monitor.update({ session: 'default', status: 'FAILED' });
  h.waha.sessionStatus = async () => { throw new Error('WAHA unreachable'); };
  const statusDown = await h.byName.get_waha_session_status.execute({}, { chatId: '6281@c.us', scope: 'personal' });
  assert.equal(statusDown.status, 'FAILED');
  assert.equal(statusDown.healthy, false);
  assert.equal(statusDown.degraded, true);
  assert.match(statusDown.liveError, /WAHA unreachable/);
});

test('uncertain Phase 4 outbound delivery halts AgentRuntime without automatic retry', async () => {
  const h = makeWahaHarness();
  h.waha.sendPoll = async () => { throw Object.assign(new Error('network timeout'), { code: 'ETIMEDOUT' }); };
  const registry = registerAllTools({
    db: {},
    approvalManager: {},
    waha: h.waha,
    responseHandler: h.responseHandler,
    memoryService: null,
    documentService: {},
    webSearch: null,
    webFetch: null
  });

  const toolExecutions = new Map();
  const db = {
    task: null,
    createTask: (t) => { db.task = { ...t, status: 'running' }; return db.task; },
    getTask: () => db.task,
    getPendingApprovalForTask: () => null,
    countTaskSteps: () => 0,
    logModelUsage: () => {},
    updateTask: (_id, f) => { db.task = { ...db.task, ...f }; },
    queueTaskResponse: (_id, text) => { db.queuedResponse = text; },
    audit: () => {},
    addTaskStep: () => {},
    beginToolExecution: ({ idempotencyKey }) => {
      const existing = toolExecutions.get(idempotencyKey);
      if (existing) return existing;
      toolExecutions.set(idempotencyKey, { state: 'executing' });
      return { state: 'claimed' };
    },
    completeToolExecution: () => {},
    failToolExecution: (key, error, uncertain) => {
      toolExecutions.set(key, { state: uncertain ? 'uncertain' : 'failed', error });
    }
  };
  let chatCalls = 0;
  const agent = new AgentRuntime({
    provider: {
      chat: async () => {
        chatCalls++;
        return {
          message: {
            role: 'assistant',
            tool_calls: [{
              id: 'poll-call-1',
              type: 'function',
              function: {
                name: 'send_poll',
                arguments: JSON.stringify({ question: 'Pilih waktu?', options: ['Pagi', 'Sore'] })
              }
            }]
          },
          model: 'sumo/test',
          usage: {}
        };
      }
    },
    router: { select: () => ({ tier: 'balanced', model: 'sumo/test' }) },
    tools: registry,
    db,
    config: { agent: { maxRounds: 3, maxToolCalls: 4, maxToolResultChars: 1000, taskTimeoutMs: 2000, toolTimeoutMs: 1000 } },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  });

  await assert.rejects(
    () => h.byName.send_poll.execute({ question: 'Q', options: ['A', 'B'] }, { chatId: '123@g.us', scope: 'group' }),
    (err) => err instanceof ResponseDeliveryError && err.deliveryStatus === 'uncertain'
  );

  const result = await agent.run({
    text: 'Buat polling',
    chatId: '123@g.us',
    requesterId: '6281@c.us',
    scope: 'group',
    sourceEventId: 'poll-uncertain-evt'
  });
  assert.equal(chatCalls, 1);
  assert.equal(result.uncertain, true);
  assert.equal(db.task.status, 'uncertain');
  assert.equal([...toolExecutions.values()][0].state, 'uncertain');
});

test('MessageProcessor uses typingKeepalive when available, gates group slashes strictly, and quotes group replies', async () => {
  const events = [];
  const rateCalls = [];
  const sentResponses = [];
  let keepaliveOpts = null;

  const waha = {
    sendSeen: async (chatId) => events.push(`seen:${chatId}`),
    createTypingKeepalive: (chatId, opts) => {
      keepaliveOpts = opts;
      return {
        start: async () => events.push(`keepalive:start:${chatId}`),
        stop: async () => events.push(`keepalive:stop:${chatId}`)
      };
    },
    startTyping: async () => assert.fail('fallback startTyping should not run when createTypingKeepalive exists'),
    stopTyping: async () => assert.fail('fallback stopTyping should not run when createTypingKeepalive exists')
  };
  const db = {
    consumeRateLimit: (key) => { rateCalls.push(key); return { allowed: true }; },
    getHistory: () => [],
    addMessage: () => {},
    searchMemories: () => [],
    getChatOutputMode: () => 'text',
    claimTaskResponse: () => 'Siap dibantu!',
    finishTaskResponse: () => {}
  };
  let lastAgentRun = null;
  const monitor = new WahaSessionMonitor({ session: 'default', status: 'WORKING' });
  const processor = new MessageProcessor({
    config: {
      ownerJid: '628111@c.us',
      botJid: '628999@c.us',
      waha: { baseUrl: 'http://127.0.0.1:3000', typingKeepaliveMs: 7500 },
      groupPolicy: 'all',
      groupRequireMention: true,
      groupMediaRequireMention: false,
      agent: { enabled: true, messageRateLimit: 10, messageRateWindowMs: 60000 },
      media: { enabled: false, voiceReplyDefault: false },
      documents: { maxExtractChars: 50000 }
    },
    db,
    waha,
    sessionMonitor: monitor,
    responseHandler: {
      sendText: async (text, chatId, options) => sentResponses.push({ kind: 'text', text, chatId, options }),
      sendAssistantResponse: async (text, chatId, mode, options) => {
        sentResponses.push({ kind: 'assistant', text, chatId, mode, options });
      }
    },
    agent: {
      run: async (args) => {
        lastAgentRun = args;
        return { taskId: 't-1', text: 'Siap dibantu!' };
      }
    },
    router: { select: () => ({ tier: 'summary', model: 'm' }) },
    provider: { chat: async () => ({ message: { content: 'Ringkasan' } }) },
    approvalManager: {},
    documentService: {},
    memoryService: null,
    logger: { warn: () => {}, error: () => {} }
  });

  // Unrecognized /unknown in group must NOT bypass mention gate and must NOT burn rate limit
  await processor.process({
    event: 'message',
    payload: { id: 'g-unrec', from: '120363@g.us', author: '628222@c.us', body: '/unknown something' }
  });
  assert.equal(rateCalls.length, 0);
  assert.equal(events.length, 0);

  // Recognized /STATUS (case-insensitive) in group runs and prints WAHA session status
  await processor.process({
    event: 'message',
    payload: { id: 'g-status', from: '120363@g.us', author: '628222@c.us', body: '/STATUS' }
  });
  assert.equal(rateCalls.length, 1);
  assert.match(sentResponses[0].text, /WAHA session \(default\): WORKING/);
  assert.match(sentResponses[0].text, /Bot JID: 628999@c\.us/);
  assert.deepEqual(events, [
    'seen:120363@g.us',
    'keepalive:start:120363@g.us',
    'keepalive:stop:120363@g.us'
  ]);
  assert.equal(keepaliveOpts.intervalMs, 7500);

  // Mentioned group message passes incomingMessageId to agent.run and { replyTo } to sendAssistantResponse
  await processor.process({
    event: 'message',
    payload: { id: 'g-msg-42', from: '120363@g.us', author: '628222@c.us', body: 'Bubu halo' }
  });
  assert.equal(lastAgentRun.incomingMessageId, 'g-msg-42');
  assert.deepEqual(sentResponses[1].options, { replyTo: 'g-msg-42' });

  // DM normalizes @s.whatsapp.net -> @c.us and omits replyTo options
  await processor.process({
    event: 'message',
    payload: { id: 'dm-msg-1', from: '628111@s.whatsapp.net', author: '628111@s.whatsapp.net', body: 'Halo' }
  });
  assert.equal(lastAgentRun.chatId, '628111@c.us');
  assert.equal(lastAgentRun.incomingMessageId, 'dm-msg-1');
  assert.equal(sentResponses[2].options, undefined);

  // /rangkum respects agent.enabled = false
  processor.config.agent.enabled = false;
  await processor.process({
    event: 'message',
    payload: { id: 'dm-rangkum-off', from: '628111@c.us', author: '628111@c.us', body: '/rangkum' }
  });
  assert.match(sentResponses[3].text, /dinonaktifkan/i);
});

test('quote document resolution prioritizes quotedMessageId against source_event_id in real SQLite workspace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-quote-doc-'));
  const db = new DatabaseStore(path.join(dir, 'test.sqlite'));
  try {
    db.saveDocument({
      id: '11111111-1111-4111-8111-111111111111',
      scope: 'personal',
      ownerId: '628111@c.us',
      filename: 'old.pdf',
      mimeType: 'application/pdf',
      filePath: path.join(dir, 'old.pdf'),
      fileSize: 100,
      extractedText: 'Old PDF',
      sourceEventId: 'msg-doc-target'
    });
    db.saveDocument({
      id: '22222222-2222-4222-8222-222222222222',
      scope: 'personal',
      ownerId: '628111@c.us',
      filename: 'newest.pdf',
      mimeType: 'application/pdf',
      filePath: path.join(dir, 'newest.pdf'),
      fileSize: 100,
      extractedText: 'Newest PDF',
      sourceEventId: 'msg-doc-newest'
    });

    let capturedQuote = null;
    const processor = new MessageProcessor({
      config: {
        ownerJid: '628111@c.us',
        botJid: '628999@c.us',
        waha: { baseUrl: 'http://127.0.0.1:3000' },
        groupPolicy: 'all',
        groupRequireMention: true,
        groupMediaRequireMention: false,
        agent: { enabled: true, messageRateLimit: 10, messageRateWindowMs: 60000 },
        media: { enabled: false, voiceReplyDefault: false },
        documents: { maxExtractChars: 50000 }
      },
      db,
      waha: {},
      responseHandler: { sendAssistantResponse: async () => {}, sendText: async () => {} },
      agent: {
        run: async (args) => {
          capturedQuote = args.quoteContext;
          return { taskId: 't-quote', text: '' };
        }
      },
      router: {},
      provider: {},
      approvalManager: {},
      documentService: {},
      memoryService: null,
      logger: { warn: () => {}, error: () => {} }
    });

    await processor.process({
      event: 'message',
      payload: {
        id: 'quote-reply-1',
        from: '628111@c.us',
        author: '628111@c.us',
        body: 'Tolong cek dokumen yang ini',
        replyTo: {
          id: 'msg-doc-target',
          chatId: '628111@c.us',
          quotedMessage: { documentMessage: { mimetype: 'application/pdf' } }
        }
      }
    });

    assert.deepEqual(capturedQuote.referencedDocument, {
      documentId: '11111111-1111-4111-8111-111111111111',
      filename: 'old.pdf',
      mimeType: 'application/pdf'
    });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prompt-builder includes group sender attribution and Phase 4 WAHA guidance while productivity-tools guards invalid dates', async () => {
  assert.match(SYSTEM_PROMPT, /react_to_message/);
  assert.match(SYSTEM_PROMPT, /send_link_preview/);
  assert.match(SYSTEM_PROMPT, /edit_bot_message/);
  assert.match(SYSTEM_PROMPT, /delete_bot_message/);
  assert.match(SYSTEM_PROMPT, /list_recent_chat_messages/);
  assert.match(SYSTEM_PROMPT, /get_group_info/);
  assert.match(SYSTEM_PROMPT, /check_whatsapp_number/);
  assert.match(SYSTEM_PROMPT, /get_waha_session_status/);

  const messages = buildAgentMessages({
    text: 'Siapa tadi?',
    scope: 'group',
    history: [
      { role: 'user', sender: '628222@c.us', content: 'Saya setuju jam 3' },
      { role: 'assistant', sender: null, content: 'Baik dicatat' }
    ]
  });
  assert.equal(messages[1].content, '[628222@c.us]: Saya setuju jam 3');
  assert.equal(messages[2].content, 'Baik dicatat');

  const tools = createProductivityTools({
    db: { updateUserTask: () => assert.fail('must not update on invalid dueAt') },
    approvalManager: { create: async (payload) => payload }
  });
  const updateTask = tools.find((t) => t.name === 'update_task');
  await assert.rejects(
    () => updateTask.execute({ taskId: '11111111-1111-4111-8111-111111111111', dueAt: 'not-a-date' }, { scope: 'personal', requesterId: 'o' }),
    /Due date must be in the future/
  );
  const sendMsg = tools.find((t) => t.name === 'send_whatsapp_message');
  const parsed = sendMsg.schema.parse({
    targetId: '6282@c.us',
    message: 'Halo',
    replyTo: 'orig-1',
    mentions: ['6283@c.us']
  });
  assert.equal(parsed.replyTo, 'orig-1');
  assert.deepEqual(parsed.mentions, ['6283@c.us']);
});

test('Stage 2 Phase 4 tools (send_link_preview, edit_bot_message, delete_bot_message, cross-chat approval tools, list_recent_chat_messages) validate and execute cleanly', async () => {
  const h = makeWahaHarness();

  // 1. send_link_preview routes through ResponseHandler and blocks private/SSRF URLs
  assert.throws(() => h.byName.send_link_preview.schema.parse({ url: 'ftp://example.com' }));
  await assert.rejects(
    () => h.byName.send_link_preview.execute(
      { url: 'http://127.0.0.1:3000/internal', title: 'Private' },
      { chatId: '123@g.us', scope: 'group' }
    ),
    (err) => err.deliveryStatus === 'failed' && /host/i.test(err.message)
  );
  const linkRes = await h.byName.send_link_preview.execute(
    h.byName.send_link_preview.schema.parse({
      url: 'https://example.com/docs',
      text: 'Baca **panduan** ini',
      title: '**Dokumentasi**',
      description: 'Ringkasan',
      replyToCurrent: true,
      mentions: ['6281@c.us']
    }),
    { chatId: '123@g.us', scope: 'group', incomingMessageId: 'in-link-1' }
  );
  assert.equal(linkRes.sent, true);
  assert.equal(linkRes.messageId, 'link-msg-1');
  assert.equal(h.calls[0].method, 'sendLinkCustomPreview');
  assert.equal(h.calls[0].payload.replyTo, 'in-link-1');
  assert.deepEqual(h.calls[0].payload.mentions, ['6281@c.us']);

  // 2. edit_bot_message and delete_bot_message enforce same-chat and reject inbound false_* messageIds
  await assert.rejects(
    () => h.byName.edit_bot_message.execute(
      { messageId: 'false_123@g.us_USERMSG', text: 'Hijack' },
      { chatId: '123@g.us', scope: 'group' }
    ),
    (err) => err.deliveryStatus === 'failed' && /own outbound/i.test(err.message)
  );
  await assert.rejects(
    () => h.byName.edit_bot_message.execute(
      { messageId: 'true_999@c.us_OTHERCHAT', text: 'Cross chat' },
      { chatId: '123@g.us', scope: 'group' }
    ),
    (err) => err.deliveryStatus === 'failed' && /different WhatsApp chat/i.test(err.message)
  );
  const editRes = await h.byName.edit_bot_message.execute(
    h.byName.edit_bot_message.schema.parse({
      messageId: 'true_123@g.us_BOTMSG1',
      text: '**Koreksi** jawaban',
      mentions: ['6282@c.us']
    }),
    { chatId: '123@g.us', scope: 'group' }
  );
  assert.equal(editRes.edited, true);
  assert.equal(h.calls[1].method, 'editMessage');
  assert.equal(h.calls[1].text, '*Koreksi* jawaban');

  await assert.rejects(
    () => h.byName.delete_bot_message.execute(
      { messageId: 'false_123@g.us_USERMSG' },
      { chatId: '123@g.us', scope: 'group' }
    ),
    (err) => err.deliveryStatus === 'failed' && /own outbound/i.test(err.message)
  );
  const delRes = await h.byName.delete_bot_message.execute(
    h.byName.delete_bot_message.schema.parse({ messageId: 'true_123@g.us_BOTMSG1' }),
    { chatId: '123@g.us', scope: 'group' }
  );
  assert.equal(delRes.deleted, true);
  assert.equal(h.calls[2].method, 'deleteMessage');

  // 3. Cross-chat owner-approved tools (send_whatsapp_poll, send_whatsapp_location, send_whatsapp_contact)
  for (const toolName of ['send_whatsapp_poll', 'send_whatsapp_location', 'send_whatsapp_contact']) {
    await assert.rejects(
      () => h.byName[toolName].execute({}, { chatId: '123@g.us', scope: 'group' }),
      /personal/i
    );
  }
  const pollApproval = await h.byName.send_whatsapp_poll.execute(
    h.byName.send_whatsapp_poll.schema.parse({
      targetId: '120363@g.us',
      question: 'Vote menu?',
      options: ['Sate', 'Soto'],
      multipleAnswers: false
    }),
    { taskId: 't1', chatId: '6281@c.us', requesterId: '6281@c.us', scope: 'personal' }
  );
  assert.equal(pollApproval.pendingApproval, true);
  assert.equal(h.approvals[0].toolName, 'send_whatsapp_poll');

  const locApproval = await h.byName.send_whatsapp_location.execute(
    h.byName.send_whatsapp_location.schema.parse({
      targetId: '120363@g.us',
      latitude: -6.2,
      longitude: 106.8,
      title: 'Kantor'
    }),
    { taskId: 't2', chatId: '6281@c.us', requesterId: '6281@c.us', scope: 'personal' }
  );
  assert.equal(locApproval.pendingApproval, true);
  assert.equal(h.approvals[1].toolName, 'send_whatsapp_location');

  const contactApproval = await h.byName.send_whatsapp_contact.execute(
    h.byName.send_whatsapp_contact.schema.parse({
      targetId: '120363@g.us',
      fullName: 'Dewi',
      phoneNumber: '+62811223344',
      organization: 'Tim Bubu'
    }),
    { taskId: 't3', chatId: '6281@c.us', requesterId: '6281@c.us', scope: 'personal' }
  );
  assert.equal(contactApproval.pendingApproval, true);
  assert.equal(h.approvals[2].toolName, 'send_whatsapp_contact');

  // 4. list_recent_chat_messages: personal-only, downloadMedia: false, sanitized & untrusted: true
  await assert.rejects(
    () => h.byName.list_recent_chat_messages.execute({}, { chatId: '123@g.us', scope: 'group' }),
    /personal/i
  );
  assert.throws(() => h.byName.list_recent_chat_messages.schema.parse({ limit: 20 }));
  const recentRes = await h.byName.list_recent_chat_messages.execute(
    h.byName.list_recent_chat_messages.schema.parse({ limit: 5 }),
    { chatId: '6281@c.us', scope: 'personal' }
  );
  assert.equal(recentRes.untrusted, true);
  assert.equal(recentRes.count, 2);
  assert.deepEqual(h.calls[3], {
    method: 'getChatMessages',
    chatId: '6281@c.us',
    options: { limit: 5, downloadMedia: false }
  });
  assert.deepEqual(recentRes.messages[0], {
    id: 'false_6281@c.us_M1',
    fromMe: false,
    timestamp: 1700000001,
    body: 'Pesan masuk',
    hasMedia: false,
    untrusted: true
  });
});

test('Stage 1: edit_bot_message and delete_bot_message verify raw GOWS messageIds against db.isBotOutboundMessage', async () => {
  const h = makeWahaHarness();
  const recorded = new Set(['123@g.us:3EB0BOTMSG123']);
  const tools = createWahaTools({
    waha: h.waha,
    responseHandler: h.responseHandler,
    approvalManager: h.approvalManager,
    db: {
      isBotOutboundMessage: (chatId, msgId) => recorded.has(`${chatId}:${msgId}`)
    }
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  await assert.rejects(
    () => byName.edit_bot_message.execute(
      { messageId: '3EB0USERMSG999', text: 'Nope' },
      { chatId: '123@g.us', scope: 'group' }
    ),
    (err) => err.deliveryStatus === 'failed' && /recorded in this chat/i.test(err.message)
  );
  await assert.rejects(
    () => byName.delete_bot_message.execute(
      { messageId: '3EB0USERMSG999' },
      { chatId: '123@g.us', scope: 'group' }
    ),
    (err) => err.deliveryStatus === 'failed' && /recorded in this chat/i.test(err.message)
  );

  const editOk = await byName.edit_bot_message.execute(
    { messageId: '3EB0BOTMSG123', text: 'Updated' },
    { chatId: '123@g.us', scope: 'group' }
  );
  assert.equal(editOk.edited, true);

  const deleteOk = await byName.delete_bot_message.execute(
    { messageId: '3EB0BOTMSG123' },
    { chatId: '123@g.us', scope: 'group' }
  );
  assert.equal(deleteOk.deleted, true);
});
