const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseStore, MIGRATIONS } = require('../../src/db/database');
const { classifyEventPriority } = require('../../src/app');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-db-'));
  const db = new DatabaseStore(path.join(dir, 'test.sqlite'));
  return { dir, db, close() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('inbox enqueue is idempotent and claimable', () => {
  const f = fixture();
  try {
    const event = { eventId: 'e1', chatId: 'c', senderId: 's', payload: { hello: 1 } };
    assert.equal(f.db.enqueueEvent(event), true);
    assert.equal(f.db.enqueueEvent(event), false);
    const claimed = f.db.claimNextEvent();
    assert.equal(claimed.event_id, 'e1');
    assert.deepEqual(claimed.payload, { hello: 1 });
    f.db.finishEvent('e1');
    assert.equal(f.db.claimNextEvent(), null);
  } finally { f.close(); }
});

test('personal and group memories are isolated', () => {
  const f = fixture();
  try {
    f.db.saveMemory({ scope: 'personal', ownerId: 'owner', content: 'private project' });
    f.db.saveMemory({ scope: 'group', chatId: 'group1', content: 'group meeting' });
    assert.equal(f.db.searchMemories({ scope: 'personal', ownerId: 'owner', query: 'private' }).length, 1);
    assert.equal(f.db.searchMemories({ scope: 'group', chatId: 'group1', query: 'private' }).length, 0);
    assert.equal(f.db.searchMemories({ scope: 'group', chatId: 'group1', query: 'meeting' }).length, 1);
  } finally { f.close(); }
});

test('approval is atomically claimed once by owner', () => {
  const f = fixture();
  try {
    f.db.createApproval({
      id: 'ap1', chatId: 'owner', requesterId: 'owner',
      toolName: 'send_whatsapp_message', arguments: { targetId: 'x', message: 'hi' },
      expiresAt: new Date(Date.now() + 60000).toISOString()
    });
    assert.equal(f.db.claimApproval('ap1', 'intruder', 'owner'), null);
    assert.ok(f.db.claimApproval('ap1', 'owner', 'owner'));
    assert.equal(f.db.claimApproval('ap1', 'owner', 'owner'), null);
  } finally { f.close(); }
});


test('task and tool execution idempotency prevent duplicate side effects on replay', () => {
  const f = fixture();
  try {
    const task = {
      id: 'task-1', sourceEventId: 'event-1', chatId: 'owner',
      requesterId: 'owner', scope: 'personal', requestText: 'send once'
    };
    f.db.createTask(task);
    f.db.createTask(task);
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);

    const key = 'same-action-key';
    assert.deepEqual(f.db.beginToolExecution({ idempotencyKey: key, taskId: 'task-1', toolName: 'save_note' }), { state: 'claimed' });
    f.db.completeToolExecution(key, { saved: true, noteId: 1 });
    assert.deepEqual(f.db.beginToolExecution({ idempotencyKey: key, taskId: 'task-1', toolName: 'save_note' }), {
      state: 'completed', output: { saved: true, noteId: 1 }
    });
  } finally { f.close(); }
});

test('task response outbox can only be claimed once', () => {
  const f = fixture();
  try {
    f.db.createTask({ id: 'task-r', chatId: 'c', requesterId: 'o', scope: 'personal', requestText: 'hello' });
    f.db.queueTaskResponse('task-r', 'Hello');
    assert.equal(f.db.claimTaskResponse('task-r'), 'Hello');
    assert.equal(f.db.claimTaskResponse('task-r'), null);
    f.db.finishTaskResponse('task-r', 'sent');
    assert.equal(f.db.claimTaskResponse('task-r'), null);
  } finally { f.close(); }
});

test('reminder creation is idempotent per source webhook event', () => {
  const f = fixture();
  try {
    const item = {
      chatId: 'owner', requesterId: 'owner', message: 'Drink water',
      dueAt: new Date(Date.now() + 60000).toISOString(), sourceEventId: 'reminder-event'
    };
    const first = f.db.createReminder(item);
    const second = f.db.createReminder(item);
    assert.equal(first, second);
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM reminders').get().n, 1);
  } finally { f.close(); }
});

test('stale reminder send is marked uncertain and not automatically requeued', () => {
  const f = fixture();
  try {
    const id = f.db.createReminder({
      chatId: 'owner', requesterId: 'owner', message: 'test',
      dueAt: new Date(Date.now() - 1000).toISOString()
    });
    const claimed = f.db.claimDueReminders();
    assert.equal(claimed.length, 1);
    f.db.recoverStaleReminders(-1);
    const row = f.db.db.prepare('SELECT status,delivery_uncertain FROM reminders WHERE id=?').get(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.delivery_uncertain, 1);
  } finally { f.close(); }
});


test('persistent rate limiter enforces window and recovers after restart', () => {
  const f = fixture();
  try {
    assert.equal(f.db.consumeRateLimit('group:user', { limit: 2, windowMs: 1000, now: 1000 }).allowed, true);
    assert.equal(f.db.consumeRateLimit('group:user', { limit: 2, windowMs: 1000, now: 1100 }).allowed, true);
    const blocked = f.db.consumeRateLimit('group:user', { limit: 2, windowMs: 1000, now: 1200 });
    assert.equal(blocked.allowed, false);
    assert.equal(f.db.consumeRateLimit('group:user', { limit: 2, windowMs: 1000, now: 2100 }).allowed, true);
  } finally { f.close(); }
});


