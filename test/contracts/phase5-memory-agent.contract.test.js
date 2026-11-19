const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DatabaseStore, MIGRATIONS } = require('../../src/db/database');
const { MemoryService, extractJsonObject } = require('../../src/memory/memory-service');
const { createMemoryTools } = require('../../src/memory/memory-tools');
const { registerAllTools } = require('../../src/agent/tool-registry');
const {
  SYSTEM_PROMPT,
  fitJsonArrayToBudget,
  trimHistoryToBudget,
  buildAgentMessages
} = require('../../src/agent/prompt-builder');
const { AgentRuntime } = require('../../src/agent/runtime');
const { RECOGNIZED_SLASH_COMMANDS, handleSlashCommand } = require('../../src/agent/command-handler');

const projectRoot = path.resolve(__dirname, '../..');
const OWNER = '628111111111@c.us';
const GROUP_A = '120363000000000001@g.us';
const GROUP_B = '120363000000000002@g.us';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-p5-contract-'));
  const db = new DatabaseStore(path.join(dir, 'test.sqlite'));
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('Phase 5 contract: Migration v11, memory lifecycle, and atomic agent-task transactions work in real SQLite', () => {
  const { db, cleanup } = makeTempDb();
  try {
    assert.equal(MIGRATIONS.some((m) => m.version === 11), true);
    const cols = new Set(db.db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name));
    assert.equal(cols.has('status'), true);
    assert.equal(cols.has('superseded_by'), true);
    const idx = db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_active_scope'").get();
    assert.ok(idx, 'Expected idx_memories_active_scope index');

    // Deduplication on active saveMemory
    const id1 = db.saveMemory({
      scope: 'personal',
      ownerId: OWNER,
      title: 'Coffee',
      content: 'Prefers black coffee without sugar',
      memoryType: 'preference',
      importance: 2
    });
    const id1Dup = db.saveMemory({
      scope: 'personal',
      ownerId: OWNER,
      title: '  coffee ',
      content: '  prefers black coffee without sugar ',
      memoryType: 'preference',
      importance: 5
    });
    assert.equal(id1Dup, id1);
    assert.equal(db.getMemory({ id: id1, scope: 'personal', ownerId: OWNER }).importance, 5);

    // Supersede lifecycle + search exclusion
    const sup = db.supersedeMemory({
      oldId: id1,
      scope: 'personal',
      ownerId: OWNER,
      newMemory: {
        title: 'Coffee',
        content: 'Prefers iced americano with oat milk',
        memoryType: 'preference',
        kind: 'preference',
        importance: 5
      }
    });
    assert.equal(sup.superseded, true);
    assert.notEqual(sup.newId, id1);
    const oldRow = db.getMemory({ id: id1, scope: 'personal', ownerId: OWNER });
    assert.equal(oldRow.status, 'superseded');
    assert.equal(oldRow.superseded_by, sup.newId);

    // updateMemory + read-hit updated_at preservation
    const beforeRead = db.getMemory({ id: sup.newId, scope: 'personal', ownerId: OWNER });
    const semanticHits = db.searchMemoriesSemantic({
      scope: 'personal',
      ownerId: OWNER,
      query: 'americano',
      limit: 5
    });
    assert.equal(semanticHits.length, 1);
    assert.equal(semanticHits[0].id, sup.newId);
    const afterRead = db.getMemory({ id: sup.newId, scope: 'personal', ownerId: OWNER });
    assert.equal(afterRead.updated_at, beforeRead.updated_at);

    const updated = db.updateMemory({
      id: sup.newId,
      scope: 'personal',
      ownerId: OWNER,
      fields: { content: 'Prefers hot espresso in the morning' }
    });
    assert.equal(updated.content, 'Prefers hot espresso in the morning');

    // Archive and hard delete
    const softDel = db.deleteMemory({ id: sup.newId, scope: 'personal', ownerId: OWNER, hard: false });
    assert.deepEqual(softDel, { deleted: true, id: sup.newId, mode: 'archived' });
    assert.equal(db.listMemories({ scope: 'personal', ownerId: OWNER, status: 'active' }).length, 0);

    const stats = db.getMemoryStats({ scope: 'personal', ownerId: OWNER });
    assert.equal(stats.activeCount, 0);
    assert.equal(stats.supersededCount, 1);
    assert.equal(stats.archivedCount, 1);

    const hardDel = db.deleteMemory({ id: sup.newId, scope: 'personal', ownerId: OWNER, hard: true });
    assert.deepEqual(hardDel, { deleted: true, id: sup.newId, mode: 'hard' });
    assert.equal(db.getMemory({ id: sup.newId, scope: 'personal', ownerId: OWNER }), null);

    // Atomic approval/task transitions in agent-task repository
    db.createTask({
      id: 'task-atomic-1',
      sourceEventId: 'evt-atomic-1',
      chatId: OWNER,
      requesterId: OWNER,
      scope: 'personal',
      requestText: 'Send message'
    });
    db.createApproval({
      id: 'ap-atomic-1',
      taskId: 'task-atomic-1',
      chatId: OWNER,
      requesterId: OWNER,
      toolName: 'send_whatsapp_message',
      arguments: { targetId: '6282@c.us', message: 'Hi' },
      expiresAt: new Date(Date.now() + 60000).toISOString()
    });
    assert.equal(db.getTask('task-atomic-1').status, 'running');
    assert.equal(db.denyApproval('ap-atomic-1'), true);
    assert.equal(db.getApproval('ap-atomic-1').status, 'denied');
    assert.equal(db.getTask('task-atomic-1').status, 'cancelled');

    db.createTask({
      id: 'task-atomic-2',
      sourceEventId: 'evt-atomic-2',
      chatId: OWNER,
      requesterId: OWNER,
      scope: 'personal',
      requestText: 'Send file'
    });
    db.createApproval({
      id: 'ap-atomic-2',
      taskId: 'task-atomic-2',
      chatId: OWNER,
      requesterId: OWNER,
      toolName: 'send_whatsapp_file',
      arguments: { targetId: '6282@c.us', filePath: '/tmp/a.pdf', filename: 'a.pdf' },
      expiresAt: new Date(Date.now() + 60000).toISOString()
    });
    const claimed = db.claimApproval('ap-atomic-2', OWNER, OWNER);
    assert.ok(claimed);
    db.finishApproval('ap-atomic-2', 'approved');
    assert.equal(db.getApproval('ap-atomic-2').status, 'approved');
    assert.equal(db.getTask('task-atomic-2').status, 'completed');

    const firstClaim = db.beginToolExecution({ idempotencyKey: 'key-1', taskId: 'task-atomic-2', toolName: 'remember_fact' });
    assert.deepEqual(firstClaim, { state: 'claimed' });
    db.failToolExecution('key-1', 'transient error', false);
    const retryClaim = db.beginToolExecution({ idempotencyKey: 'key-1', taskId: 'task-atomic-2', toolName: 'remember_fact' });
    assert.deepEqual(retryClaim, { state: 'claimed' });
  } finally {
    cleanup();
  }
});

