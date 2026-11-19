const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseStore } = require('../../../src/db/database');
const { MemoryService } = require('../../../src/memory/memory-service');
const { createMemoryTools } = require('../../../src/memory/memory-tools');

function memoryFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-memtools-'));
  const db = new DatabaseStore(path.join(dir, 'test.sqlite'));
  const memoryService = new MemoryService({
    db,
    provider: { embed: async () => [0.6, 0.8] },
    router: {},
    logger: { warn: () => {} }
  });
  const tools = createMemoryTools({ db, memoryService });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return {
    dir,
    db,
    memoryService,
    tools,
    byName,
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('save_note forwards kind to memoryService.remember and db.saveMemory', async () => {
  const remembered = [];
  const savedDirect = [];

  const withService = createMemoryTools({
    db: {},
    memoryService: {
      remember: async (args) => {
        remembered.push(args);
        return { saved: true, memoryId: 1 };
      }
    }
  });
  const saveWithService = withService.find((t) => t.name === 'save_note');
  await saveWithService.execute(
    { content: 'Selalu kirim ringkasan poin.', kind: 'preference' },
    { scope: 'personal', requesterId: '628111@c.us', chatId: '628111@c.us' }
  );
  assert.equal(remembered.length, 1);
  assert.equal(remembered[0].kind, 'preference');
  assert.equal(remembered[0].memoryType, 'preference');

  const withoutService = createMemoryTools({
    db: {
      saveMemory: (args) => {
        savedDirect.push(args);
        return 42;
      }
    },
    memoryService: null
  });
  const saveDirect = withoutService.find((t) => t.name === 'save_note');
  const directRes = await saveDirect.execute(
    { content: 'Catatan rapat Jumat.', kind: 'meeting' },
    { scope: 'group', requesterId: '628111@c.us', chatId: '12036300@g.us' }
  );
  assert.deepEqual(directRes, { saved: true, noteId: 42 });
  assert.equal(savedDirect[0].kind, 'meeting');
});

test('createMemoryTools exposes all 12 tools with strict Zod validation', () => {
  const f = memoryFixture();
  try {
    assert.equal(f.tools.length, 12);
    for (const name of [
      'save_note', 'search_notes', 'remember_fact', 'search_memory',
      'list_memories', 'update_memory', 'forget_memory', 'consolidate_memories',
      'create_project', 'list_projects', 'update_project', 'list_memory_events'
    ]) {
      assert.ok(f.byName[name], `Missing tool ${name}`);
      assert.deepEqual(f.byName[name].scopes, ['personal', 'group']);
    }

    assert.throws(() => f.byName.update_memory.schema.parse({ memoryId: 1 }));
    assert.throws(() => f.byName.update_memory.schema.parse({ memoryId: 1, content: 'ok', extra: true }));
    assert.throws(() => f.byName.forget_memory.schema.parse({ memoryId: -1 }));
    assert.throws(() => f.byName.remember_fact.schema.parse({ content: 'abc', supersedeId: 0 }));
    assert.throws(() => f.byName.list_memories.schema.parse({ limit: 100 }));
    assert.throws(() => f.byName.consolidate_memories.schema.parse({ backfillLimit: 99 }));
  } finally {
    f.close();
  }
});

test('Phase 5 memory tools enforce workspace isolation across lifecycle operations', async () => {
  const f = memoryFixture();
  try {
    const personalCtx = { scope: 'personal', requesterId: 'owner@c.us', chatId: 'owner@c.us' };
    const groupCtx = { scope: 'group', requesterId: 'member@c.us', chatId: 'group1@g.us' };

    const created = await f.byName.remember_fact.execute(
      { title: 'Language', content: 'Prefers Bahasa Indonesia', memoryType: 'preference', importance: 4 },
      personalCtx
    );
    assert.equal(created.saved, true);

    await f.byName.remember_fact.execute(
      { title: 'Group rule', content: 'Use English for client reports', memoryType: 'fact', importance: 3 },
      groupCtx
    );

    const personalListed = await f.byName.list_memories.execute({ status: 'active' }, personalCtx);
    assert.equal(personalListed.memories.length, 1);
    assert.equal(personalListed.memories[0].id, created.memoryId);

    const groupListed = await f.byName.list_memories.execute({ status: 'active' }, groupCtx);
    assert.equal(groupListed.memories.length, 1);
    assert.notEqual(groupListed.memories[0].id, created.memoryId);

    // Cross-workspace update/forget/supersede cannot mutate personal memory from group
    await assert.rejects(
      () => f.byName.update_memory.execute({ memoryId: created.memoryId, content: 'Tampered' }, groupCtx),
      /tidak ditemukan/
    );
    const foreignForget = await f.byName.forget_memory.execute({ memoryId: created.memoryId }, groupCtx);
    assert.equal(foreignForget.deleted, false);

    // Same-workspace update works
    const upd = await f.byName.update_memory.execute(
      { memoryId: created.memoryId, content: 'Prefers concise Bahasa Indonesia', importance: 5 },
      personalCtx
    );
    assert.equal(upd.updated, true);
    assert.equal(upd.memory.importance, 5);

    // Supersede via remember_fact
    const replaced = await f.byName.remember_fact.execute(
      { title: 'Language', content: 'Uses bilingual ID/EN', memoryType: 'preference', supersedeId: created.memoryId },
      personalCtx
    );
    assert.equal(replaced.supersededId, created.memoryId);
    const activeOnly = await f.byName.list_memories.execute({ status: 'active' }, personalCtx);
    assert.equal(activeOnly.memories.length, 1);
    assert.equal(activeOnly.memories[0].id, replaced.memoryId);

    // Consolidate and forget in personal workspace
    const cons = await f.byName.consolidate_memories.execute({ backfillLimit: 5 }, personalCtx);
    assert.deepEqual(cons, { deduplicatedCount: 0, archivedStaleCount: 0, backfilledCount: 0 });

    const forgotten = await f.byName.forget_memory.execute({ memoryId: replaced.memoryId, hard: false }, personalCtx);
    assert.deepEqual(forgotten, { deleted: true, id: replaced.memoryId, mode: 'archived' });
    assert.equal((await f.byName.list_memories.execute({ status: 'active' }, personalCtx)).memories.length, 0);
  } finally {
    f.close();
  }
});