test('P1 document records are isolated by personal/group scope', () => {
  const f = fixture();
  try {
    f.db.saveDocument({
      id: 'doc-personal', scope: 'personal', ownerId: 'owner',
      filename: 'private.pdf', mimeType: 'application/pdf',
      filePath: '/tmp/private.pdf', fileSize: 100, extractedText: 'confidential strategy'
    });
    f.db.saveDocument({
      id: 'doc-group', scope: 'group', chatId: 'group1',
      filename: 'minutes.pdf', mimeType: 'application/pdf',
      filePath: '/tmp/group.pdf', fileSize: 100, extractedText: 'meeting notes'
    });
    assert.ok(f.db.getDocument('doc-personal','personal','owner',null));
    assert.equal(f.db.getDocument('doc-personal','group',null,'group1'), null);
    assert.equal(f.db.searchDocuments({ scope:'group',chatId:'group1',query:'confidential' }).length, 0);
    assert.equal(f.db.searchDocuments({ scope:'group',chatId:'group1',query:'meeting' }).length, 1);
  } finally { f.close(); }
});

test('P1 task manager isolates tasks and supports status changes', () => {
  const f = fixture();
  try {
    const task = f.db.createUserTask({
      id:'user-task-1',scope:'personal',ownerId:'owner',
      title:'Prepare report',priority:'high'
    });
    assert.equal(task.title,'Prepare report');
    assert.equal(f.db.listUserTasks({ scope:'personal',ownerId:'owner' }).length,1);
    assert.equal(f.db.listUserTasks({ scope:'group',chatId:'group1' }).length,0);
    const updated = f.db.updateUserTask({
      id:'user-task-1',scope:'personal',ownerId:'owner',fields:{status:'completed'}
    });
    assert.equal(updated.status,'completed');
    assert.equal(f.db.updateUserTask({
      id:'user-task-1',scope:'group',chatId:'group1',fields:{status:'cancelled'}
    }),null);
  } finally { f.close(); }
});


test('P1 reminder cancellation has an explicit cancelled status', () => {
  const f = fixture();
  try {
    const id = f.db.createReminder({
      chatId:'owner',requesterId:'owner',message:'Cancel me',
      dueAt:new Date(Date.now()+60000).toISOString()
    });
    assert.equal(f.db.cancelReminder({ id,chatId:'owner',requesterId:'owner' }),true);
    const row = f.db.db.prepare('SELECT status FROM reminders WHERE id=?').get(id);
    assert.equal(row.status,'cancelled');
    assert.equal(f.db.cancelReminder({ id,chatId:'intruder',requesterId:'intruder' }),false);
  } finally { f.close(); }
});


test('P2 memory semantic fields and project scope isolation', () => {
  const f = fixture();
  try {
    const project = f.db.createProject({
      id: 'project-personal',
      scope: 'personal',
      ownerId: 'owner',
      name: 'Research Project',
      description: 'Research notes'
    });
    assert.equal(project.name, 'Research Project');

    const memoryId = f.db.saveMemory({
      scope: 'personal',
      ownerId: 'owner',
      title: 'Research preference',
      content: 'Prefers evidence-based research summaries',
      memoryType: 'preference',
      importance: 5,
      projectId: project.id,
      embedding: [1,0,0]
    });
    assert.ok(memoryId);

    const semantic = f.db.searchMemoriesSemantic({
      scope: 'personal',
      ownerId: 'owner',
      query: 'evidence research',
      queryEmbedding: [1,0,0],
      projectId: project.id
    });
    assert.equal(semantic.length, 1);
    assert.equal(semantic[0].memory_type, 'preference');

    assert.equal(f.db.searchMemoriesSemantic({
      scope: 'group',
      chatId: 'group-x',
      query: 'evidence research',
      queryEmbedding: [1,0,0]
    }).length, 0);

    assert.equal(f.db.listProjects({
      scope: 'group',
      chatId: 'group-x'
    }).length, 0);
  } finally { f.close(); }
});

test('P2 episodic events are idempotent per inbound event', () => {
  const f = fixture();
  try {
    const a = f.db.saveMemoryEvent({
      scope: 'personal', ownerId: 'owner',
      eventType: 'conversation_turn',
      summary: 'Discussed project milestone',
      sourceEventId: 'event-episodic-1'
    });
    const b = f.db.saveMemoryEvent({
      scope: 'personal', ownerId: 'owner',
      eventType: 'conversation_turn',
      summary: 'Duplicate event',
      sourceEventId: 'event-episodic-1'
    });
    assert.equal(a, b);
    assert.equal(f.db.listMemoryEvents({
      scope: 'personal', ownerId: 'owner'
    }).length, 1);
  } finally { f.close(); }
});


test('P3 voice reply preference is persisted per owner chat', () => {
  const f = fixture();
  try {
    assert.equal(f.db.getChatPreference({chatId:'owner@c.us',requesterId:'owner@c.us'}),false);
    assert.equal(f.db.setVoiceReplyPreference({
      chatId:'owner@c.us',requesterId:'owner@c.us',enabled:true
    }),true);
    assert.equal(f.db.getChatPreference({chatId:'owner@c.us',requesterId:'owner@c.us'}),true);
    assert.equal(f.db.getChatPreference({chatId:'other@c.us',requesterId:'other@c.us'}),false);
    assert.equal(f.db.setVoiceReplyPreference({
      chatId:'owner@c.us',requesterId:'owner@c.us',enabled:false
    }),false);
  } finally { f.close(); }
});


test('P3 voice output mode is persisted independently per chat', () => {
  const f = fixture();
  try {
    const owner = 'owner@c.us';
    assert.equal(f.db.getChatOutputMode({
      chatId: owner, requesterId: owner, defaultMode: 'text'
    }), 'text');
    assert.equal(f.db.setChatOutputMode({
      chatId: owner, requesterId: owner, mode: 'voice'
    }), 'voice');
    assert.equal(f.db.getChatOutputMode({
      chatId: owner, requesterId: owner, defaultMode: 'text'
    }), 'voice');
    assert.equal(f.db.getChatOutputMode({
      chatId: 'group@g.us', requesterId: owner, defaultMode: 'text'
    }), 'text');
    assert.equal(f.db.setChatOutputMode({
      chatId: 'group@g.us', requesterId: owner, mode: 'both'
    }), 'both');
    assert.throws(() => f.db.setChatOutputMode({
      chatId: owner, requesterId: owner, mode: 'invalid'
    }), /Unsupported chat output mode/);
  } finally { f.close(); }
});


