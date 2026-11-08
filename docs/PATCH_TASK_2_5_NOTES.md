# Bubu Task 2.5B — STT Integration Overlay

Status: prepared and focused-tested; NOT deployed.
Project baseline: owner-uploaded `bubu.tar.gz`, package version 2.4.0.
Baseline archive SHA-256: `cb650a31bf3a07e8427338856f2ed75ffc7064dd1169603cc3fd9b499d75bda5`

## Apply
Extract this ZIP from `/www/wwwroot/bot-project` (the parent of the existing `bubu` directory). It is an overlay, not a full project replacement.

It replaces:
- `bubu/src/config/env.js`
- `bubu/src/index.js`
- `bubu/src/p3/media/service.js`
- `bubu/src/agent/message-processor.js`
- `bubu/test/unit/p3-media.test.js`
- `bubu/test/unit/message-context.test.js`

It adds this evidence document under `bubu/docs/`:
- `BUBU_PHASE_2_5_TEST_EVIDENCE.docx`

No `.env`, package manifest/lockfile, database, storage, PM2 config, or dependencies are included.

## Implementation
1. Adds `WHISPER_VAD_MODEL_PATH` config and passes it from app bootstrap into MediaIntelligenceService.
2. Audio is normalized by FFmpeg to mono 16 kHz PCM WAV before Whisper.
3. Whisper runs with configured base model and Silero VAD:
   - `--vad`
   - `-vt 0.50`
   - `-vspd 250`
   - `-vsd 500`
   - `-vp 100`
   - `-t 2`
   - `-ng`
4. Empty VAD transcript returns `noSpeech: true`, not an operational exception.
5. MessageProcessor sends a short no-speech notice and stops before history persistence, memory, or Agent invocation.
6. Audio jobs are single-concurrency per MediaIntelligenceService instance. A concurrent audio request is rejected with a retryable error; it does not start a second Whisper process.
7. Temporary WAV/work directory and downloaded media are cleaned in finally.
8. Existing Task 2.4 semantics are retained: PTT transcript can be a current voice-note instruction; ordinary audio remains attachment evidence.

## Required `.env` settings — manual owner action
Do NOT paste secrets into chat. After extraction, edit `.env` on VPS and set these paths based on the previously audited installation:

```dotenv
WHISPER_BIN=/opt/whisper.cpp/build/bin/whisper-cli
WHISPER_MODEL_PATH=/opt/whisper.cpp/models/ggml-base.bin
WHISPER_LANGUAGE=auto
WHISPER_VAD_MODEL_PATH=/opt/whisper.cpp/models/ggml-silero-v6.2.0.bin
PIPER_BIN=/opt/piper-venv/bin/piper
PIPER_MODEL_PATH=/opt/piper-voices/id_ID-news_tts-medium.onnx
```

Piper JSON is colocated with the ONNX file; current synthesizeSpeech passes model path and relies on Piper's adjacent config discovery. Verify this on VPS. This patch does not change `.env`.

## Tests
Focused regression command completed locally:
**113 passed, 0 failed, 0 skipped.**

Includes P3 media tests, MessageProcessor no-speech early stop, normalizer, Task 2.4 context, group routing, media errors, inbox worker, error policy, response handler, runtime, voice output, and Phase 1 regression contract.

Syntax checks passed for all changed JavaScript files.

The 113 tests are isolated-workspace focused tests, not a full VPS `npm test` result. Run full unit, full suite and Phase 1 tests on VPS.

## Owner validation sequence
1. Verify the live four source hashes match the baseline before extraction.
2. Back up all six target files.
3. Extract ZIP from `/www/wwwroot/bot-project`.
4. Run syntax and focused tests.
5. Manually add the `.env` settings above; check files exist and are executable.
6. Run a controlled STT test using actual WAHA voice note and silent fixture.
7. Confirm silent audio produces no Agent call and user-facing no-speech notice.
8. Confirm quiet voice -30/-50 dB still reaches transcription.
9. Run `npm run test:unit`, `npm test`, `npm run test:phase1`.
10. Only after review, restart PM2 during a planned deployment window and perform WhatsApp acceptance.

## Known limitations
- Background-noise robustness was SKIPPED at owner's request; not claimed as passed.
- Long audio/chunking not tested.
- Human and mixed-language transcript quality remains PARTIAL; ambiguous time/names/critical details should be confirmed.
- Audio concurrency is per Node process/service instance. If multiple Bubu instances/processes are ever run, this in-memory guard is not a cross-process lock.
- This patch covers STT integration only. WAHA outbound voice note/TTS delivery is not included in Task 2.5B.
- No source/config/database/PM2 changes were made on the VPS during preparation.
