const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { DatabaseStore, MIGRATIONS } = require('../../src/db/database');
const { InboxWorker } = require('../../src/workers/inbox-worker');
const { classifyEventPriority } = require('../../src/app');
const { cleanupStaleTempDirs } = require('../../src/index');
const { RECOGNIZED_SLASH_COMMANDS, handleSlashCommand } = require('../../src/agent/command-handler');
const { runBackup } = require('../../scripts/backup');
const {
  splitOversizedToken,
  wrapTextToWidth,
  buildPdf14Buffer
} = require('../../src/documents/generators/pdf-generator');
const { DocumentService } = require('../../src/documents/document-service');
const { analyzeSpreadsheetText } = require('../../src/documents/parsers/spreadsheet-analyzer');

const projectRoot = path.resolve(__dirname, '../..');
const OWNER = '628111111111@c.us';
const CHAT_DM_OTHER = '628222222222@c.us';
const CHAT_GROUP_A = '120363000000000001@g.us';
const CHAT_GROUP_B = '120363000000000002@g.us';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-p6-contract-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const db = new DatabaseStore(dbPath);
  return {
    dir,
    dbPath,
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('Phase 6 contract: Schema v12, priority ordering, per-chat FIFO serialization, queue stats, dead-letter guards, and pruning work in real SQLite', () => {
  const { db, cleanup } = makeTempDb();
  try {
    assert.equal(MIGRATIONS.some((m) => m.version === 12), true);
    const cols = new Set(db.db.prepare('PRAGMA table_info(inbox_events)').all().map((c) => c.name));
    assert.equal(cols.has('priority'), true);
    const idxPriority = db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_inbox_priority_ready'").get();
    const idxChat = db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_inbox_chat_status'").get();
    assert.ok(idxPriority);
    assert.ok(idxChat);

    // Event priority classification
    assert.equal(classifyEventPriority({ chatId: OWNER, senderId: OWNER, text: '/queue status' }, OWNER), 1);
    assert.equal(classifyEventPriority({ chatId: OWNER, senderId: OWNER, text: 'Halo' }, OWNER), 2);
    assert.equal(classifyEventPriority({ chatId: CHAT_GROUP_A, senderId: OWNER, text: 'Halo grup' }, OWNER), 5);

    // Enqueue out of priority order across different chats + two events for CHAT_GROUP_A
    db.enqueueEvent({ eventId: 'evt-group-a-1', chatId: CHAT_GROUP_A, senderId: OWNER, payload: { seq: 1 }, priority: 5 });
    db.enqueueEvent({ eventId: 'evt-group-a-2', chatId: CHAT_GROUP_A, senderId: OWNER, payload: { seq: 2 }, priority: 5 });
    db.enqueueEvent({ eventId: 'evt-dm-1', chatId: CHAT_DM_OTHER, senderId: CHAT_DM_OTHER, payload: { seq: 3 }, priority: 2 });
    db.enqueueEvent({ eventId: 'evt-owner-cmd', chatId: OWNER, senderId: OWNER, payload: { seq: 4 }, priority: 1 });

    // Claim 1 -> priority 1 owner command
    const c1 = db.claimNextEvent();
    assert.equal(c1.event_id, 'evt-owner-cmd');
    assert.equal(c1.priority, 1);

    // Claim 2 -> priority 2 DM
    const c2 = db.claimNextEvent();
    assert.equal(c2.event_id, 'evt-dm-1');

    // Claim 3 -> first event for CHAT_GROUP_A
    const c3 = db.claimNextEvent();
    assert.equal(c3.event_id, 'evt-group-a-1');

    // Claim 4 while evt-group-a-1 is STILL processing -> must NOT claim evt-group-a-2 (per-chat FIFO serialization)
    const c4Blocked = db.claimNextEvent();
    assert.equal(c4Blocked, null);

    // Finish evt-group-a-1 -> evt-group-a-2 is immediately claimable
    db.finishEvent('evt-group-a-1');
    const c4 = db.claimNextEvent();
    assert.equal(c4.event_id, 'evt-group-a-2');
    db.finishEvent('evt-group-a-2');
    db.finishEvent('evt-owner-cmd');

    // Move evt-dm-1 to dead-letter with normal error, and another event with delivery_uncertain
    db.failEvent('evt-dm-1', 'upstream_unavailable: timeout', 5, 5);

    db.enqueueEvent({ eventId: 'evt-uncertain-1', chatId: CHAT_GROUP_B, senderId: OWNER, payload: { seq: 5 }, priority: 5 });
    const cUncertain = db.claimNextEvent();
    assert.equal(cUncertain.event_id, 'evt-uncertain-1');
    db.failEvent('evt-uncertain-1', 'delivery_uncertain: partial chunk failure', 5, 5);

    db.enqueueEvent({ eventId: 'evt-uncertain-task', chatId: CHAT_GROUP_B, senderId: OWNER, payload: { seq: 6 }, priority: 5 });
    db.claimNextEvent();
    db.createTask({
      id: 'task-uncertain-1',
      sourceEventId: 'evt-uncertain-task',
      chatId: CHAT_GROUP_B,
      requesterId: OWNER,
      scope: 'group',
      requestText: 'Send report'
    });
    db.updateTask('task-uncertain-1', { status: 'uncertain', responseStatus: 'uncertain' });
    db.failEvent('evt-uncertain-task', 'upstream_unavailable: after send', 5, 5);

    const stats = db.getQueueStats();
    assert.equal(stats.completedCount, 3);
    assert.equal(stats.deadCount, 3);
    assert.equal(stats.pendingCount, 0);

    const deadList = db.listDeadEvents({ limit: 10 });
    assert.equal(deadList.length, 3);

    // Requeue refuses uncertain deliveries (both via last_error prefix and tasks table status), allows normal dead event
    assert.deepEqual(db.requeueDeadEvent('missing-id'), { requeued: false, reason: 'not_found' });
    assert.deepEqual(db.requeueDeadEvent('evt-group-a-1'), { requeued: false, reason: 'not_dead_or_failed' });
    assert.deepEqual(db.requeueDeadEvent('evt-uncertain-1'), { requeued: false, reason: 'delivery_uncertain' });
    assert.deepEqual(db.requeueDeadEvent('evt-uncertain-task'), { requeued: false, reason: 'delivery_uncertain' });
    assert.deepEqual(db.requeueDeadEvent('evt-dm-1'), { requeued: true, eventId: 'evt-dm-1' });

    const reclaimed = db.claimNextEvent();
    assert.equal(reclaimed.event_id, 'evt-dm-1');
    assert.equal(reclaimed.attempts, 1);
    db.finishEvent('evt-dm-1');

    // Prune expired completed/dead events, model_usage, and audit_logs
    const oldIso = new Date(Date.now() - 45 * 86400000).toISOString();
    db.logModelUsage({
      taskId: 'task-uncertain-1',
      modelId: 'claude-sonnet-5-5',
      tier: 'balanced',
      usage: { prompt_tokens: 120, completion_tokens: 45 },
      latencyMs: 320,
      outcome: 'success'
    });
    const telemetryNow = db.getTelemetrySummary({ windowHours: 24 });
    assert.equal(telemetryNow.totalCalls, 1);
    assert.equal(telemetryNow.byTier.balanced.calls, 1);

    db.db.prepare('UPDATE inbox_events SET updated_at=? WHERE event_id=?').run(oldIso, 'evt-group-a-1');
    db.db.prepare('UPDATE inbox_events SET updated_at=? WHERE event_id=?').run(oldIso, 'evt-uncertain-1');
    db.db.prepare('UPDATE model_usage SET created_at=?').run(oldIso);
    db.audit({ chatId: OWNER, actorId: OWNER, action: 'old_action', outcome: 'ok' });
    db.db.prepare('UPDATE audit_logs SET created_at=?').run(oldIso);

    const pruned = db.pruneHistoryAndQueue({ completedRetentionDays: 7, deadRetentionDays: 30, telemetryRetentionDays: 30 });
    assert.equal(pruned.deletedCompletedEvents, 1);
    assert.equal(pruned.deletedDeadEvents, 1);
    assert.equal(pruned.deletedModelUsage, 1);
    assert.equal(pruned.deletedAuditLogs, 1);
  } finally {
    cleanup();
  }
});

test('Phase 6 contract: InboxWorker bounded multi-slot concurrency, /queue slash command, and stale temp sweep work end-to-end', async () => {
  const { dir, db, cleanup } = makeTempDb();
  try {
    db.enqueueEvent({ eventId: 'w-a1', chatId: CHAT_GROUP_A, senderId: OWNER, payload: { id: 'w-a1', chatId: CHAT_GROUP_A }, priority: 5 });
    db.enqueueEvent({ eventId: 'w-a2', chatId: CHAT_GROUP_A, senderId: OWNER, payload: { id: 'w-a2', chatId: CHAT_GROUP_A }, priority: 5 });
    db.enqueueEvent({ eventId: 'w-b1', chatId: CHAT_GROUP_B, senderId: OWNER, payload: { id: 'w-b1', chatId: CHAT_GROUP_B }, priority: 5 });

    const activeChatCount = new Map();
    let maxObservedConcurrent = 0;
    let currentConcurrent = 0;
    const processedOrder = [];

    const worker = new InboxWorker({
      db,
      maxConcurrentJobs: 2,
      pruneIntervalMs: 60000,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      handler: async (payload) => {
        currentConcurrent += 1;
        maxObservedConcurrent = Math.max(maxObservedConcurrent, currentConcurrent);
        const perChat = (activeChatCount.get(payload.chatId) || 0) + 1;
        activeChatCount.set(payload.chatId, perChat);
        assert.equal(perChat, 1, `Concurrent execution violated for same chat ${payload.chatId}`);
        processedOrder.push(payload.id);
        await new Promise((resolve) => setTimeout(resolve, 40));
        activeChatCount.set(payload.chatId, 0);
        currentConcurrent -= 1;
      }
    });

    await worker.tick();
    assert.equal(maxObservedConcurrent, 2, 'Expected 2 distinct chats to run concurrently');
    assert.deepEqual(processedOrder.slice(0, 2).sort(), ['w-a1', 'w-b1']);

    // Second tick runs w-a2 after w-a1 finished
    await worker.tick();
    assert.equal(processedOrder[2], 'w-a2');
    const workerStats = worker.getStats();
    assert.equal(workerStats.activeCount, 0);
    assert.equal(workerStats.maxConcurrentJobs, 2);
    assert.equal(workerStats.healthy, true);
    assert.equal(workerStats.queue.completedCount, 3);

    // /queue command coverage (owner vs non-owner, status, dead, retry, prune)
    assert.equal(RECOGNIZED_SLASH_COMMANDS.has('/queue'), true);
    db.enqueueEvent({ eventId: 'cmd-dead-1', chatId: CHAT_DM_OTHER, senderId: CHAT_DM_OTHER, payload: {}, priority: 2 });
    db.claimNextEvent();
    db.failEvent('cmd-dead-1', 'upstream_unavailable: error', 5, 5);

    const replies = [];
    const processor = {
      config: { ownerJid: OWNER },
      db,
      worker,
      responseHandler: { sendText: async (text, chatId) => replies.push({ text, chatId }) }
    };

    await handleSlashCommand(processor, {
      text: '/queue status', msg: { chatId: CHAT_GROUP_A }, senderId: CHAT_DM_OTHER, owner: false, isGroup: true, scope: 'group', eventId: 'q0'
    });
    assert.match(replies[0].text, /hanya dapat diakses oleh pemilik/i);

    await handleSlashCommand(processor, {
      text: '/queue status', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'q1'
    });
    assert.match(replies[1].text, /Worker: sehat \(0\/2 slot aktif\)/);
    assert.match(replies[1].text, /Dead: 1/);

    await handleSlashCommand(processor, {
      text: '/queue dead', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'q2'
    });
    assert.match(replies[2].text, /cmd-dead-1/);

    await handleSlashCommand(processor, {
      text: '/queue retry cmd-dead-1', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'q3'
    });
    assert.match(replies[3].text, /berhasil dimasukkan kembali ke antrean/i);

    await handleSlashCommand(processor, {
      text: '/queue prune', msg: { chatId: OWNER }, senderId: OWNER, owner: true, isGroup: false, scope: 'personal', eventId: 'q4'
    });
    assert.match(replies[4].text, /Pembersihan antrean & riwayat selesai/);

    // cleanupStaleTempDirs removes stale bubu-* dirs while preserving bubu-db-* and fresh dirs
    const tmpSweepRoot = path.join(dir, 'tmp-sweep');
    fs.mkdirSync(tmpSweepRoot, { recursive: true });
    const staleDir = path.join(tmpSweepRoot, 'bubu-pdf-ocr-old');
    const protectedDbDir = path.join(tmpSweepRoot, 'bubu-db-keep');
    const freshDir = path.join(tmpSweepRoot, 'bubu-media-fresh');
    fs.mkdirSync(staleDir);
    fs.mkdirSync(protectedDbDir);
    fs.mkdirSync(freshDir);

    const oldDate = new Date(Date.now() - 7200000);
    fs.utimesSync(staleDir, oldDate, oldDate);
    fs.utimesSync(protectedDbDir, oldDate, oldDate);

    const sweepRes = cleanupStaleTempDirs({ tmpRoot: tmpSweepRoot, maxAgeMs: 3600000 });
    assert.equal(sweepRes.removed, 1);
    assert.equal(fs.existsSync(staleDir), false);
    assert.equal(fs.existsSync(protectedDbDir), true);
    assert.equal(fs.existsSync(freshDir), true);
  } finally {
    cleanup();
  }
});

test('Phase 6 contract: backup hardening, PDF long-token/table wrapping, XLSX normalization, and Phase 6 gate files pass', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-p6-hardening-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const dbPath = path.join(root, 'data', 'bubu.sqlite');
  const storageDir = path.join(root, 'storage');
  const backupDir = path.join(root, 'backups');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(path.join(storageDir, 'ab'), { recursive: true });
  fs.writeFileSync(path.join(storageDir, 'ab', 'doc.txt'), 'contract-doc');

  const store = new DatabaseStore(dbPath);
  store.enqueueEvent({ eventId: 'backup-evt-1', chatId: OWNER, senderId: OWNER, payload: { ok: true }, priority: 1 });

  try {
    const b1 = await runBackup({ sourcePath: dbPath, backupDir, storageDir, keepCount: 1, logger: { info: () => {} } });
    const b2 = await runBackup({ sourcePath: dbPath, backupDir, storageDir, keepCount: 1, logger: { info: () => {} } });
    assert.equal(b1.integrity, 'ok');
    assert.equal(b2.integrity, 'ok');
    assert.equal(b2.prunedDbCount, 1);
    assert.equal(b2.prunedStorageCount, 1);
    assert.equal(fs.existsSync(b1.destination), false);
    assert.equal(fs.existsSync(b2.destination), true);

    const verifyDb = new Database(b2.destination, { readonly: true });
    try {
      const row = verifyDb.prepare('SELECT event_id, priority FROM inbox_events WHERE event_id=?').get('backup-evt-1');
      assert.deepEqual(row, { event_id: 'backup-evt-1', priority: 1 });
    } finally {
      verifyDb.close();
    }
  } finally {
    store.close();
  }

  // PDF long-token + table wrapping
  const longToken = 'https://example.com/very-long-unbroken-url-token-for-phase6-contract-verification-1234567890';
  assert.ok(splitOversizedToken(longToken, 20).every((c) => c.length <= 20));
  assert.ok(wrapTextToWidth(`Link: ${longToken}`, 24).every((l) => l.length <= 24));
  const pdfBuf = buildPdf14Buffer({
    title: 'Phase 6 Contract PDF',
    content: '| Kolom | Detail |\n|---|---|\n| URL | ' + longToken + ' |'
  });
  assert.equal(pdfBuf.subarray(0, 8).toString('latin1'), '%PDF-1.4');

  // XLSX normalization preserves column alignment in spreadsheet-analyzer
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['Nama', 'Catatan', 'Nilai']);
  ws.addRow([{ richText: [{ text: 'A\nB' }] }, 'X | Y', 100]);
  const xlsxBuf = Buffer.from(await wb.xlsx.writeBuffer());
  const docSvc = new DocumentService({ db: {}, wahaConfig: { baseUrl: 'http://127.0.0.1:3000' }, storageDir });
  const extracted = await docSvc.extract({ buffer: xlsxBuf, ext: '.xlsx' });
  const analyzed = analyzeSpreadsheetText(extracted, { filename: 'contract.xlsx' });
  assert.equal(analyzed.totalRows, 1);
  assert.equal(analyzed.sampleRows[0].values.Nama, 'A B');
  assert.equal(analyzed.sampleRows[0].values.Catatan, 'X │ Y');

  // Phase 6 gate files & README checks
  const regPath = path.join(projectRoot, 'scripts/phase6-regression.sh');
  assert.equal(fs.existsSync(regPath), true);
  assert.equal(fs.readFileSync(regPath).includes(0x0d), false, 'scripts/phase6-regression.sh must use LF line endings');
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:phase6'], 'bash scripts/phase6-regression.sh');
  const readme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');
  assert.equal(readme.includes('`/summary`'), false);
  assert.equal(readme.includes('Schema Version 12'), true);
  assert.equal(readme.includes('npm run test:phase6'), true);
});