test('P3 voice output preference persists across database reopen and reset restores configured default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-voice-persistence-'));
  const dbPath = path.join(dir, 'voice.sqlite');
  const owner = 'owner@c.us';
  try {
    let db = new DatabaseStore(dbPath);
    assert.deepEqual(db.getChatOutputPreference({
      chatId: owner, requesterId: owner, defaultMode: 'both'
    }), { mode: 'both', isCustom: false });

    db.setChatOutputMode({ chatId: owner, requesterId: owner, mode: 'voice' });
    db.setChatOutputMode({ chatId: 'group-a@g.us', requesterId: owner, mode: 'text' });
    db.close();

    db = new DatabaseStore(dbPath);
    assert.deepEqual(db.getChatOutputPreference({
      chatId: owner, requesterId: owner, defaultMode: 'both'
    }), { mode: 'voice', isCustom: true });
    assert.deepEqual(db.getChatOutputPreference({
      chatId: 'group-a@g.us', requesterId: owner, defaultMode: 'both'
    }), { mode: 'text', isCustom: true });
    assert.deepEqual(db.getChatOutputPreference({
      chatId: 'group-b@g.us', requesterId: owner, defaultMode: 'both'
    }), { mode: 'both', isCustom: false });

    assert.equal(db.resetChatOutputMode({ chatId: owner, requesterId: owner }), true);
    assert.deepEqual(db.getChatOutputPreference({
      chatId: owner, requesterId: owner, defaultMode: 'both'
    }), { mode: 'both', isCustom: false });
    assert.deepEqual(db.getChatOutputPreference({
      chatId: 'group-a@g.us', requesterId: owner, defaultMode: 'both'
    }), { mode: 'text', isCustom: true });
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P3 voice preference reset is safe when chat has no stored override', () => {
  const f = fixture();
  try {
    assert.equal(f.db.resetChatOutputMode({
      chatId: 'new-chat@g.us', requesterId: 'owner@c.us'
    }), false);
    assert.deepEqual(f.db.getChatOutputPreference({
      chatId: 'new-chat@g.us', requesterId: 'owner@c.us', defaultMode: 'text'
    }), { mode: 'text', isCustom: false });
  } finally { f.close(); }
});


test('generated document file path is retrievable only inside its workspace', () => {
  const f = fixture();
  try {
    f.db.saveDocument({
      id: 'generated-doc-1',
      scope: 'group',
      chatId: 'group-a@g.us',
      filename: 'proposal.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filePath: '/private/generated/proposal.docx',
      fileSize: 2048,
      extractedText: 'Proposal content'
    });
    const allowed = f.db.getDocumentFile('generated-doc-1', 'group', null, 'group-a@g.us');
    assert.equal(allowed.file_path, '/private/generated/proposal.docx');
    assert.equal(f.db.getDocumentFile('generated-doc-1', 'group', null, 'group-b@g.us'), null);
    assert.equal(f.db.getDocumentFile('generated-doc-1', 'personal', 'owner', null), null);
  } finally { f.close(); }
});


test('pending approvals are returned only for the matching chat and only before expiry', () => {
  const f = fixture();
  try {
    const future = new Date(Date.now() + 60000).toISOString();
    const past = new Date(Date.now() - 60000).toISOString();
    f.db.createApproval({
      id: 'pending-owner', chatId: 'owner@c.us', requesterId: 'owner@c.us',
      toolName: 'send_whatsapp_file', arguments: { targetId: 'owner@c.us', filename: 'a.docx' },
      expiresAt: future
    });
    f.db.createApproval({
      id: 'pending-group', chatId: 'group@g.us', requesterId: 'owner@c.us',
      toolName: 'send_whatsapp_file', arguments: { targetId: 'group@g.us', filename: 'b.docx' },
      expiresAt: future
    });
    f.db.createApproval({
      id: 'expired-owner', chatId: 'owner@c.us', requesterId: 'owner@c.us',
      toolName: 'send_whatsapp_file', arguments: { targetId: 'owner@c.us', filename: 'old.docx' },
      expiresAt: past
    });

    assert.deepEqual(
      f.db.getPendingApprovalsForChat('owner@c.us').map((item) => item.id),
      ['pending-owner']
    );
    assert.deepEqual(
      f.db.getPendingApprovalsForChat('group@g.us').map((item) => item.id),
      ['pending-group']
    );
    assert.deepEqual(f.db.getPendingApprovalsForChat('other@g.us'), []);
  } finally { f.close(); }
});

test('searchMemoriesSemantic tokenizes multi-word lexical queries when queryEmbedding is null', () => {
  const f = fixture();
  try {
    f.db.saveMemory({
      scope: 'personal',
      ownerId: 'owner@c.us',
      title: 'Preferensi Kopi',
      content: 'Owner menyukai kopi tubruk tanpa gula setiap pagi.',
      memoryType: 'preference',
      importance: 4
    });
    f.db.saveMemory({
      scope: 'personal',
      ownerId: 'owner@c.us',
      title: 'Jadwal Olahraga',
      content: 'Jogging rutin setiap hari Sabtu pagi.',
      memoryType: 'fact',
      importance: 3
    });

    const matches = f.db.searchMemoriesSemantic({
      scope: 'personal',
      ownerId: 'owner@c.us',
      query: 'kopi tubruk gula',
      queryEmbedding: null,
      limit: 5
    });

    assert.equal(matches.length, 1);
    assert.match(matches[0].content, /kopi tubruk/);
    assert.ok(matches[0].lexicalScore > 0);
  } finally { f.close(); }
});

