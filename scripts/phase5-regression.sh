#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pass() { printf '\033[32m[PASS]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[FAIL]\033[0m %s\n' "$1" >&2; exit 1; }
warn() { printf '\033[33m[WARN]\033[0m %s\n' "$1"; }

echo "=============================================="
echo " BUBU PHASE 5 — FULL REGRESSION (TASK 5.1-5.8)"
echo "=============================================="

# 1. Run Phase 1-4 baseline regression contract first
bash scripts/phase4-regression.sh
pass "Phase 1-4 baseline regression passed"

# 2. Verify Phase 5 contracts: Migration v11, 12 memory tools, prompt budget helpers, /memory command, and legacy guards
node - <<'NODE' || exit 1
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseStore, MIGRATIONS } = require('./src/db/database');
const { createMemoryTools } = require('./src/memory/memory-tools');
const { registerAllTools } = require('./src/agent/tool-registry');
const { fitJsonArrayToBudget, trimHistoryToBudget } = require('./src/agent/prompt-builder');
const { RECOGNIZED_SLASH_COMMANDS } = require('./src/agent/command-handler');

assert.equal(MIGRATIONS.some((m) => m.version === 11), true, 'Missing Migration v11');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-p5-gate-'));
try {
  const db = new DatabaseStore(path.join(dir, 'gate.sqlite'));
  try {
    const cols = new Set(db.db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name));
    assert.equal(cols.has('status'), true, 'Missing memories.status column');
    assert.equal(cols.has('superseded_by'), true, 'Missing memories.superseded_by column');
  } finally {
    db.close();
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

const memTools = createMemoryTools({ db: {}, memoryService: null });
assert.equal(memTools.length, 12, `Expected 12 memory tools, found ${memTools.length}`);

const registry = registerAllTools({
  db: {},
  approvalManager: {},
  waha: {},
  responseHandler: {},
  memoryService: null,
  documentService: {},
  webSearch: null,
  webFetch: null
});
for (const name of ['list_memories', 'update_memory', 'forget_memory', 'consolidate_memories']) {
  assert.ok(registry.get(name), `Missing memory lifecycle tool: ${name}`);
}

assert.equal(typeof fitJsonArrayToBudget, 'function');
assert.equal(typeof trimHistoryToBudget, 'function');
const sampleJson = fitJsonArrayToBudget([{ a: 'x'.repeat(200) }, { a: 'y'.repeat(200) }], 240);
assert.ok(sampleJson.length <= 240);
assert.equal(Array.isArray(JSON.parse(sampleJson)), true);

assert.equal(RECOGNIZED_SLASH_COMMANDS.has('/memory'), true, 'Missing /memory slash command');

const processorSrc = fs.readFileSync(path.join(process.cwd(), 'src/agent/message-processor.js'), 'utf8');
assert.equal(processorSrc.includes('classifyOperationalError('), false, 'Forbidden classifyOperationalError call in MessageProcessor');
const readmeSrc = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
assert.equal(readmeSrc.includes('`/summary`'), false, 'Legacy /summary reference found in README.md');

console.log('[PASS] Phase 5 Migration v11, 12 memory tools, fitJsonArrayToBudget, and /memory command verified');
NODE

# 3. Run focused Phase 5 unit, integration, and contract test suite
node --test \
  test/integration/database.test.js \
  test/unit/memory/memory-service.test.js \
  test/unit/memory/memory-tools.test.js \
  test/unit/agent/runtime.test.js \
  test/unit/agent/prompt-budget-and-memory-cmd.test.js \
  test/unit/agent/message-context.test.js \
  test/contracts/phase1-regression.contract.test.js \
  test/contracts/phase2-regression.contract.test.js \
  test/contracts/phase4-waha.contract.test.js \
  test/contracts/phase5-memory-agent.contract.test.js

pass "Focused Phase 5 unit, integration, and contract test suite passed"

echo "=============================================="
echo " PHASE 5 AUTOMATED REGRESSION: PASS"
echo "=============================================="
echo "See README.md for Phase 5 Agent & Memory Lifecycle capabilities."
