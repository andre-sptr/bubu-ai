#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pass() { printf '\033[32m[PASS]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[FAIL]\033[0m %s\n' "$1" >&2; exit 1; }
warn() { printf '\033[33m[WARN]\033[0m %s\n' "$1"; }

echo "=============================================="
echo " BUBU PHASE 4 — FULL REGRESSION (TASK 4.8)"
echo "=============================================="

# 1. Run Phase 1 + Phase 2 + Phase 3 regression contract first
bash scripts/phase3-regression.sh
pass "Phase 1 + Phase 2 + Phase 3 baseline regression passed"

# 2. Verify centralized outbound WhatsApp send boundary across ALL Phase 1-4 methods
DIRECT_SEND_MATCHES="$(grep -rnE '\bwaha\.(sendText|sendFile|sendImage|sendVoice|sendVideo|sendReaction|sendPoll|sendLocation|sendContactVcard|sendLinkCustomPreview|editMessage|deleteMessage|forwardMessage)\s*\(' src/ | grep -v "src/channels/response-handler.js" || true)"
if [ -n "$DIRECT_SEND_MATCHES" ]; then
  fail "Found direct waha outbound calls outside ResponseHandler: $DIRECT_SEND_MATCHES"
fi
pass "All 13 outbound WhatsApp methods route exclusively through ResponseHandler"

# 3. Verify zero blocking fs.readFileSync in WahaClient
SYNC_READ_MATCHES="$(grep -rnE '\breadFileSync\b' src/channels/waha/client.js || true)"
if [ -n "$SYNC_READ_MATCHES" ]; then
  fail "Found blocking fs.readFileSync in src/channels/waha/client.js: $SYNC_READ_MATCHES"
fi
pass "Zero blocking fs.readFileSync calls in WahaClient"

# 4. Verify Phase 4 runtime capabilities (14 WAHA tools, 5 ApprovalManager tools, message chunking, session sync)
node - <<'NODE' || exit 1
const assert = require('node:assert/strict');
const { createWahaTools } = require('./src/channels/waha/waha-tools');
const { APPROVED_TOOLS } = require('./src/agent/approval-manager');
const { splitWhatsAppMessage } = require('./src/channels/whatsapp-formatter');
const { ResponseHandler } = require('./src/channels/response-handler');
const { WahaSessionMonitor } = require('./src/channels/waha/session-monitor');

const tools = createWahaTools({ waha: {}, responseHandler: {}, approvalManager: {} });
assert.equal(tools.length, 14, `Expected 14 WAHA tools, found ${tools.length}`);
assert.equal(APPROVED_TOOLS.size, 5, `Expected 5 approved tools, found ${APPROVED_TOOLS.size}`);
assert.equal(typeof splitWhatsAppMessage, 'function');
assert.equal(typeof WahaSessionMonitor.prototype.syncFromWaha, 'function');
for (const m of [
  'sendText', 'sendVoice', 'sendFile', 'sendImage', 'sendVideo',
  'sendReaction', 'sendPoll', 'sendLocation', 'sendContactVcard',
  'sendLinkPreview', 'editMessage', 'deleteMessage', 'forwardMessage'
]) {
  assert.equal(typeof ResponseHandler.prototype[m], 'function', `Missing ResponseHandler.${m}`);
}
console.log('[PASS] Phase 4 tool registry (14 tools), ApprovalManager (5 tools), and ResponseHandler (13 methods) verified');
NODE

# 5. Optional live WAHA session probe when WAHA_LIVE_CHECK=1
if [ "${WAHA_LIVE_CHECK:-0}" = "1" ]; then
  node - <<'NODE' || exit 1
require('dotenv').config();
const { loadConfig } = require('./src/config/env');
const { WahaClient } = require('./src/channels/waha/client');
const { WahaSessionMonitor } = require('./src/channels/waha/session-monitor');

(async () => {
  const config = loadConfig();
  const waha = new WahaClient(config.waha);
  const monitor = new WahaSessionMonitor({ session: config.waha.session, botJid: config.botJid });
  try {
    const res = await monitor.syncFromWaha(waha);
    if (!res.ok || !res.snapshot.healthy) {
      console.error('[FAIL] Live WAHA session check unhealthy:', res.snapshot);
      process.exit(1);
    }
    console.log(`[PASS] Live WAHA session healthy (session=${res.snapshot.session}, status=${res.snapshot.status}, botJid=${res.snapshot.botJid || 'none'})`);
  } finally {
    waha.close();
  }
})();
NODE
  pass "Optional live WAHA session check passed"
fi

# 6. Run focused Phase 4 Native WhatsApp Outbound & Transport test suite
node --test \
  test/unit/channels/waha-client.test.js \
  test/unit/channels/normalizer.test.js \
  test/unit/channels/session-monitor.test.js \
  test/unit/channels/whatsapp-formatter.test.js \
  test/unit/channels/response-handler.test.js \
  test/unit/channels/app-webhook.test.js \
  test/unit/channels/waha-presence.test.js \
  test/unit/channels/waha-voice.test.js \
  test/unit/agent/waha-tools.test.js \
  test/unit/agent/approval.test.js \
  test/unit/agent/group-routing.test.js \
  test/contracts/phase1-regression.contract.test.js \
  test/contracts/phase2-regression.contract.test.js \
  test/contracts/phase4-waha.contract.test.js

pass "Focused Phase 4 Native WhatsApp Outbound & Transport test suite passed"

echo "=============================================="
echo " PHASE 4 AUTOMATED REGRESSION: PASS"
echo "=============================================="
echo "See README.md for Native WhatsApp Outbound capabilities."