test('Migration v10 allows the same sourceEventId across distinct scopes and indexes rate_limit_events', () => {
  const f = fixture();
  try {
    const personalId = f.db.saveMemoryEvent({
      scope: 'personal',
      ownerId: 'owner@c.us',
      eventType: 'conversation_turn',
      summary: 'Personal turn summary',
      sourceEventId: 'shared-source-evt-1'
    });
    const groupId = f.db.saveMemoryEvent({
      scope: 'group',
      chatId: 'group1@g.us',
      eventType: 'conversation_turn',
      summary: 'Group turn summary',
      sourceEventId: 'shared-source-evt-1'
    });
    const personalIdRepeat = f.db.saveMemoryEvent({
      scope: 'personal',
      ownerId: 'owner@c.us',
      eventType: 'conversation_turn',
      summary: 'Duplicate personal turn summary',
      sourceEventId: 'shared-source-evt-1'
    });

    assert.ok(personalId);
    assert.ok(groupId);
    assert.notEqual(personalId, groupId);
    assert.equal(personalIdRepeat, personalId);
    assert.equal(f.db.listMemoryEvents({ scope: 'personal', ownerId: 'owner@c.us' }).length, 1);
    assert.equal(f.db.listMemoryEvents({ scope: 'group', chatId: 'group1@g.us' }).length, 1);

    const versionRow = f.db.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
    assert.ok(versionRow.v >= 10);
    assert.ok(f.db.db.prepare('SELECT 1 FROM schema_migrations WHERE version=10').get());
    const rateIndex = f.db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_rate_limit_events_created_at'").get();
    assert.ok(rateIndex);
  } finally { f.close(); }
});

