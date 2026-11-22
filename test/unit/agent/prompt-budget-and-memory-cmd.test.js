const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SYSTEM_PROMPT,
  fitJsonArrayToBudget,
  trimHistoryToBudget,
  buildAgentMessages
} = require('../../../src/agent/prompt-builder');
const {
  RECOGNIZED_SLASH_COMMANDS,
  isRecognizedSlashCommand,
  handleSlashCommand
} = require('../../../src/agent/command-handler');
const { MessageProcessor } = require('../../../src/agent/message-processor');

const OWNER = '628111111111@c.us';
const MEMBER = '628222222222@c.us';
const GROUP = '120363000000000000@g.us';

test('fitJsonArrayToBudget drops trailing items cleanly and always produces valid JSON within budget', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    content: `Memory entry #${i + 1} `.repeat(15)
  }));

  const fitted = fitJsonArrayToBudget(items, 500);
  assert.equal(typeof fitted, 'string');
  assert.ok(fitted.length <= 500, `Expected <= 500 chars, got ${fitted.length}`);
  const parsed = JSON.parse(fitted);
  assert.equal(Array.isArray(parsed), true);
  assert.ok(parsed.length > 0 && parsed.length < items.length);
  assert.equal(parsed[0].id, 1);

  assert.equal(fitJsonArrayToBudget([{ content: 'x'.repeat(500) }], 100), '[]');
  assert.equal(fitJsonArrayToBudget(null, 100), '[]');
});

test('buildAgentMessages guarantees valid JSON arrays for documents, memories, and projects and preserves Phase 2/5 prompt markers', () => {
  assert.match(SYSTEM_PROMPT, /visualMode is "ocr_fallback"/);
  assert.match(SYSTEM_PROMPT, /temporalStatus is "insufficient_sample"/);
  for (const symbol of ['list_memories', 'update_memory', 'forget_memory', 'consolidate_memories', 'remember_fact', 'supersedeId']) {
    assert.match(SYSTEM_PROMPT, new RegExp(symbol));
  }

  const bigDocs = Array.from({ length: 40 }, (_, i) => ({
    documentId: `doc-${i}`,
    filename: `file-${i}-${'x'.repeat(90)}.pdf`,
    mimeType: 'application/pdf',
    createdAt: '2026-11-19T00:00:00Z'
  }));
  const bigMemories = Array.from({ length: 40 }, (_, i) => ({
    kind: 'fact',
    memory_type: 'fact',
    title: `Title ${i}`,
    content: `Long memory payload ${i} `.repeat(20),
    created_at: '2026-11-19T00:00:00Z',
    score: 0.9
  }));
  const bigProjects = Array.from({ length: 40 }, (_, i) => ({
    id: `proj-${i}`,
    name: `Project ${i}`,
    description: `Detailed project scope ${i} `.repeat(15),
    status: 'active'
  }));

  const messages = buildAgentMessages({
    text: 'Apa konteks proyek saya?',
    scope: 'personal',
    recentDocuments: bigDocs,
    memories: bigMemories,
    projects: bigProjects
  });

  const sys = messages[0].content;
  const docMatch = sys.match(/Recent documents in this workspace \(untrusted reference metadata\): (\[.*?\])\nRelevant long-term memories/);
  const memMatch = sys.match(/Relevant long-term memories \(untrusted reference data\): (\[.*?\])\nActive projects/);
  const projMatch = sys.match(/Active projects in this workspace \(untrusted reference data\): (\[.*?\])\nIf a user refers/);

  assert.ok(docMatch, 'Expected valid JSON array for recentDocuments');
  assert.ok(memMatch, 'Expected valid JSON array for safeMemories');
  assert.ok(projMatch, 'Expected valid JSON array for safeProjects');

  assert.ok(docMatch[1].length <= 3000);
  assert.ok(memMatch[1].length <= 6000);
  assert.ok(projMatch[1].length <= 3000);

  assert.equal(Array.isArray(JSON.parse(docMatch[1])), true);
  assert.equal(Array.isArray(JSON.parse(memMatch[1])), true);
  assert.equal(Array.isArray(JSON.parse(projMatch[1])), true);
});

