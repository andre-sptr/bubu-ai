const test = require('node:test');
const assert = require('node:assert/strict');
const { cosineSimilarity } = require('../../../src/utils/vector');
const { MemoryService, DURABLE_SIGNAL, extractJsonObject } = require('../../../src/memory/memory-service');

test('cosine similarity handles matching, orthogonal and invalid vectors', () => {
  assert.equal(cosineSimilarity([1,0],[1,0]), 1);
  assert.equal(cosineSimilarity([1,0],[0,1]), 0);
  assert.equal(cosineSimilarity([1],[1,2]), 0);
});

test('memory embedding failure is non-fatal and remembers lexical memory', async () => {
  let saved = null;
  const db = {
    saveMemory: (record) => { saved = record; return 12; },
    getProject: () => ({ id: 'project-1' })
  };
  const service = new MemoryService({
    db,
    provider: { embed: async () => { throw new Error('embedding unavailable'); } },
    router: {}, logger: { warn: () => {} }
  });
  const result = await service.remember({
    scope: 'personal', ownerId: 'owner',
    content: 'User prefers concise answers',
    memoryType: 'preference', projectId: 'project-1'
  });
  assert.equal(result.saved, true);
  assert.equal(result.embedded, false);
  assert.equal(saved.memoryType, 'preference');
});

test('project association is checked against the current workspace', async () => {
  const service = new MemoryService({
    db: { getProject: () => null },
    provider: { embed: async () => [1,0] },
    router: {}, logger: { warn: () => {} }
  });
  await assert.rejects(() => service.remember({
    scope: 'group', chatId: 'group-a',
    projectId: 'foreign-project', content: 'secret'
  }), /Project tidak ditemukan/);
});

test('durable extraction is only triggered by explicit long-term signals', () => {
  assert.equal(DURABLE_SIGNAL.test('Ingat saya lebih suka jawaban singkat'), true);
  assert.equal(DURABLE_SIGNAL.test('berapa cuaca hari ini'), false);
});

test('memory extractor stores only parsed durable memories and is idempotent', async () => {
  const saved = [];
  let extractionRecorded = false;
  const db = {
    hasMemoryExtraction: () => false,
    recordMemoryExtraction: (v) => { extractionRecorded = v.status === 'completed'; },
    saveMemory: (v) => { saved.push(v); return saved.length; },
    getProject: () => null
  };
  const service = new MemoryService({
    db,
    provider: {
      embed: async () => [0.1,0.2],
      chat: async () => ({
        message: { content: JSON.stringify({ memories: [
          { title: 'Preferred style', content: 'Prefers concise Indonesian answers', memoryType: 'preference', importance: 4 }
        ] }) }
      })
    },
    router: { select: () => ({ model: 'summary' }) },
    logger: { warn: () => {} }
  });
  const result = await service.captureFromTurn({
    scope: 'personal', ownerId: 'owner',
    userText: 'Ingat, saya lebih suka jawaban singkat.',
    assistantText: 'Baik.',
    sourceEventId: 'evt-1'
  });
  assert.equal(result.captured, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].memoryType, 'preference');
  assert.equal(extractionRecorded, true);
});


test('semantic retrieval passes query vector and workspace identity to SQLite', async () => {
  let captured = null;
  const service = new MemoryService({
    db: { searchMemoriesSemantic: (args) => { captured = args; return [{ id: 3, content: 'matching' }]; } },
    provider: { embed: async () => [0.25,0.75] },
    router: {}, logger: { warn: () => {} }
  });
  const result = await service.retrieve({
    scope: 'group', chatId: 'group-1',
    query: 'project schedule', limit: 4
  });
  assert.equal(result[0].id, 3);
  assert.deepEqual(captured.queryEmbedding, [0.25,0.75]);
  assert.equal(captured.scope, 'group');
  assert.equal(captured.chatId, 'group-1');
});


test('embedding failures activate a temporary circuit breaker', async () => {
  let calls = 0;
  const service = new MemoryService({
    db: {},
    provider: { embed: async () => { calls++; throw new Error('not supported'); } },
    router: {}, logger: { warn: () => {} }
  });
  assert.equal(await service.embed('first query'), null);
  assert.equal(await service.embed('second query'), null);
  assert.equal(calls, 1);
});