test('Migration v11 adds memory lifecycle columns and upgrades pre-v11 databases safely', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-v11-upgrade-'));
  const dbPath = path.join(dir, 'upgrade.sqlite');
  try {
    const Database = require('better-sqlite3');
    const rawDb = new Database(dbPath);
    rawDb.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL CHECK(scope IN ('personal','group')),
        owner_id TEXT,
        chat_id TEXT,
        kind TEXT NOT NULL DEFAULT 'note',
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'conversation',
        created_at TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT 'fact',
        title TEXT,
        embedding_json TEXT,
        importance INTEGER NOT NULL DEFAULT 3,
        project_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        last_accessed_at TEXT,
        updated_at TEXT
      );
      INSERT INTO memories (scope, owner_id, content, created_at, updated_at, last_accessed_at)
      VALUES ('personal', 'owner@c.us', 'Legacy memory row', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      CREATE TABLE inbox_events (
        event_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','processing','completed','failed','dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        locked_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    for (let v = 1; v <= 10; v++) {
      rawDb.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(v, '2026-01-01T00:00:00.000Z');
    }
    rawDb.close();

    const upgraded = new DatabaseStore(dbPath);
    try {
      const versionRow = upgraded.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
      assert.ok(versionRow.v >= 11);
      assert.ok(upgraded.db.prepare('SELECT 1 FROM schema_migrations WHERE version=11').get());
      const cols = new Set(upgraded.db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name));
      assert.equal(cols.has('status'), true);
      assert.equal(cols.has('superseded_by'), true);
      const activeIdx = upgraded.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_active_scope'").get();
      assert.ok(activeIdx);

      const legacy = upgraded.getMemory({ id: 1, scope: 'personal', ownerId: 'owner@c.us' });
      assert.equal(legacy.status, 'active');
      assert.equal(legacy.superseded_by, null);
      assert.equal(legacy.embedded, false);
    } finally {
      upgraded.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memory lifecycle: dedup, read-only last_accessed_at, get/list/update/supersede/delete, consolidation, stats', () => {
  const f = fixture();
  try {
    const project = f.db.createProject({
      id: 'proj-v11', scope: 'personal', ownerId: 'owner@c.us', name: 'Phase 5'
    });

    // Active content deduplication normalizes title & content and keeps max importance
    const firstId = f.db.saveMemory({
      scope: 'personal',
      ownerId: 'owner@c.us',
      title: ' Coffee ',
      content: '  Prefers black coffee  ',
      memoryType: 'preference',
      importance: 2,
      projectId: project.id
    });
    const dedupId = f.db.saveMemory({
      scope: 'personal',
      ownerId: 'owner@c.us',
      title: 'coffee',
      content: 'prefers black coffee',
      memoryType: 'preference',
      importance: 5,
      embedding: [1, 0]
    });
    assert.equal(dedupId, firstId);
    const afterDedup = f.db.getMemory({ id: firstId, scope: 'personal', ownerId: 'owner@c.us' });
    assert.equal(afterDedup.importance, 5);
    assert.equal(afterDedup.embedded, true);
    assert.equal('embedding_json' in afterDedup, false);

    // Distinct workspace does not deduplicate against personal workspace
    const groupId = f.db.saveMemory({
      scope: 'group',
      chatId: 'grp@g.us',
      title: 'coffee',
      content: 'prefers black coffee',
      importance: 3
    });
    assert.notEqual(groupId, firstId);
    assert.equal(f.db.getMemory({ id: firstId, scope: 'group', chatId: 'grp@g.us' }), null);

    // searchMemoriesSemantic updates last_accessed_at ONLY, preserving updated_at
    const sentinelTime = '2026-01-01T00:00:00.000Z';
    f.db.db.prepare('UPDATE memories SET updated_at=?, last_accessed_at=? WHERE id=?')
      .run(sentinelTime, sentinelTime, firstId);
    const hits = f.db.searchMemoriesSemantic({
      scope: 'personal',
      ownerId: 'owner@c.us',
      query: 'black coffee',
      queryEmbedding: [1, 0]
    });
    assert.equal(hits.length, 1);
    const afterRead = f.db.getMemory({ id: firstId, scope: 'personal', ownerId: 'owner@c.us' });
    assert.equal(afterRead.updated_at, sentinelTime);
    assert.notEqual(afterRead.last_accessed_at, sentinelTime);

    // updateMemory respects workspace boundaries and updates allowed fields
    assert.equal(f.db.updateMemory({
      id: firstId, scope: 'group', chatId: 'grp@g.us', fields: { content: 'hacked' }
    }), null);
    const updated = f.db.updateMemory({
      id: firstId, scope: 'personal', ownerId: 'owner@c.us',
      fields: { content: 'Prefers espresso without sugar', importance: 4 }
    });
    assert.equal(updated.content, 'Prefers espresso without sugar');
    assert.equal(updated.importance, 4);

    // supersedeMemory atomically replaces old memory and hides old row from active queries
    const sup = f.db.supersedeMemory({
      oldId: firstId,
      scope: 'personal',
      ownerId: 'owner@c.us',
      newMemory: {
        title: 'Coffee',
        content: 'Prefers oat milk latte',
        memoryType: 'preference',
        importance: 5,
        embedding: [0, 1]
      }
    });
    assert.equal(sup.superseded, true);
    assert.equal(sup.oldId, firstId);
    assert.notEqual(sup.newId, firstId);
    const oldAfterSup = f.db.getMemory({ id: firstId, scope: 'personal', ownerId: 'owner@c.us' });
    assert.equal(oldAfterSup.status, 'superseded');
    assert.equal(oldAfterSup.superseded_by, sup.newId);

    // Self-supersession guard when newMemory deduplicates to oldId
    const selfSup = f.db.supersedeMemory({
      oldId: sup.newId,
      scope: 'personal',
      ownerId: 'owner@c.us',
      newMemory: { title: 'coffee', content: 'prefers oat milk latte', importance: 5 }
    });
    assert.equal(selfSup.newId, sup.newId);
    assert.equal(selfSup.memory.status, 'active');
    assert.equal(selfSup.memory.superseded_by, null);

    // Missing/foreign oldId throws and rolls back
    assert.throws(() => f.db.supersedeMemory({
      oldId: firstId,
      scope: 'group',
      chatId: 'grp@g.us',
      newMemory: { content: 'should not insert' }
    }), /tidak ditemukan/);
    assert.equal(f.db.listMemories({ scope: 'group', chatId: 'grp@g.us' }).length, 1);

    // listMemories filters by status & includeArchived in searches
    assert.equal(f.db.listMemories({ scope: 'personal', ownerId: 'owner@c.us', status: 'active' }).length, 1);
    assert.equal(f.db.listMemories({ scope: 'personal', ownerId: 'owner@c.us', status: 'superseded' }).length, 1);
    assert.equal(f.db.listMemories({ scope: 'personal', ownerId: 'owner@c.us', status: null }).length, 2);
    assert.equal(f.db.searchMemories({ scope: 'personal', ownerId: 'owner@c.us', query: 'espresso' }).length, 0);
    assert.equal(f.db.searchMemories({ scope: 'personal', ownerId: 'owner@c.us', query: 'espresso', includeArchived: true }).length, 1);

    // Insert direct duplicate & stale low-importance row for consolidation
    f.db.db.prepare(`
      INSERT INTO memories (scope, owner_id, chat_id, kind, content, source, created_at, memory_type, importance, metadata_json, last_accessed_at, updated_at, status)
      VALUES ('personal', 'owner@c.us', NULL, 'fact', 'Duplicate note', 'test', '2026-10-01T00:00:00.000Z', 'fact', 2, '{}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'active'),
             ('personal', 'owner@c.us', NULL, 'fact', ' duplicate note ', 'test', '2026-10-02T00:00:00.000Z', 'fact', 4, '{}', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 'active'),
             ('personal', 'owner@c.us', NULL, 'fact', 'Ancient trivial fact', 'test', '2020-01-01T00:00:00.000Z', 'fact', 1, '{}', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 'active')
    `).run();

    const unembedded = f.db.listUnembeddedMemories({ scope: 'personal', ownerId: 'owner@c.us', limit: 10 });
    assert.equal(unembedded.length, 3);

    const consolidated = f.db.consolidateWorkspaceMemories({
      scope: 'personal', ownerId: 'owner@c.us', staleDays: 180
    });
    assert.deepEqual(consolidated, { deduplicatedCount: 1, archivedStaleCount: 1 });

    // Highest-importance duplicate survived; lower-importance & stale rows archived
    const remainingUnembedded = f.db.listUnembeddedMemories({ scope: 'personal', ownerId: 'owner@c.us' });
    assert.equal(remainingUnembedded.length, 1);
    assert.equal(remainingUnembedded[0].content, ' duplicate note ');
    assert.equal(f.db.setMemoryEmbedding(remainingUnembedded[0].id, [0.5, 0.5]), true);

    // Stats check
    f.db.saveMemoryEvent({
      scope: 'personal', ownerId: 'owner@c.us', eventType: 'note', summary: 'event 1'
    });
    const stats = f.db.getMemoryStats({ scope: 'personal', ownerId: 'owner@c.us' });
    assert.deepEqual(stats, {
      activeCount: 2,
      supersededCount: 1,
      archivedCount: 2,
      unembeddedCount: 0,
      projectCount: 1,
      eventCount: 1
    });

    // Soft and hard deleteMemory
    const softDel = f.db.deleteMemory({ id: remainingUnembedded[0].id, scope: 'personal', ownerId: 'owner@c.us', hard: false });
    assert.deepEqual(softDel, { deleted: true, id: remainingUnembedded[0].id, mode: 'archived' });
    assert.equal(f.db.getMemory({ id: remainingUnembedded[0].id, scope: 'personal', ownerId: 'owner@c.us' }).status, 'archived');

    const hardDel = f.db.deleteMemory({ id: remainingUnembedded[0].id, scope: 'personal', ownerId: 'owner@c.us', hard: true });
    assert.deepEqual(hardDel, { deleted: true, id: remainingUnembedded[0].id, mode: 'hard' });
    assert.equal(f.db.getMemory({ id: remainingUnembedded[0].id, scope: 'personal', ownerId: 'owner@c.us' }), null);
  } finally { f.close(); }
});

test('agent task repository approval and execution transitions are atomic', () => {
  const f = fixture();
  try {
    const future = new Date(Date.now() + 60000).toISOString();
    const past = new Date(Date.now() - 60000).toISOString();

    f.db.createTask({ id: 't-deny', chatId: 'owner', requesterId: 'owner', scope: 'personal', requestText: 'msg' });
    f.db.createApproval({
      id: 'ap-deny', taskId: 't-deny', chatId: 'owner', requesterId: 'owner',
      toolName: 'send_whatsapp_message', arguments: { targetId: 'x@c.us', message: 'hi' }, expiresAt: future
    });
    assert.equal(f.db.denyApproval('ap-deny'), true);
    assert.equal(f.db.getApproval('ap-deny').status, 'denied');
    assert.equal(f.db.getTask('t-deny').status, 'cancelled');

    f.db.createTask({ id: 't-exp', chatId: 'owner', requesterId: 'owner', scope: 'personal', requestText: 'msg' });
    f.db.createApproval({
      id: 'ap-exp', taskId: 't-exp', chatId: 'owner', requesterId: 'owner',
      toolName: 'send_whatsapp_message', arguments: { targetId: 'x@c.us', message: 'hi' }, expiresAt: past
    });
    assert.equal(f.db.denyApproval('ap-exp'), false);
    assert.equal(f.db.getApproval('ap-exp').status, 'expired');
    assert.equal(f.db.getTask('t-exp').status, 'cancelled');

    f.db.createTask({ id: 't-fin', chatId: 'owner', requesterId: 'owner', scope: 'personal', requestText: 'msg' });
    f.db.createApproval({
      id: 'ap-fin', taskId: 't-fin', chatId: 'owner', requesterId: 'owner',
      toolName: 'send_whatsapp_message', arguments: { targetId: 'x@c.us', message: 'hi' }, expiresAt: future
    });
    assert.ok(f.db.claimApproval('ap-fin', 'owner', 'owner'));
    f.db.finishApproval('ap-fin', 'approved');
    assert.equal(f.db.getApproval('ap-fin').status, 'approved');
    assert.equal(f.db.getTask('t-fin').status, 'completed');
    // Calling denyApproval after approval is already completed must not overwrite completed task
    assert.equal(f.db.denyApproval('ap-fin'), false);
    assert.equal(f.db.getTask('t-fin').status, 'completed');

    // Failed tool execution can be retried atomically via beginToolExecution
    f.db.createTask({ id: 't-exec', chatId: 'owner', requesterId: 'owner', scope: 'personal', requestText: 'exec' });
    assert.deepEqual(f.db.beginToolExecution({ idempotencyKey: 'k-retry', taskId: 't-exec', toolName: 'save_note' }), { state: 'claimed' });
    f.db.failToolExecution('k-retry', 'transient error', false);
    assert.deepEqual(f.db.beginToolExecution({ idempotencyKey: 'k-retry', taskId: 't-exec', toolName: 'save_note' }), { state: 'claimed' });
  } finally { f.close(); }
});

test('Migration v12 adds inbox_events.priority and queue indexes safely on pre-v12 databases', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-v12-upgrade-'));
  const dbPath = path.join(dir, 'v12.sqlite');
  try {
    assert.equal(MIGRATIONS.some((m) => m.version === 12), true);
    const Database = require('better-sqlite3');
    const rawDb = new Database(dbPath);
    rawDb.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE inbox_events (
        event_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','processing','completed','failed','dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        locked_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO inbox_events (event_id, chat_id, sender_id, payload_json, status, attempts, available_at, created_at, updated_at)
      VALUES ('legacy-evt', '6281@c.us', '6281@c.us', '{"body":"legacy"}', 'pending', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    for (let v = 1; v <= 11; v++) {
      rawDb.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(v, '2026-01-01T00:00:00.000Z');
    }
    rawDb.close();

    const upgraded = new DatabaseStore(dbPath);
    try {
      const versionRow = upgraded.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
      assert.ok(versionRow.v >= 12);
      assert.ok(upgraded.db.prepare('SELECT 1 FROM schema_migrations WHERE version=12').get());

      const cols = new Set(upgraded.db.prepare('PRAGMA table_info(inbox_events)').all().map((c) => c.name));
      assert.equal(cols.has('priority'), true);

      const idxReady = upgraded.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_inbox_priority_ready'").get();
      const idxChat = upgraded.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_inbox_chat_status'").get();
      assert.ok(idxReady);
      assert.ok(idxChat);

      const claimed = upgraded.claimNextEvent();
      assert.equal(claimed.event_id, 'legacy-evt');
      assert.equal(claimed.priority, 5);
    } finally {
      upgraded.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Phase 6 queue enforces priority ordering, clamping, and per-chat FIFO serialization', () => {
  const f = fixture();
  try {
    // Clamping & fallback defaults
    assert.equal(f.db.enqueueEvent({ eventId: 'grp-1', chatId: 'grpA@g.us', senderId: 'u1@c.us', payload: { n: 1 }, priority: 99 }), true);
    assert.equal(f.db.enqueueEvent({ eventId: 'dm-1', chatId: 'dmA@c.us', senderId: 'dmA@c.us', payload: { n: 2 }, priority: 2 }), true);
    assert.equal(f.db.enqueueEvent({ eventId: 'cmd-1', chatId: 'dmA@c.us', senderId: 'dmA@c.us', payload: { n: 3 }, priority: 0 }), true);
    assert.equal(f.db.enqueueEvent({ eventId: 'bad-prio', chatId: 'dmB@c.us', senderId: 'dmB@c.us', payload: { n: 4 }, priority: 'urgent' }), true);
    assert.equal(f.db.enqueueEvent({ eventId: 'null-prio', chatId: 'dmC@c.us', senderId: 'dmC@c.us', payload: { n: 5 }, priority: null }), true);

    const rowGrp = f.db.db.prepare('SELECT priority FROM inbox_events WHERE event_id=?').get('grp-1');
    const rowCmd = f.db.db.prepare('SELECT priority FROM inbox_events WHERE event_id=?').get('cmd-1');
    const rowBad = f.db.db.prepare('SELECT priority FROM inbox_events WHERE event_id=?').get('bad-prio');
    const rowNull = f.db.db.prepare('SELECT priority FROM inbox_events WHERE event_id=?').get('null-prio');
    assert.equal(rowGrp.priority, 10);
    assert.equal(rowCmd.priority, 1);
    assert.equal(rowBad.priority, 5);
    assert.equal(rowNull.priority, 5);

    // 1. Claims priority 1 (cmd-1 on dmA@c.us) first
    const first = f.db.claimNextEvent();
    assert.equal(first.event_id, 'cmd-1');
    assert.equal(first.priority, 1);

    // 2. dm-1 (priority 2) is also on dmA@c.us, which is currently processing -> skipped!
    // Next claim skips dmA@c.us and claims priority 5 (bad-prio on dmB@c.us, FIFO before null-prio)
    const second = f.db.claimNextEvent();
    assert.equal(second.event_id, 'bad-prio');

    const third = f.db.claimNextEvent();
    assert.equal(third.event_id, 'null-prio');

    const fourth = f.db.claimNextEvent();
    assert.equal(fourth.event_id, 'grp-1');

    // No other chats have pending work; dm-1 is still blocked while cmd-1 is processing
    assert.equal(f.db.claimNextEvent(), null);

    // Finish cmd-1 -> dm-1 on dmA@c.us is now claimable
    f.db.finishEvent('cmd-1');
    const fifth = f.db.claimNextEvent();
    assert.equal(fifth.event_id, 'dm-1');
  } finally { f.close(); }
});

test('Phase 6 queue stats, dead-letter listing, and safe requeueDeadEvent checks', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.db.getQueueStats(), {
      pendingCount: 0,
      processingCount: 0,
      failedCount: 0,
      deadCount: 0,
      completedCount: 0,
      oldestPendingAt: null
    });

    f.db.enqueueEvent({ eventId: 'ev-pending', chatId: 'c1@c.us', senderId: 'c1@c.us', payload: {}, priority: 2 });
    f.db.enqueueEvent({ eventId: 'ev-failed', chatId: 'c2@c.us', senderId: 'c2@c.us', payload: {}, priority: 5 });
    f.db.enqueueEvent({ eventId: 'ev-dead-safe', chatId: 'c3@c.us', senderId: 'c3@c.us', payload: {}, priority: 5 });
    f.db.enqueueEvent({ eventId: 'ev-dead-uncertain-err', chatId: 'c4@c.us', senderId: 'c4@c.us', payload: {}, priority: 5 });
    f.db.enqueueEvent({ eventId: 'ev-dead-uncertain-task', chatId: 'c5@c.us', senderId: 'c5@c.us', payload: {}, priority: 5 });
    f.db.enqueueEvent({ eventId: 'ev-done', chatId: 'c6@c.us', senderId: 'c6@c.us', payload: {}, priority: 5 });

    // Transition statuses via SQL/repo
    f.db.db.prepare("UPDATE inbox_events SET status='failed', last_error='timeout: transient' WHERE event_id=?").run('ev-failed');
    f.db.failEvent('ev-dead-safe', 'internal: temporary outage', 5, 5);
    f.db.failEvent('ev-dead-uncertain-err', 'delivery_uncertain: WAHA timeout', 5, 5);
    f.db.failEvent('ev-dead-uncertain-task', 'internal: post-send crash', 5, 5);
    f.db.createTask({
      id: 'task-uncertain-1',
      sourceEventId: 'ev-dead-uncertain-task',
      chatId: 'c5@c.us',
      requesterId: 'c5@c.us',
      scope: 'personal',
      requestText: 'send'
    });
    f.db.updateTask('task-uncertain-1', { response_status: 'uncertain' });
    f.db.finishEvent('ev-done');

    const stats = f.db.getQueueStats();
    assert.equal(stats.pendingCount, 1);
    assert.equal(stats.processingCount, 0);
    assert.equal(stats.failedCount, 1);
    assert.equal(stats.deadCount, 3);
    assert.equal(stats.completedCount, 1);
    assert.equal(typeof stats.oldestPendingAt, 'string');

    // listDeadEvents with filtering & bounds
    const allDead = f.db.listDeadEvents({ limit: 100 });
    assert.equal(allDead.length, 3);
    const chatDead = f.db.listDeadEvents({ chatId: 'c3@c.us', limit: 0 });
    assert.equal(chatDead.length, 1);
    assert.equal(chatDead[0].event_id, 'ev-dead-safe');

    // requeueDeadEvent refusal cases
    assert.deepEqual(f.db.requeueDeadEvent('missing-id'), { requeued: false, reason: 'not_found' });
    assert.deepEqual(f.db.requeueDeadEvent('ev-pending'), { requeued: false, reason: 'not_dead_or_failed' });
    assert.deepEqual(f.db.requeueDeadEvent('ev-done'), { requeued: false, reason: 'not_dead_or_failed' });
    assert.deepEqual(f.db.requeueDeadEvent('ev-dead-uncertain-err'), { requeued: false, reason: 'delivery_uncertain' });
    assert.deepEqual(f.db.requeueDeadEvent('ev-dead-uncertain-task'), { requeued: false, reason: 'delivery_uncertain' });

    // Valid dead event requeue succeeds and resets attempts/error
    assert.deepEqual(f.db.requeueDeadEvent('ev-dead-safe'), { requeued: true, eventId: 'ev-dead-safe' });
    const requeuedRow = f.db.db.prepare('SELECT status, attempts, last_error, locked_at FROM inbox_events WHERE event_id=?').get('ev-dead-safe');
    assert.equal(requeuedRow.status, 'pending');
    assert.equal(requeuedRow.attempts, 0);
    assert.equal(requeuedRow.last_error, null);
    assert.equal(requeuedRow.locked_at, null);

    // Failed event can also be requeued
    assert.deepEqual(f.db.requeueDeadEvent('ev-failed'), { requeued: true, eventId: 'ev-failed' });
  } finally { f.close(); }
});

test('Phase 6 pruneHistoryAndQueue, getTelemetrySummary, and classifyEventPriority work accurately', () => {
  const f = fixture();
  try {
    const nowMs = Date.parse('2026-11-19T12:00:00.000Z');
    const oldCompletedIso = new Date(nowMs - 10 * 86400000).toISOString();
    const freshCompletedIso = new Date(nowMs - 2 * 86400000).toISOString();
    const oldDeadIso = new Date(nowMs - 40 * 86400000).toISOString();
    const freshDeadIso = new Date(nowMs - 10 * 86400000).toISOString();
    const oldPendingIso = new Date(nowMs - 60 * 86400000).toISOString();
    const oldTelIso = new Date(nowMs - 35 * 86400000).toISOString();
    const recentTelIso = new Date(nowMs - 2 * 3600000).toISOString();
    const midTelIso = new Date(nowMs - 48 * 3600000).toISOString();

    for (const [id, status, updatedAt] of [
      ['c-old', 'completed', oldCompletedIso],
      ['c-fresh', 'completed', freshCompletedIso],
      ['d-old', 'dead', oldDeadIso],
      ['d-fresh', 'dead', freshDeadIso],
      ['p-ancient', 'pending', oldPendingIso]
    ]) {
      f.db.enqueueEvent({ eventId: id, chatId: 'c@c.us', senderId: 'c@c.us', payload: {} });
      f.db.db.prepare('UPDATE inbox_events SET status=?, updated_at=? WHERE event_id=?').run(status, updatedAt, id);
    }

    // Insert model_usage and audit_logs rows across timestamps
    const insertUsage = f.db.db.prepare(`
      INSERT INTO model_usage(task_id, model_id, tier, input_tokens, output_tokens, latency_ms, outcome, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertUsage.run('t1', 'haiku', 'fast', 100, 50, 200, 'success', recentTelIso);
    insertUsage.run('t2', 'sonnet', 'balanced', 300, 150, 400, 'error', recentTelIso);
    insertUsage.run('t3', 'sonnet', 'balanced', 500, 250, 600, 'success', midTelIso);
    insertUsage.run('t4', 'opus', 'reasoning', 1000, 500, 1000, 'success', oldTelIso);

    const insertAudit = f.db.db.prepare(`
      INSERT INTO audit_logs(chat_id, actor_id, action, outcome, details_json, created_at)
      VALUES(?, ?, ?, ?, ?, ?)
    `);
    insertAudit.run('c@c.us', 'c@c.us', 'act1', 'ok', '{}', recentTelIso);
    insertAudit.run('c@c.us', 'c@c.us', 'act2', 'ok', '{}', oldTelIso);

    const summary24 = f.db.getTelemetrySummary({ windowHours: 24, nowMs });
    assert.equal(summary24.windowHours, 24);
    assert.equal(summary24.totalCalls, 2);
    assert.equal(summary24.successCalls, 1);
    assert.equal(summary24.totalInputTokens, 400);
    assert.equal(summary24.totalOutputTokens, 200);
    assert.equal(summary24.avgLatencyMs, 300);
    assert.deepEqual(summary24.byTier.fast, {
      calls: 1, successCalls: 1, inputTokens: 100, outputTokens: 50, avgLatencyMs: 200
    });
    assert.deepEqual(summary24.byTier.balanced, {
      calls: 1, successCalls: 0, inputTokens: 300, outputTokens: 150, avgLatencyMs: 400
    });

    const pruned = f.db.pruneHistoryAndQueue({
      completedRetentionDays: 7,
      deadRetentionDays: 30,
      telemetryRetentionDays: 30,
      nowMs
    });
    assert.deepEqual(pruned, {
      deletedCompletedEvents: 1,
      deletedDeadEvents: 1,
      deletedModelUsage: 1,
      deletedAuditLogs: 1
    });

    // Pending event and fresh completed/dead rows are preserved
    const remainingIds = f.db.db.prepare('SELECT event_id FROM inbox_events ORDER BY event_id').all().map((r) => r.event_id);
    assert.deepEqual(remainingIds, ['c-fresh', 'd-fresh', 'p-ancient']);

    // classifyEventPriority
    const owner = '628111111111@c.us';
    assert.equal(classifyEventPriority({ chatId: owner, senderId: '628111111111:1@s.whatsapp.net', text: '/approve ap-1' }, owner), 1);
    assert.equal(classifyEventPriority({ chatId: owner, senderId: owner, text: '/deny ap-1' }, owner), 1);
    assert.equal(classifyEventPriority({ chatId: owner, senderId: owner, text: '/status' }, owner), 1);
    assert.equal(classifyEventPriority({ chatId: '123@g.us', senderId: owner, text: '/queue dead' }, owner), 1);
    assert.equal(classifyEventPriority({ chatId: owner, senderId: owner, text: 'Halo Bubu' }, owner), 2);
    assert.equal(classifyEventPriority({ chatId: '123@g.us', senderId: '628222@c.us', text: '/queue status' }, owner), 5);
    assert.equal(classifyEventPriority({ chatId: '123@g.us', senderId: owner, text: 'Bubu halo' }, owner), 5);
  } finally { f.close(); }
});
