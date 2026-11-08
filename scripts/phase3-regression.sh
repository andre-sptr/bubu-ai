#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pass() { printf '\033[32m[PASS]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[FAIL]\033[0m %s\n' "$1" >&2; exit 1; }
warn() { printf '\033[33m[WARN]\033[0m %s\n' "$1"; }

echo "=============================================="
echo " BUBU PHASE 3 — FULL REGRESSION (TASK 3.8)"
echo "=============================================="

# 1. Run Phase 1 + Phase 2 regression contract first
bash scripts/phase2-regression.sh
pass "Phase 1 + Phase 2 baseline regression passed"

# 2. Verify Phase 3 document OCR & PDF rendering binaries and settings
node - <<'NODE' || exit 1
require('dotenv').config();
const { spawnSync } = require('node:child_process');
const { loadConfig } = require('./src/config/env');
const config = loadConfig();

const checkBin = (bin, args = ['--version']) => {
  const res = spawnSync(bin, args, { encoding: 'utf8', timeout: 10000 });
  return res.status === 0;
};

if (!checkBin(config.media.tesseractBin, ['--version'])) {
  console.error(`[FAIL] Tesseract binary not available: ${config.media.tesseractBin}`);
  process.exit(1);
}

const hasPdftoppm = checkBin(config.documents.pdftoppmBin, ['-v']);
const hasGs = checkBin(config.documents.ghostscriptBin, ['--version']);
const hasFfmpeg = checkBin(config.media.ffmpegBin, ['-version']);
if (!hasPdftoppm && !hasGs && !hasFfmpeg) {
  console.error('[FAIL] No PDF page renderer available (expected pdftoppm, gs, or ffmpeg)');
  process.exit(1);
}
console.log(`[PASS] PDF OCR renderer available (pdftoppm=${hasPdftoppm}, gs=${hasGs}, ffmpeg=${hasFfmpeg})`);
console.log(`[INFO] Document OCR enabled=${config.documents.ocrEnabled}; maxPdfOcrPages=${config.documents.maxPdfOcrPages}; pdfRenderDpi=${config.documents.pdfRenderDpi}`);
NODE
pass "Phase 3 document OCR & PDF rendering preflight passed"

# 3. Verify centralized outbound WhatsApp send boundary and DatabaseStore deduplication
DIRECT_SEND_MATCHES="$(grep -rnE '\bwaha\.(sendText|sendFile|sendImage|sendVoice|sendVideo)\s*\(' src/ | grep -v "src/channels/response-handler.js" || true)"
if [ -n "$DIRECT_SEND_MATCHES" ]; then
  fail "Found direct waha.send* calls outside ResponseHandler: $DIRECT_SEND_MATCHES"
fi
pass "All outbound WhatsApp sends route through ResponseHandler"

SAVE_DOC_COUNT="$(grep -cE '^  saveDocument\(' src/db/database.js)"
if [ "$SAVE_DOC_COUNT" -ne 1 ]; then
  fail "Expected exactly 1 saveDocument definition in src/db/database.js, found $SAVE_DOC_COUNT"
fi
pass "DatabaseStore methods deduplicated"

# 4. Run focused Phase 3 Document Intelligence test suite
node --test \
  test/unit/document-generation.test.js \
  test/unit/document-tools.test.js \
  test/unit/p1-services.test.js \
  test/unit/phase3-document-intelligence.test.js \
  test/unit/phase1-regression-contract.test.js \
  test/unit/phase2-regression-contract.test.js

pass "Focused Phase 3 Document Intelligence test suite passed"

echo "=============================================="
echo " PHASE 3 AUTOMATED REGRESSION: PASS"
echo "=============================================="
echo "Complete the WhatsApp DM & Group acceptance matrix in:"
echo "docs/PHASE-3-ROADMAP.md"