test('extractJsonObject parses balanced JSON objects surrounded by prose, braces, and code fences', () => {
  assert.deepEqual(
    extractJsonObject('Here is output {ignore me} and {broken:\n```json\n{"memories":[{"title":"Code {x}","content":"Escaped \\"quote\\" and } brace"}]}\n```\nTrailing {note}'),
    { memories: [{ title: 'Code {x}', content: 'Escaped "quote" and } brace' }] }
  );
  assert.equal(extractJsonObject('No json payload here'), null);
  assert.equal(extractJsonObject('[1, 2, 3]'), null);
});

test('embed skips inputs shorter than 2 trimmed chars and coalesces concurrent identical requests', async () => {
  let calls = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const service = new MemoryService({
    db: {},
    provider: {
      embed: async ({ input }) => {
        calls++;
        await barrier;
        return [input.length, 1];
      }
    },
    router: {}, logger: { warn: () => {} }
  });

  assert.equal(await service.embed(''), null);
  assert.equal(await service.embed(' a '), null);
  assert.equal(calls, 0);

  const p1 = service.embed('hello world');
  const p2 = service.embed('  hello world  ');
  release();
  const [v1, v2] = await Promise.all([p1, p2]);
  assert.deepEqual(v1, [11, 1]);
  assert.deepEqual(v2, [11, 1]);
  assert.equal(calls, 1);
  assert.equal(service._embedInFlight.size, 0);
});

test('MemoryService remember(supersedeId), update, forget, backfillEmbeddings, and consolidateWorkspace', async () => {
  const calls = { supersede: null, updated: null, deleted: null, embeddedSet: [] };
  const db = {
    getProject: () => ({ id: 'p-1' }),
    getMemory: ({ id }) => (id === 5 ? { id: 5, title: 'Old title', content: 'Old content' } : null),
    supersedeMemory: (arg) => { calls.supersede = arg; return { superseded: true, oldId: arg.oldId, newId: 9 }; },
    updateMemory: (arg) => { calls.updated = arg; return { id: arg.id, ...arg.fields }; },
    deleteMemory: (arg) => { calls.deleted = arg; return { deleted: true, id: arg.id, mode: arg.hard ? 'hard' : 'archived' }; },
    listUnembeddedMemories: () => [{ id: 10, title: 'T', content: 'Unembedded fact' }],
    setMemoryEmbedding: (id, vec) => { calls.embeddedSet.push({ id, vec }); return true; },
    consolidateWorkspaceMemories: () => ({ deduplicatedCount: 2, archivedStaleCount: 1 })
  };

  const service = new MemoryService({
    db,
    provider: { embed: async () => [0.3, 0.7] },
    router: {}, logger: { warn: () => {} }
  });

  const supRes = await service.remember({
    scope: 'personal', ownerId: 'owner',
    content: 'New content', title: 'New title', supersedeId: 5
  });
  assert.deepEqual(supRes, {
    saved: true, memoryId: 9, supersededId: 5, memoryType: 'fact', embedded: true
  });
  assert.equal(calls.supersede.oldId, 5);

  const updRes = await service.update({
    id: 5, scope: 'personal', ownerId: 'owner', content: 'Updated content', importance: 5
  });
  assert.equal(updRes.content, 'Updated content');
  assert.equal(calls.updated.fields.embedding_json, JSON.stringify([0.3, 0.7]));

  assert.equal(await service.update({ id: 999, scope: 'personal', ownerId: 'owner', content: 'x' }), null);

  const forgetRes = await service.forget({ id: 5, scope: 'personal', ownerId: 'owner', hard: true });
  assert.deepEqual(forgetRes, { deleted: true, id: 5, mode: 'hard' });

  const backfillRes = await service.backfillEmbeddings({ scope: 'personal', ownerId: 'owner', limit: 5 });
  assert.deepEqual(backfillRes, { attempted: 1, backfilled: 1 });
  assert.deepEqual(calls.embeddedSet, [{ id: 10, vec: [0.3, 0.7] }]);

  const consRes = await service.consolidateWorkspace({ scope: 'personal', ownerId: 'owner', backfillLimit: 5 });
  assert.deepEqual(consRes, { deduplicatedCount: 2, archivedStaleCount: 1, backfilledCount: 1 });
});