test('Phase 5 contract: MemoryService supports extractJsonObject, backfillEmbeddings, consolidateWorkspace, update, and forget', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    let embedCalls = 0;
    const provider = {
      embed: async ({ input }) => {
        embedCalls++;
        return [input.length % 7, 1];
      },
      chat: async () => ({
        message: {
          content: 'Berikut hasil ekstraksi:\n```json\n{"memories":[{"title":"Schedule","content":"Standup moved to 10:00","memoryType":"fact","importance":4,"supersedesId":1}]}\n```\nSelesai.'
        }
      })
    };

    const parsed = extractJsonObject('Preamble {ignored} then {"ok":true,"nested":{"x":"}brace"}} trailing');
    assert.deepEqual(parsed, { ok: true, nested: { x: '}brace' } });
    assert.equal(extractJsonObject('no json here'), null);

    const svc = new MemoryService({
      db,
      provider,
      router: { select: () => ({ model: 'fast-m' }) },
      logger: { warn: () => {} }
    });

    const firstId = db.saveMemory({
      scope: 'personal',
      ownerId: OWNER,
      title: 'Schedule',
      content: 'Standup at 09:00',
      memoryType: 'fact',
      importance: 1
    });
    assert.equal(firstId, 1);

    const cap = await svc.captureFromTurn({
      scope: 'personal',
      ownerId: OWNER,
      userText: 'Ingat jadwal standup sekarang jam 10:00',
      assistantText: 'Dicatat.',
      sourceEventId: 'cap-supersede-1'
    });
    assert.equal(cap.captured, 1);
    assert.equal(db.getMemory({ id: firstId, scope: 'personal', ownerId: OWNER }).status, 'superseded');

    // Insert unembedded active row + duplicate-content old row directly to verify backfill & consolidation
    const staleDate = new Date(Date.now() - 200 * 86400000).toISOString();
    db.db.prepare(`
      INSERT INTO memories (scope,owner_id,chat_id,kind,memory_type,title,content,source,importance,status,created_at,last_accessed_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run('personal', OWNER, null, 'fact', 'fact', 'DupA', 'Duplicate fact', 'test', 4, 'active', staleDate, staleDate, staleDate);
    db.db.prepare(`
      INSERT INTO memories (scope,owner_id,chat_id,kind,memory_type,title,content,source,importance,status,created_at,last_accessed_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run('personal', OWNER, null, 'fact', 'fact', 'DupB', '  duplicate fact ', 'test', 2, 'active', staleDate, staleDate, staleDate);
    db.db.prepare(`
      INSERT INTO memories (scope,owner_id,chat_id,kind,memory_type,title,content,source,importance,status,created_at,last_accessed_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run('personal', OWNER, null, 'fact', 'fact', 'Old', 'Low importance stale note', 'test', 1, 'active', staleDate, staleDate, staleDate);

    const consolidated = await svc.consolidateWorkspace({ scope: 'personal', ownerId: OWNER, backfillLimit: 10 });
    assert.equal(consolidated.deduplicatedCount, 1);
    assert.equal(consolidated.archivedStaleCount, 1);
    assert.ok(consolidated.backfilledCount >= 1);
    assert.ok(embedCalls >= 1);

    const active = db.listMemories({ scope: 'personal', ownerId: OWNER, status: 'active' });
    const targetId = active[0].id;
    const upd = await svc.update({
      id: targetId,
      scope: 'personal',
      ownerId: OWNER,
      content: 'Updated memory content',
      importance: 5
    });
    assert.equal(upd.content, 'Updated memory content');
    assert.equal(upd.importance, 5);

    const forgotten = await svc.forget({ id: targetId, scope: 'personal', ownerId: OWNER, hard: false });
    assert.deepEqual(forgotten, { deleted: true, id: targetId, mode: 'archived' });
  } finally {
    cleanup();
  }
});

test('Phase 5 contract: all 12 memory tools enforce strict workspace isolation across personal and group scopes', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    const svc = new MemoryService({
      db,
      provider: { embed: async () => [0.5, 0.5] },
      router: {},
      logger: { warn: () => {} }
    });
    const tools = createMemoryTools({ db, memoryService: svc });
    assert.equal(tools.length, 12);

    const registry = registerAllTools({
      db,
      approvalManager: {},
      waha: {},
      responseHandler: {},
      memoryService: svc,
      documentService: {},
      webSearch: null,
      webFetch: null
    });
    const expectedTools = [
      'save_note', 'search_notes', 'remember_fact', 'search_memory',
      'list_memories', 'update_memory', 'forget_memory', 'consolidate_memories',
      'create_project', 'list_projects', 'update_project', 'list_memory_events'
    ];
    for (const name of expectedTools) {
      assert.ok(registry.get(name), `Expected tool ${name} to be registered`);
    }

    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const personalCtx = { scope: 'personal', requesterId: OWNER, chatId: OWNER };
    const groupACtx = { scope: 'group', requesterId: OWNER, chatId: GROUP_A };
    const groupBCtx = { scope: 'group', requesterId: OWNER, chatId: GROUP_B };

    const pMem = await byName.remember_fact.execute({ title: 'PersonalSecret', content: 'Personal PIN note' }, personalCtx);
    const gMem = await byName.remember_fact.execute({ title: 'GroupRule', content: 'Group deploy every Tuesday' }, groupACtx);

    const groupAList = await byName.list_memories.execute({}, groupACtx);
    assert.equal(groupAList.memories.length, 1);
    assert.equal(groupAList.memories[0].id, gMem.memoryId);

    const groupBList = await byName.list_memories.execute({}, groupBCtx);
    assert.equal(groupBList.memories.length, 0);

    // Group A cannot update or forget personal memory
    await assert.rejects(
      () => byName.update_memory.execute({ memoryId: pMem.memoryId, content: 'Hijacked' }, groupACtx),
      /tidak ditemukan/i
    );
    const crossForget = await byName.forget_memory.execute({ memoryId: pMem.memoryId }, groupACtx);
    assert.equal(crossForget.deleted, false);
    assert.equal(db.getMemory({ id: pMem.memoryId, scope: 'personal', ownerId: OWNER }).status, 'active');

    // Owner can supersede & consolidate in personal scope without affecting group A
    const sup = await byName.remember_fact.execute({
      title: 'PersonalSecret',
      content: 'Updated personal preference',
      supersedeId: pMem.memoryId
    }, personalCtx);
    assert.equal(sup.supersededId, pMem.memoryId);
    const cons = await byName.consolidate_memories.execute({ backfillLimit: 5 }, personalCtx);
    assert.equal(typeof cons.deduplicatedCount, 'number');
    assert.equal(db.listMemories({ scope: 'group', chatId: GROUP_A }).length, 1);
  } finally {
    cleanup();
  }
});

test('Phase 5 contract: prompt budget helpers guarantee valid JSON, runtime escalates dynamically, and /memory command works end-to-end', async () => {
  // 1. Prompt budget + SYSTEM_PROMPT
  assert.match(SYSTEM_PROMPT, /visualMode is "ocr_fallback"/);
  assert.match(SYSTEM_PROMPT, /temporalStatus is "insufficient_sample"/);
  for (const name of ['list_memories', 'update_memory', 'forget_memory', 'consolidate_memories', 'remember_fact', 'supersedeId']) {
    assert.match(SYSTEM_PROMPT, new RegExp(name));
  }

  const oversized = Array.from({ length: 30 }, (_, i) => ({ id: i, text: 'x'.repeat(250) }));
  const jsonStr = fitJsonArrayToBudget(oversized, 1000);
  assert.ok(jsonStr.length <= 1000);
  assert.equal(Array.isArray(JSON.parse(jsonStr)), true);

  const built = buildAgentMessages({
    text: 'Ringkas proyek',
    scope: 'group',
    history: [
      { role: 'user', sender: '6282@c.us', content: 'Pesan lama '.repeat(2000) },
      { role: 'assistant', sender: null, content: 'Jawaban singkat' }
    ],
    recentDocuments: oversized,
    memories: oversized.map((o) => ({ kind: 'fact', memory_type: 'fact', title: `T${o.id}`, content: o.text })),
    projects: oversized.map((o) => ({ id: `p${o.id}`, name: `N${o.id}`, description: o.text, status: 'active' }))
  });
  const trimmedDirect = trimHistoryToBudget([{ role: 'user', sender: '6282@c.us', content: 'z'.repeat(300) }], { maxChars: 100 });
  assert.equal(trimmedDirect[0].sender, '6282@c.us');
  assert.equal(trimmedDirect[0].content.endsWith('...[truncated]'), true);
  assert.equal(built[1].content.startsWith('[6282@c.us]: '), true);

  // 2. Runtime dynamic tier escalation
  const { db, cleanup } = makeTempDb();
  try {
    const svc = new MemoryService({
      db,
      provider: { embed: async () => [0.2, 0.8] },
      router: {},
      logger: { warn: () => {} }
    });
    const registry = registerAllTools({
      db,
      approvalManager: {},
      waha: {},
      responseHandler: {},
      memoryService: svc,
      documentService: {},
      webSearch: null,
      webFetch: null
    });

    const calls = [];
    let round = 0;
    const runtime = new AgentRuntime({
      provider: {
        chat: async ({ model }) => {
          calls.push(model);
          round++;
          if (round === 1) {
            return {
              message: {
                role: 'assistant',
                tool_calls: [{
                  id: 'mem-call-1',
                  type: 'function',
                  function: {
                    name: 'remember_fact',
                    arguments: JSON.stringify({ title: 'Kota', content: 'Domisili di Bandung' })
                  }
                }]
              },
              model,
              usage: {}
            };
          }
          return { message: { role: 'assistant', content: 'Sudah saya simpan.' }, model, usage: {} };
        }
      },
      router: {
        select: (task) => task === 'greeting'
          ? { tier: 'fast', model: 'claude-haiku-5-5', supportsTools: true }
          : { tier: 'balanced', model: 'claude-sonnet-5-5', supportsTools: true }
      },
      tools: registry,
      db,
      config: { agent: { maxRounds: 3, maxToolCalls: 4, maxToolResultChars: 1000, taskTimeoutMs: 3000, toolTimeoutMs: 1000 } },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
    });

    const runRes = await runtime.run({
      text: 'Halo',
      chatId: OWNER,
      requesterId: OWNER,
      scope: 'personal',
      sourceEventId: 'p5-contract-runtime-1'
    });
    assert.deepEqual(calls, ['claude-haiku-5-5', 'claude-sonnet-5-5']);
    assert.equal(runRes.escalatedFromTier, 'fast');
    assert.equal(runRes.tier, 'balanced');
    assert.equal(runRes.memoryToolsAvailable, true);

    // 3. /memory command (status, list, sync)
    assert.equal(RECOGNIZED_SLASH_COMMANDS.has('/memory'), true);
    const replies = [];
    const processor = {
      config: { ownerJid: OWNER },
      db,
      memoryService: svc,
      responseHandler: { sendText: async (text, chatId) => replies.push({ text, chatId }) }
    };

    await handleSlashCommand(processor, {
      text: '/memory status', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'c1'
    });
    await handleSlashCommand(processor, {
      text: '/memory list', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'c2'
    });
    await handleSlashCommand(processor, {
      text: '/memory sync', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'c3'
    });

    assert.match(replies[0].text, /Memori aktif: 1/);
    assert.match(replies[1].text, /\[fact\] Kota: Domisili di Bandung/);
    assert.match(replies[2].text, /Deduplikasi: 0/);

    // 4. MessageProcessor Phase 2 boundary + Phase 5 gate files
    const processorSrc = fs.readFileSync(path.join(projectRoot, 'src/agent/message-processor.js'), 'utf8');
    assert.equal(processorSrc.includes('classifyOperationalError('), false);
    assert.equal(fs.existsSync(path.join(projectRoot, 'scripts/phase5-regression.sh')), true);
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['test:phase5'], 'bash scripts/phase5-regression.sh');
  } finally {
    cleanup();
  }
});
