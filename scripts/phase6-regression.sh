#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pass() { printf '\033[32m[PASS]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[FAIL]\033[0m %s\n' "$1" >&2; exit 1; }
warn() { printf '\033[33m[WARN]\033[0m %s\n' "$1"; }

echo "=============================================="
echo " BUBU PHASE 6 — FULL REGRESSION (TASK 6.1-6.8)"
echo "=============================================="

# 1. Run Phase 1-5 baseline regression contract first
bash scripts/phase5-regression.sh
pass "Phase 1-5 baseline regression passed"

# 2. Verify Phase 6 contracts: Migration v12, priority queue + per-chat FIFO, InboxWorker multi-slot, /queue, backup hardening, PDF wrapping, XLSX normalization, & docs
node - <<'NODE' || exit 1
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseStore, MIGRATIONS } = require('./src/db/database');
const { InboxWorker } = require('./src/workers/inbox-worker');
const { classifyEventPriority } = require('./src/app');
const { cleanupStaleTempDirs } = require('./src/index');
const { RECOGNIZED_SLASH_COMMANDS } = require('./src/agent/command-handler');
const { runBackup, pruneOldBackups } = require('./scripts/backup');
const { splitOversizedToken, wrapTextToWidth, buildPdf14Buffer } = require('./src/documents/generators/pdf-generator');
const { normalizeXlsxCellValue } = require('./src/documents/document-service');

assert.equal(MIGRATIONS.some((m) => m.version === 12), true, 'Missing Migration v12');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-p6-gate-'));
try {
  const db = new DatabaseStore(path.join(dir, 'gate.sqlite'));
  try {
    const cols = new Set(db.db.prepare('PRAGMA table_info(inbox_events)').all().map((c) => c.name));
    assert.equal(cols.has('priority'), true, 'Missing inbox_events.priority column');
    const idxPriority = db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_inbox_priority_ready'").get();
    const idxChat = db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_inbox_chat_status'").get();
    assert.ok(idxPriority, 'Missing idx_inbox_priority_ready index');
    assert.ok(idxChat, 'Missing idx_inbox_chat_status index');
    for (const method of ['getQueueStats', 'listDeadEvents', 'requeueDeadEvent', 'pruneHistoryAndQueue', 'getTelemetrySummary']) {
      assert.equal(typeof db[method], 'function', `Missing DatabaseStore.${method}`);
    }
  } finally {
    db.close();
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

assert.equal(typeof InboxWorker.prototype.getStats, 'function', 'Missing InboxWorker.getStats');
assert.equal(typeof classifyEventPriority, 'function', 'Missing classifyEventPriority');
assert.equal(typeof cleanupStaleTempDirs, 'function', 'Missing cleanupStaleTempDirs');
assert.equal(RECOGNIZED_SLASH_COMMANDS.has('/queue'), true, 'Missing /queue slash command');
assert.equal(typeof runBackup, 'function', 'Missing runBackup export');
assert.equal(typeof pruneOldBackups, 'function', 'Missing pruneOldBackups export');
assert.equal(typeof splitOversizedToken, 'function', 'Missing splitOversizedToken export');
assert.equal(wrapTextToWidth('https://example.com/' + 'a'.repeat(50), 20).every((l) => l.length <= 20), true);
assert.equal(Buffer.isBuffer(buildPdf14Buffer({ title: 'Gate', content: '| A | B |\n|---|---|\n| 1 | 2 |' })), true);
assert.equal(normalizeXlsxCellValue({ richText: [{ text: 'A\n' }, { text: 'B|C' }] }), 'A B│C');

const processorSrc = fs.readFileSync(path.join(process.cwd(), 'src/agent/message-processor.js'), 'utf8');
assert.equal(processorSrc.includes('classifyOperationalError('), false, 'Forbidden classifyOperationalError call in MessageProcessor');
const readmeSrc = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
assert.equal(readmeSrc.includes('`/summary`'), false, 'Legacy /summary reference found in README.md');
assert.equal(readmeSrc.includes('Schema Version 12'), true, 'Missing Schema Version 12 in README.md');
assert.equal(readmeSrc.includes('npm run test:phase6'), true, 'Missing npm run test:phase6 in README.md');

console.log('[PASS] Phase 6 Migration v12, priority queue, /queue, backup hardening, PDF wrapping, and XLSX normalization verified');
NODE

# 3. Run focused Phase 6 unit, integration, and contract test suite
node --test \
  test/integration/database.test.js \
  test/unit/workers/inbox-worker.test.js \
  test/unit/agent/prompt-budget-and-memory-cmd.test.js \
  test/unit/channels/app-webhook.test.js \
  test/unit/utils/backup-and-pdf.test.js \
  test/unit/documents/document-generation.test.js \
  test/contracts/phase1-regression.contract.test.js \
  test/contracts/phase2-regression.contract.test.js \
  test/contracts/phase4-waha.contract.test.js \
  test/contracts/phase5-memory-agent.contract.test.js \
  test/contracts/phase6-queue-hardening.contract.test.js

pass "Focused Phase 6 unit, integration, and contract test suite passed"

echo "=============================================="
echo " PHASE 6 AUTOMATED REGRESSION: PASS"
echo "=============================================="
echo "See README.md for Phase 6 Queue Redesign & End-to-End Hardening capabilities."