test('captureFromTurn extracts JSON from prose and forwards valid workspace supersedesId only', async () => {
  const remembered = [];
  const db = {
    hasMemoryExtraction: () => false,
    recordMemoryExtraction: () => {},
    getMemory: ({ id, ownerId }) => (id === 7 && ownerId === 'owner' ? { id: 7 } : null),
    supersedeMemory: (args) => { remembered.push({ superseded: args.oldId, ...args.newMemory }); return { oldId: args.oldId, newId: 20 }; },
    saveMemory: (args) => { remembered.push({ superseded: null, ...args }); return 21; }
  };
  const service = new MemoryService({
    db,
    provider: {
      embed: async () => [1, 0],
      chat: async () => ({
        message: {
          content: 'Sure {here}: {"memories":[{"title":"Drink","content":"Now drinks tea","memoryType":"preference","importance":4,"supersedesId":7},{"title":"Food","content":"Likes nasi goreng","memoryType":"fact","importance":3,"supersedesId":999}]}'
        }
      })
    },
    router: { select: () => ({ model: 'summary' }) },
    logger: { warn: () => {} }
  });

  const res = await service.captureFromTurn({
    scope: 'personal', ownerId: 'owner',
    userText: 'Ingat mulai sekarang saya minum teh saja',
    assistantText: 'Dicatat!',
    sourceEventId: 'evt-sup-1'
  });
  assert.equal(res.captured, 2);
  assert.equal(remembered[0].superseded, 7);
  assert.equal(remembered[1].superseded, null);
});

test('Stage 1: captureFromTurn supplies existing workspace memories, passes AbortSignal, and logs model_usage', async () => {
  const usageLogs = [];
  let seenMessages = null;
  let seenSignal = null;
  const db = {
    hasMemoryExtraction: () => false,
    recordMemoryExtraction: () => {},
    searchMemories: () => [{ id: 12, title: 'Drink', content: 'Suka kopi hitam', memory_type: 'preference' }],
    listMemories: () => [],
    getMemory: ({ id }) => (id === 12 ? { id: 12 } : null),
    supersedeMemory: (args) => ({ oldId: args.oldId, newId: 13 }),
    logModelUsage: (entry) => usageLogs.push(entry)
  };
  const service = new MemoryService({
    db,
    provider: {
      embed: async () => [1, 0],
      chat: async ({ messages, signal }) => {
        seenMessages = messages;
        seenSignal = signal;
        return {
          model: 'fast-m',
          usage: { prompt_tokens: 50, completion_tokens: 20 },
          message: {
            content: JSON.stringify({
              memories: [{ title: 'Drink', content: 'Sekarang suka teh', memoryType: 'preference', importance: 4, supersedesId: 12 }]
            })
          }
        };
      }
    },
    router: { select: () => ({ tier: 'fast', model: 'fast-m' }) },
    logger: { warn: () => {} }
  });

  const okRes = await service.captureFromTurn({
    scope: 'personal',
    ownerId: 'owner',
    userText: 'Ingat mulai sekarang saya minum teh saja',
    assistantText: 'Dicatat!',
    sourceEventId: 'evt-sup-stage1'
  });
  assert.equal(okRes.captured, 1);
  assert.ok(seenSignal instanceof AbortSignal);
  assert.match(seenMessages[0].content, /"supersedesId"/);
  assert.match(seenMessages[1].content, /Existing workspace memories:/);
  assert.match(seenMessages[1].content, /Suka kopi hitam/);
  assert.equal(usageLogs.length, 1);
  assert.equal(usageLogs[0].outcome, 'success');

  const errService = new MemoryService({
    db: {
      hasMemoryExtraction: () => false,
      recordMemoryExtraction: () => {},
      searchMemories: () => [],
      listMemories: () => [],
      logModelUsage: (entry) => usageLogs.push(entry)
    },
    provider: { chat: async () => { throw new Error('provider down'); } },
    router: { select: () => ({ tier: 'fast', model: 'fast-m' }) },
    logger: { warn: () => {} }
  });
  await errService.captureFromTurn({
    scope: 'personal',
    ownerId: 'owner',
    userText: 'Ingat catatan penting ini',
    assistantText: 'OK',
    sourceEventId: 'evt-err-stage1'
  });
  assert.equal(usageLogs.length, 2);
  assert.equal(usageLogs[1].outcome, 'error');
});
