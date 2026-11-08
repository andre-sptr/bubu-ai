#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pass() { printf '\033[32m[PASS]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[FAIL]\033[0m %s\n' "$1" >&2; exit 1; }
warn() { printf '\033[33m[WARN]\033[0m %s\n' "$1"; }

echo "=============================================="
echo " BUBU PHASE 2 — FULL REGRESSION (TASK 2.8)"
echo "=============================================="

# 1. Run Phase 1 regression contract and preflight first
bash scripts/phase1-regression.sh
pass "Phase 1 baseline regression passed"

# 2. Verify local multimodal binaries and configured model files (without printing secrets)
node - <<'NODE' || exit 1
require('dotenv').config();
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { loadConfig } = require('./src/config/env');
const config = loadConfig();

const checkBin = (bin, args = ['--version']) => {
  const res = spawnSync(bin, args, { encoding: 'utf8', timeout: 10000 });
  return res.status === 0;
};

if (!checkBin(config.media.ffmpegBin, ['-version'])) {
  console.error(`[FAIL] FFmpeg binary not available: ${config.media.ffmpegBin}`);
  process.exit(1);
}
if (!checkBin(config.media.ffprobeBin, ['-version'])) {
  console.error(`[FAIL] FFprobe binary not available: ${config.media.ffprobeBin}`);
  process.exit(1);
}
if (!checkBin(config.media.tesseractBin, ['--version'])) {
  console.error(`[FAIL] Tesseract binary not available: ${config.media.tesseractBin}`);
  process.exit(1);
}
console.log('[PASS] FFmpeg, FFprobe, and Tesseract binaries available');

const modelChecks = [
  ['WHISPER_MODEL_PATH', config.media.whisperModelPath],
  ['WHISPER_VAD_MODEL_PATH', config.media.whisperVadModelPath],
  ['PIPER_MODEL_PATH', config.media.piperModelPath]
];
for (const [label, filePath] of modelChecks) {
  if (!filePath || !fs.existsSync(filePath)) {
    console.error(`[FAIL] Missing configured media model file for ${label}`);
    process.exit(1);
  }
}
console.log('[PASS] Whisper, Silero VAD, and Piper model files verified on disk');
console.log(`[INFO] Vision enabled=${config.media.visionEnabled}; model=${config.sumopod.models.vision.id}; maxBytes=${config.media.maxVisionBytes}; maxDim=${config.media.maxVisionDimension}`);
NODE

# 3. Run focused Phase 2 multimodal suite
node --test \
  test/unit/normalizer.test.js \
  test/unit/message-processor-media-errors.test.js \
  test/unit/message-context.test.js \
  test/unit/p1-services.test.js \
  test/unit/p3-media.test.js \
  test/unit/voice-output-mode.test.js \
  test/unit/voice-output.test.js \
  test/unit/image-understanding.test.js \
  test/unit/video-understanding.test.js \
  test/unit/phase1-regression-contract.test.js \
  test/unit/phase2-regression-contract.test.js

pass "Focused Phase 2 multimodal test suite passed"

echo "=============================================="
echo " PHASE 2 AUTOMATED REGRESSION: PASS"
echo "=============================================="
echo "Complete the WhatsApp DM & Group acceptance matrix in:"
echo "docs/PATCH_TASK_2_6_2_7_2_8_NOTES.md and docs/BUBU_PHASE_2_ROADMAP_TASKS_HANDOVER.md"