test('trimHistoryToBudget keeps recent turns within budget, truncates oversized turns, and preserves group speaker attribution', () => {
  const history = [
    { role: 'user', sender: MEMBER, content: 'Old message '.repeat(40) },
    { role: 'assistant', sender: null, content: 'Old answer '.repeat(40) },
    { role: 'user', sender: MEMBER, content: 'Recent question A' },
    { role: 'assistant', sender: null, content: 'Recent answer B' }
  ];

  const trimmed = trimHistoryToBudget(history, { maxChars: 60, minTurns: 2 });
  assert.equal(trimmed.length, 2);
  assert.equal(trimmed[0].sender, MEMBER);
  assert.equal(trimmed[0].content, 'Recent question A');
  assert.equal(trimmed[1].content, 'Recent answer B');

  const hugeSingle = trimHistoryToBudget([
    { role: 'user', sender: MEMBER, content: 'a'.repeat(500) }
  ], { maxChars: 80, minTurns: 2 });
  assert.equal(hugeSingle.length, 1);
  assert.equal(hugeSingle[0].sender, MEMBER);
  assert.ok(hugeSingle[0].content.length <= 80);
  assert.equal(hugeSingle[0].content.endsWith('...[truncated]'), true);

  const minTurnsTruncated = trimHistoryToBudget([
    { role: 'user', sender: MEMBER, content: 'older-'.repeat(40) },
    { role: 'assistant', sender: null, content: 'b'.repeat(70) }
  ], { maxChars: 120, minTurns: 2 });
  assert.equal(minTurnsTruncated.length, 2);
  assert.ok(minTurnsTruncated[0].content.length + minTurnsTruncated[1].content.length <= 120);
  assert.equal(minTurnsTruncated[0].content.endsWith('...[truncated]'), true);
  assert.equal(minTurnsTruncated[1].content, 'b'.repeat(70));

  const built = buildAgentMessages({
    text: 'Lanjutkan',
    scope: 'group',
    history: [
      { role: 'user', sender: MEMBER, content: 'x'.repeat(20000) },
      { role: 'assistant', sender: null, content: 'Singkat saja' }
    ]
  });
  assert.equal(built[1].content.startsWith(`[${MEMBER}]: `), true);
  assert.equal(built[1].content.endsWith('...[truncated]'), true);
  assert.equal(built[2].content, 'Singkat saja');
  assert.equal('sender' in built[1], false);
});

