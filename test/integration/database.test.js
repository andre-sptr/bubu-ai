const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseStore } = require('../../src/db/database');

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
