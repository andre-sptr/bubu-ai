#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pass() { printf '\033[32m[PASS]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[FAIL]\033[0m %s\n' "$1" >&2; exit 1; }
warn() { printf '\033[33m[WARN]\033[0m %s\n' "$1"; }

echo "=============================================="
echo " BUBU PHASE 1 — FULL REGRESSION"
echo "=============================================="

# 1. Runtime version
if ! command -v node >/dev/null 2>&1; then fail "Node.js is not installed"; fi
NODE_MAJOR="$(node -e "process.stdout.write(String(Number(process.versions.node.split('.')[0])))")"
if (( NODE_MAJOR < 22 )); then fail "Node.js >=22 required; found $(node --version)"; fi
pass "Node.js $(node --version)"

# 2. Production dependencies needed by the complete test suite
node - <<'NODE' || exit 1
const required = ['dotenv','better-sqlite3','docx','exceljs','zod','fastify','@fastify/helmet','pino','axios','pdf-parse','mammoth'];
const missing = required.filter((name) => {
  try { require.resolve(name); return false; } catch { return true; }
});
if (missing.length) {
  console.error('[FAIL] Missing runtime/test dependencies:', missing.join(', '));
  process.exit(1);
}
console.log('[PASS] Required dependencies are installed');
NODE

# 3. Syntax-check all project JavaScript
mapfile -d '' JS_FILES < <(find src test scripts -type f -name '*.js' -print0)
if ((${#JS_FILES[@]} == 0)); then fail "No JavaScript files found"; fi
for file in "${JS_FILES[@]}"; do
  node --check "$file" >/dev/null || fail "Syntax error: $file"
done
pass "Syntax check (${#JS_FILES[@]} JavaScript files)"

# 4. Validate effective configuration without printing secrets
if [[ ! -f .env ]]; then fail "Production .env file is missing"; fi
node - <<'NODE' || exit 1
require('dotenv').config();
const { loadConfig } = require('./src/config/env');
const config = loadConfig();
const required = [
  ['OWNER_JID', config.ownerJid],
  ['WAHA_BASE_URL', config.waha?.baseUrl],
  ['WAHA_SESSION', config.waha?.session],
  ['SUMOPOD_API_KEY', config.sumopod?.apiKey]
];
const missing = required.filter(([, value]) => !value).map(([name]) => name);
if (missing.length) {
  console.error('[FAIL] Missing required configuration:', missing.join(', '));
  process.exit(1);
}
if (config.nodeEnv === 'production' && !config.waha.webhookToken) {
  console.error('[FAIL] WAHA_WEBHOOK_TOKEN is required in production');
  process.exit(1);
}
console.log('[PASS] Effective configuration is valid (secrets hidden)');
console.log(`[INFO] Bubu port=${config.port}; WAHA=${config.waha.baseUrl}; session=${config.waha.session}`);
console.log(`[INFO] Agent rounds=${config.agent.maxRounds}; toolCalls=${config.agent.maxToolCalls}; outputTokens=${config.agent.maxOutputTokens}`);
console.log(`[INFO] Inbox attempts=${config.inbox.maxAttempts}; staleMs=${config.inbox.staleMs}`);
NODE

# 5. Full automated suite
npm test
pass "Full unit + integration test suite"

# 6. SQLite integrity and expected storage paths
node - <<'NODE' || exit 1
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { loadConfig } = require('./src/config/env');
const config = loadConfig();
const dbPath = config.databasePath;
if (!fs.existsSync(dbPath)) {
  console.error(`[FAIL] Database file not found: ${dbPath}`);
  process.exit(1);
}
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  const result = db.pragma('integrity_check', { simple: true });
  if (result !== 'ok') {
    console.error('[FAIL] SQLite integrity_check:', result);
    process.exit(1);
  }
  console.log('[PASS] SQLite integrity_check: ok');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const requiredTables = ['tasks','task_steps','documents','approvals','tool_executions','inbox_events'];
  const missing = requiredTables.filter((name) => !tables.includes(name));
  if (missing.length) {
    console.error('[FAIL] Required database tables missing:', missing.join(', '));
    process.exit(1);
  }
  console.log('[PASS] Core Phase 1 database tables exist');
} finally {
  db.close();
}
if (!fs.existsSync(config.storageDir)) {
  console.error(`[FAIL] Storage directory not found: ${config.storageDir}`);
  process.exit(1);
}
console.log('[PASS] Document storage directory exists');
NODE

echo "=============================================="
echo " PHASE 1 AUTOMATED REGRESSION: PASS"
echo "=============================================="
echo "Manual WhatsApp acceptance tests are documented in:"
echo "docs/PHASE-1-FULL-REGRESSION-PLAN.md"
