const test = require('node:test');
const assert = require('node:assert/strict');
const { cosineSimilarity } = require('../../src/p2/vector');
const { MemoryService, DURABLE_SIGNAL } = require('../../src/p2/memory-service');

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