test('/memory slash command supports status, list, and owner-only sync with workspace isolation', async () => {
  assert.equal(RECOGNIZED_SLASH_COMMANDS.has('/memory'), true);
  assert.equal(isRecognizedSlashCommand('/memory status'), true);
  assert.equal(isRecognizedSlashCommand('/MEMORY list'), true);

  const sent = [];
  const queries = [];
  const syncCalls = [];
  const processor = {
    config: { ownerJid: OWNER, media: { voiceReplyDefault: false } },
    responseHandler: {
      sendText: async (text, chatId) => sent.push({ text, chatId })
    },
    db: {
      getMemoryStats: (ctx) => {
        queries.push({ fn: 'getMemoryStats', ctx });
        return { activeCount: 4, supersededCount: 1, archivedCount: 2, unembeddedCount: 1, projectCount: 2, eventCount: 9 };
      },
      listMemories: (ctx) => {
        queries.push({ fn: 'listMemories', ctx });
        return [
          { id: 12, memory_type: 'preference', title: 'Bahasa', content: 'Gunakan bahasa Indonesia ringkas.' },
          { id: 7, memory_type: 'fact', title: null, content: 'Deadline rilis hari Jumat.' }
        ];
      }
    },
    memoryService: {
      consolidateWorkspace: async (ctx) => {
        syncCalls.push(ctx);
        return { deduplicatedCount: 2, archivedStaleCount: 1, backfilledCount: 3 };
      }
    }
  };

  // /help mentions /memory status|list|sync
  await handleSlashCommand(processor, {
    text: '/help',
    msg: { chatId: OWNER },
    senderId: OWNER,
    owner: true,
    isGroup: false,
    scope: 'personal',
    eventId: 'e0'
  });
  assert.match(sent[0].text, /\/memory status\|list\|sync — Kelola memori workspace/);

  // /memory (default status) in DM
  await handleSlashCommand(processor, {
    text: '/memory',
    msg: { chatId: OWNER },
    senderId: OWNER,
    owner: true,
    isGroup: false,
    scope: 'personal',
    eventId: 'e1'
  });
  assert.deepEqual(queries[0], { fn: 'getMemoryStats', ctx: { scope: 'personal', ownerId: OWNER, chatId: null } });
  assert.match(sent[1].text, /Memori aktif: 4/);
  assert.match(sent[1].text, /Proyek aktif: 2/);
  assert.match(sent[1].text, /Event episodik: 9/);

  // /memory list in group scope isolates to chatId
  await handleSlashCommand(processor, {
    text: '/memory list',
    msg: { chatId: GROUP },
    senderId: MEMBER,
    owner: false,
    isGroup: true,
    scope: 'group',
    eventId: 'e2'
  });
  assert.deepEqual(queries[1], { fn: 'listMemories', ctx: { scope: 'group', ownerId: null, chatId: GROUP, status: 'active', limit: 10 } });
  assert.match(sent[2].text, /#12 \[preference\] Bahasa: Gunakan bahasa Indonesia ringkas\./);
  assert.match(sent[2].text, /#7 \[fact\] Deadline rilis hari Jumat\./);

  // /memory sync rejected for non-owner
  await handleSlashCommand(processor, {
    text: '/memory sync',
    msg: { chatId: GROUP },
    senderId: MEMBER,
    owner: false,
    isGroup: true,
    scope: 'group',
    eventId: 'e3'
  });
  assert.equal(syncCalls.length, 0);
  assert.match(sent[3].text, /hanya dapat dilakukan oleh pemilik/i);

  // /memory sync allowed for owner
  await handleSlashCommand(processor, {
    text: '/memory sync',
    msg: { chatId: OWNER },
    senderId: OWNER,
    owner: true,
    isGroup: false,
    scope: 'personal',
    eventId: 'e4'
  });
  assert.deepEqual(syncCalls, [{ scope: 'personal', ownerId: OWNER, chatId: null, backfillLimit: 10 }]);
  assert.match(sent[4].text, /Deduplikasi: 2/);
  assert.match(sent[4].text, /Diarsipkan \(usang\): 1/);
  assert.match(sent[4].text, /Embedding diperbarui: 3/);

  // Fallback paths when getMemoryStats and memoryService.consolidateWorkspace are omitted
  const fallbackProcessor = {
    config: { ownerJid: OWNER },
    responseHandler: { sendText: async (text, chatId) => sent.push({ text, chatId }) },
    db: {
      listMemories: () => [{ id: 1, kind: 'note', content: 'Catatan fallback' }],
      listProjects: () => [{ id: 'p1', name: 'Proj' }],
      listMemoryEvents: () => [{ id: 'ev1' }],
      consolidateWorkspaceMemories: () => ({ deduplicatedCount: 1, archivedStaleCount: 2 })
    },
    memoryService: null
  };
  await handleSlashCommand(fallbackProcessor, {
    text: '/memory status',
    msg: { chatId: OWNER },
    senderId: OWNER,
    owner: true,
    isGroup: false,
    scope: 'personal',
    eventId: 'e5'
  });
  assert.match(sent[5].text, /Memori aktif: 1/);
  assert.match(sent[5].text, /Proyek aktif: 1/);
  assert.match(sent[5].text, /Event episodik: 1/);

  await handleSlashCommand(fallbackProcessor, {
    text: '/memory sync',
    msg: { chatId: OWNER },
    senderId: OWNER,
    owner: true,
    isGroup: false,
    scope: 'personal',
    eventId: 'e6'
  });
  assert.match(sent[6].text, /Deduplikasi: 1/);
  assert.match(sent[6].text, /Diarsipkan \(usang\): 2/);
  assert.match(sent[6].text, /Embedding diperbarui: 0/);
});

test('MessageProcessor opportunistically triggers backfillEmbeddings when captureFromTurn captures memories (non-fatal)', async () => {
  const backfillCalls = [];
  const warnings = [];
  let capturedCount = 1;

  const db = {
    consumeRateLimit: () => ({ allowed: true }),
    getHistory: () => [],
    addMessage: () => {},
    getChatOutputMode: () => 'text',
    claimTaskResponse: () => 'Baik, saya catat.',
    finishTaskResponse: () => {},
    saveMemoryEvent: () => 'evt-mem-1'
  };
  const processor = new MessageProcessor({
    config: {
      ownerJid: OWNER,
      botJid: '628999@c.us',
      waha: { baseUrl: 'http://waha:3000' },
      groupPolicy: 'all',
      groupRequireMention: true,
      groupMediaRequireMention: false,
      agent: { enabled: true, messageRateLimit: 20, messageRateWindowMs: 60000 },
      media: { enabled: false, voiceReplyDefault: false },
      documents: { maxExtractChars: 5000 }
    },
    db,
    waha: {},
    responseHandler: {
      sendAssistantResponse: async () => {},
      sendText: async () => {}
    },
    agent: {
      run: async () => ({ taskId: 't-mem-backfill', text: 'Baik, saya catat.' })
    },
    router: {},
    provider: {},
    approvalManager: {},
    documentService: {},
    memoryService: {
      retrieve: async () => [],
      projectContext: async () => [],
      captureFromTurn: async () => ({ captured: capturedCount, skipped: false }),
      backfillEmbeddings: async (args) => {
        backfillCalls.push(args);
        if (backfillCalls.length === 2) throw new Error('embedding quota exceeded');
        return { backfilled: 1 };
      }
    },
    logger: { warn: (details, msg) => warnings.push({ details, msg }), error: () => {} }
  });

  // 1. captured > 0 triggers backfillEmbeddings with limit: 2
  await processor.process({
    event: 'message',
    payload: { id: 'm-cap-1', from: OWNER, author: OWNER, body: 'Ingat saya suka kopi hitam.' }
  });
  assert.deepEqual(backfillCalls, [{ scope: 'personal', ownerId: OWNER, chatId: null, limit: 2 }]);

  // 2. Backfill failure is caught non-fatally
  await processor.process({
    event: 'message',
    payload: { id: 'm-cap-2', from: OWNER, author: OWNER, body: 'Ingat jadwal standup jam 9.' }
  });
  assert.equal(backfillCalls.length, 2);
  assert.equal(warnings.some((w) => w.msg === 'Memory capture failed'), true);

  // 3. captured === 0 does not call backfillEmbeddings
  capturedCount = 0;
  await processor.process({
    event: 'message',
    payload: { id: 'm-cap-3', from: OWNER, author: OWNER, body: 'Halo saja.' }
  });
  assert.equal(backfillCalls.length, 2);
});

test('/queue slash command is owner-only and supports status, dead, retry, and prune', async () => {
  assert.equal(RECOGNIZED_SLASH_COMMANDS.has('/queue'), true);
  assert.equal(isRecognizedSlashCommand('/queue status'), true);
  assert.equal(isRecognizedSlashCommand('/QUEUE retry evt-1'), true);

  const sent = [];
  let pruneCalled = 0;
  const requeueResults = new Map([
    ['evt-ok', { requeued: true, eventId: 'evt-ok' }],
    ['evt-uncertain', { requeued: false, reason: 'delivery_uncertain' }],
    ['evt-missing', { requeued: false, reason: 'not_found' }],
    ['evt-done', { requeued: false, reason: 'not_dead_or_failed' }]
  ]);
  const processor = {
    config: { ownerJid: OWNER },
    responseHandler: {
      sendText: async (text, chatId) => sent.push({ text, chatId })
    },
    worker: {
      getStats: () => ({
        activeCount: 1,
        maxConcurrentJobs: 3,
        healthy: true,
        queue: {
          pendingCount: 2,
          processingCount: 1,
          failedCount: 1,
          deadCount: 1,
          completedCount: 12,
          oldestPendingAt: '2026-11-19T10:00:00.000Z'
        }
      })
    },
    db: {
      getQueueStats: () => ({ pendingCount: 2, processingCount: 1, failedCount: 1, deadCount: 1, completedCount: 12, oldestPendingAt: null }),
      getTelemetrySummary: () => ({
        windowHours: 24,
        totalCalls: 5,
        successCalls: 4,
        totalInputTokens: 1500,
        totalOutputTokens: 600,
        avgLatencyMs: 320,
        byTier: { fast: { calls: 3 }, balanced: { calls: 2 } }
      }),
      listDeadEvents: () => [
        { event_id: 'evt-ok', chat_id: OWNER, priority: 2, attempts: 5, last_error: 'timeout: upstream' }
      ],
      requeueDeadEvent: (id) => requeueResults.get(id) || { requeued: false, reason: 'not_found' },
      pruneHistoryAndQueue: () => {
        pruneCalled += 1;
        return { deletedCompletedEvents: 4, deletedDeadEvents: 1, deletedModelUsage: 10, deletedAuditLogs: 3 };
      }
    }
  };

  // /help mentions /queue
  await handleSlashCommand(processor, {
    text: '/help', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'q0'
  });
  assert.match(sent[0].text, /\/queue status\|dead\|retry\|prune/);

  // Non-owner rejected
  await handleSlashCommand(processor, {
    text: '/queue status', msg: { chatId: GROUP }, senderId: MEMBER, owner: false, isGroup: true, scope: 'group', eventId: 'q1'
  });
  assert.match(sent[1].text, /hanya dapat diakses oleh pemilik/i);

  // /queue (defaults to status)
  await handleSlashCommand(processor, {
    text: '/queue', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'q2'
  });
  assert.match(sent[2].text, /1\/3 slot aktif/);
  assert.match(sent[2].text, /Pending: 2/);
  assert.match(sent[2].text, /Telemetri \(24j\) — Calls: 5/);
  assert.match(sent[2].text, /fast=3, balanced=2/);

  // /queue dead
  await handleSlashCommand(processor, {
    text: '/queue dead', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'q3'
  });
  assert.match(sent[3].text, /evt-ok/);
  assert.match(sent[3].text, /timeout: upstream/);

  // /queue retry (success + uncertain + missing + non-dead + missing arg)
  await handleSlashCommand(processor, {
    text: '/queue retry evt-ok', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'q4'
  });
  assert.match(sent[4].text, /berhasil dimasukkan kembali/i);

  await handleSlashCommand(processor, {
    text: '/queue retry evt-uncertain', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'q5'
  });
  assert.match(sent[5].text, /delivery_uncertain/);

  await handleSlashCommand(processor, {
    text: '/queue retry evt-missing', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'q6'
  });
  assert.match(sent[6].text, /tidak ditemukan/i);

  await handleSlashCommand(processor, {
    text: '/queue retry evt-done', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'q7'
  });
  assert.match(sent[7].text, /tidak dalam status dead\/failed/i);

  await handleSlashCommand(processor, {
    text: '/queue retry', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'q8'
  });
  assert.match(sent[8].text, /Format: \/queue retry <eventId>/);

  // /queue prune
  await handleSlashCommand(processor, {
    text: '/queue prune', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'q9'
  });
  assert.equal(pruneCalled, 1);
  assert.match(sent[9].text, /Completed events dihapus: 4/);
  assert.match(sent[9].text, /Dead events dihapus: 1/);
  assert.match(sent[9].text, /Model usage dihapus: 10/);
  assert.match(sent[9].text, /Audit logs dihapus: 3/);
});

test('Stage 2: SumopodProvider emits Claude cache_control across static/dynamic boundary and /usage reports cost breakdown', async () => {
  const { SumopodProvider } = require('../../../src/providers/sumopod');
  const { STATIC_DYNAMIC_BOUNDARY } = require('../../../src/agent/prompt-builder');

  const messages = buildAgentMessages({
    text: 'Cek jadwal',
    scope: 'personal',
    timezone: 'Asia/Jakarta'
  });
  assert.equal(messages[0].content.includes(STATIC_DYNAMIC_BOUNDARY), true);

  const capturedBodies = [];
  const httpClient = {
    post: async (_url, body) => {
      capturedBodies.push(body);
      return { data: { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} } };
    }
  };

  const cachedProvider = new SumopodProvider({
    baseUrl: 'https://sumopod.test/v1',
    apiKey: 'secret',
    promptCaching: true,
    httpClient
  });
  await cachedProvider.chat({ model: 'claude-sonnet-5-5', messages });
  assert.equal(Array.isArray(capturedBodies[0].messages[0].content), true);
  assert.deepEqual(capturedBodies[0].messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(capturedBodies[0].messages[0].content[1].type, 'text');

  // When promptCaching is false, SumopodProvider strips internal boundary marker into clean single string
  const plainProvider = new SumopodProvider({
    baseUrl: 'https://sumopod.test/v1',
    apiKey: 'secret',
    promptCaching: false,
    httpClient
  });
  await plainProvider.chat({ model: 'claude-sonnet-5-5', messages });
  assert.equal(typeof capturedBodies[1].messages[0].content, 'string');
  assert.equal(capturedBodies[1].messages[0].content.includes(STATIC_DYNAMIC_BOUNDARY), false);

  // /usage slash command (owner-only, duration parsing, cost formatting)
  assert.equal(RECOGNIZED_SLASH_COMMANDS.has('/usage'), true);
  const replies = [];
  let requestedWindow = null;
  const processor = {
    config: { ownerJid: OWNER, telemetry: { usdToIdr: 16500 } },
    responseHandler: { sendText: async (text, chatId) => replies.push({ text, chatId }) },
    db: {
      getTelemetrySummary: ({ windowHours }) => {
        requestedWindow = windowHours;
        return {
          windowHours,
          totalCalls: 12,
          successCalls: 11,
          failedCalls: 1,
          totalInputTokens: 15000,
          totalOutputTokens: 3000,
          avgLatencyMs: 420,
          estimatedCostUsd: 0.09,
          estimatedCostIdr: 1485,
          byTier: { balanced: { calls: 10, inputTokens: 12000, outputTokens: 2500 }, fast: { calls: 2, inputTokens: 3000, outputTokens: 500 } },
          costByTier: { balanced: { estimatedCostUsd: 0.0735 }, fast: { estimatedCostUsd: 0.0044 } }
        };
      }
    }
  };

  await handleSlashCommand(processor, {
    text: '/usage 7d', msg: { chatId: GROUP }, senderId: MEMBER, owner: false, isGroup: true, scope: 'group', eventId: 'u1'
  });
  assert.match(replies[0].text, /hanya dapat diakses oleh pemilik/i);

  await handleSlashCommand(processor, {
    text: '/usage 7d', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'u2'
  });
  assert.equal(requestedWindow, 168);
  assert.match(replies[1].text, /168 jam terakhir/);
  assert.match(replies[1].text, /\$0\.0900 USD/);
  assert.match(replies[1].text, /balanced: 10 calls/);
});

test('Stage 3: passive group context block preserves history indexes, /rangkum merges passive chat, /reminder supports recurring/list/cancel, and /polls works', async () => {
  const { createPollTools } = require('../../../src/channels/waha/poll-tools');

  // 1. Prompt builder injects UNTRUSTED_GROUP_PASSIVE_CONTEXT in group scope without shifting history indexes
  const groupMessages = buildAgentMessages({
    text: 'Bubu rangkum topik tadi',
    scope: 'group',
    history: [{ role: 'user', sender: MEMBER, content: 'Halo Bubu' }],
    passiveGroupMessages: [{ sender: MEMBER, content: 'Server staging butuh restart malam ini.' }]
  });
  assert.equal(groupMessages[0].role, 'system');
  assert.equal(groupMessages[1].content, `[${MEMBER}]: Halo Bubu`);
  assert.equal(groupMessages[2].content, 'Bubu rangkum topik tadi');
  assert.match(groupMessages[3].content, /UNTRUSTED_GROUP_PASSIVE_CONTEXT/);
  assert.match(groupMessages[3].content, /Server staging butuh restart malam ini\./);

  // Never inject passive group context into personal scope
  const personalMessages = buildAgentMessages({
    text: 'Halo',
    scope: 'personal',
    passiveGroupMessages: [{ sender: MEMBER, content: 'Bocor?' }]
  });
  assert.equal(personalMessages.some((m) => String(m.content).includes('UNTRUSTED_GROUP_PASSIVE_CONTEXT')), false);

  // 2. /rangkum merges passive group buffer + /reminder recurring + /reminder list/cancel + /polls
  assert.equal(RECOGNIZED_SLASH_COMMANDS.has('/polls'), true);
  const sent = [];
  const createdReminders = [];
  const cancelledIds = [];
  let promptSentToRangkum = '';
  const processor = {
    config: {
      ownerJid: OWNER,
      appTimezone: 'Asia/Jakarta',
      groupPassiveHistory: true,
      groupPassiveBufferSize: 30,
      agent: { enabled: true, taskTimeoutMs: 5000, maxOutputTokens: 1000 }
    },
    responseHandler: { sendText: async (text, chatId) => sent.push({ text, chatId }) },
    router: { select: () => ({ model: 'gemini/gemini-3.1-pro-preview', tier: 'summary' }) },
    provider: {
      chat: async ({ messages }) => {
        promptSentToRangkum = messages[1].content;
        return { model: 'gemini/gemini-3.1-pro-preview', message: { content: 'Ringkasan rapat selesai.' }, usage: {} };
      }
    },
    db: {
      getHistory: () => [],
      getGroupPassiveMessages: () => [{ sender: MEMBER, content: 'Deadline API hari Jumat jam 17:00' }],
      createReminder: (item) => {
        createdReminders.push(item);
        return createdReminders.length;
      },
      listReminders: () => [
        { id: 1, message: 'Cek backup', due_at: '2026-11-24T01:00:00.000Z', recurrence: 'daily' }
      ],
      cancelReminder: ({ id }) => {
        cancelledIds.push(id);
        return id === 1;
      },
      listPolls: () => [
        {
          pollMessageId: 'poll-99',
          question: 'Makan siang?',
          totalVoters: 3,
          tally: [{ option: 'Sate', votes: 2 }, { option: 'Bakso', votes: 1 }]
        }
      ],
      getPollResults: ({ pollMessageId }) => ({
        found: pollMessageId === 'poll-99',
        pollMessageId,
        question: 'Makan siang?',
        totalVoters: 3,
        tally: [{ option: 'Sate', votes: 2 }, { option: 'Bakso', votes: 1 }]
      })
    }
  };

  await handleSlashCommand(processor, {
    text: '/rangkum', msg: { chatId: GROUP }, senderId: MEMBER, owner: false, isGroup: true, scope: 'group', eventId: 'r1'
  });
  assert.match(promptSentToRangkum, /Percakapan Grup Pasif/);
  assert.match(promptSentToRangkum, /Deadline API hari Jumat/);
  assert.equal(sent[0].text, 'Ringkasan rapat selesai.');

  await handleSlashCommand(processor, {
    text: '/reminder daily 08:00 Cek server produksi', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'rem1'
  });
  assert.equal(createdReminders[0].recurrence, 'daily');
  assert.match(sent[1].text, /berulang: daily/);

  await handleSlashCommand(processor, {
    text: '/reminder list', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'rem2'
  });
  assert.match(sent[2].text, /#1 \[daily\]/);

  await handleSlashCommand(processor, {
    text: '/reminder cancel 1', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'rem3'
  });
  assert.deepEqual(cancelledIds, [1]);
  assert.match(sent[3].text, /Reminder #1 dibatalkan/);

  await handleSlashCommand(processor, {
    text: '/polls', msg: { chatId: GROUP }, senderId: MEMBER, owner: false, isGroup: true, scope: 'group', eventId: 'p1'
  });
  assert.match(sent[4].text, /\*Makan siang\?\* \(3 pemilih\)/);
  assert.match(sent[4].text, /Sate: 2 suara/);

  const pollTools = createPollTools({ db: processor.db });
  const toolOut = await pollTools[0].execute({ pollMessageId: 'poll-99' }, { chatId: GROUP, scope: 'group' });
  assert.equal(toolOut.found, true);
  assert.equal(toolOut.totalVoters, 3);
});
