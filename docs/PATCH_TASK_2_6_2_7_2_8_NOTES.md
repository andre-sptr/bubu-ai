# Bubu Task 2.6, 2.7, and 2.8 — Visual Image, Visual-Temporal Video, and Phase 2 Regression Overlay

**Project baseline:** Bubu 2.4.0 after Task 2.5C  
**Status:** Implemented and focused-tested locally (203/203 unit tests passing in isolated workspace); **NOT deployed to VPS** (owner retains deployment and live WhatsApp acceptance).

---

## 1. Scope summary

### Task 2.6 — Pemahaman Gambar (Image Understanding)
- **Model selection (from Task 2.1C probe):** Routes turns containing visual attachments (`needsVision: true`) to `claude-sonnet-5-5` (`vision` / `balanced` tier, overridable via `MODEL_VISION`), even when the user's text prompt would otherwise classify as `simple_question` (`fast`) or `summarize` (`summary`).
- **Local normalization & size/dimension bounds (`src/p3/media/service.js`):**
  - Normalizes incoming images via FFmpeg in the temporary work directory (`-frames:v 1 -vf scale='min(1280,iw)':-2 -q:v 4`) to strip container metadata and bound dimensions (`MAX_VISION_IMAGE_DIMENSION`, default `1280`).
  - Enforces byte size limit (`MAX_VISION_IMAGE_BYTES`, default `4 MiB`) and JPEG magic-byte signature validation before constructing a `data:image/jpeg;base64,...` payload.
  - Cleans up normalized temporary files immediately and removes `workDir` + inbound storage files in `finally`.
- **Provider boundary (`src/providers/sumopod.js`):**
  - `validateImageDataUrl()` and `sanitizeMessagesForProvider()` permit only `data:image/(jpeg|png|webp);base64,...` payloads within byte limits.
  - Any `http://`, `https://`, relative path, or credential-bearing URL in `image_url` is rejected before leaving the process, guaranteeing WAHA private URLs and tokens stay on the VPS.
- **Task 2.4 context integration & labeled OCR fallback (`src/agent/message-processor.js`, `src/agent/runtime.js`):**
  - Connects visual payloads to `[UNTRUSTED_ATTACHMENT_EVIDENCE]` while preserving strict separation from `text` (body), `captionContext`, `voiceInstruction`, and `quoteContext`.
  - Runs Tesseract OCR (`ind+eng`) alongside visual preparation as supplemental text (`ocrText`).
  - Falls back to `[OCR_FALLBACK]` (`visualMode: 'ocr_fallback'`) if `MEDIA_VISION_ENABLED=false`, if the normalized image exceeds `maxVisionBytes`, if FFmpeg normalization fails, or if the remote provider rejects multimodal `image_url` input at runtime (HTTP 400/415/422).

### Task 2.7 — Pemahaman Visual-Temporal Video (Video Understanding)
- **Timestamped visual frame analysis + Task 2.5 audio soundtrack (`src/p3/media/service.js`):**
  - Uses FFprobe duration (`durationSeconds`) while also recording `declaredDurationSeconds` from WAHA webhook metadata to reconcile the 5s vs 6s rounding difference observed in Task 2.1B.
  - Samples up to `MAX_VIDEO_FRAMES` (default `8`) scaled frames (`scale='min(1280,iw)':-2`) and binds each frame to its 1-based index and timestamp (`Frame 1 [t=00:00.0]`, `Frame 2 [t=00:01.0]`, etc.).
  - Attaches bounded JPEG frame payloads (`visualImages`, capped per frame by `maxVisionBytes` and per video by `2 * maxVisionBytes`) plus per-frame OCR.
  - Extracts audio track (`video-audio.wav`) and transcribes speech via Task 2.5B (`transcribeAudio` with Silero VAD + Whisper). Silent soundtracks return `noSpeech: true` without hallucinated text.
  - Marks clips with `< 2` frames or `< 1.5s` duration as `temporalStatus: 'insufficient_sample'`, instructing Bubu to state that the sample is insufficient to confirm state-change ordering.
  - Marks OCR+transcript-only runs (`visionEnabled: false` or no visual frames) as `visualMode: 'partial_ocr_audio'` (`partialOnly: true`).
  - Guards concurrent video/audio jobs (`videoBusy` / `audioBusy`) to protect the 2-vCPU / 1.9 GiB RAM VPS, and cleans up all temporary files in `finally`.

### Task 2.8 — Regresi, Performa, dan Acceptance
- Corrected stale `/summary` reference to `/rangkum` in `docs/PHASE-1-FULL-REGRESSION-PLAN.md` and updated `/voice` mode documentation in `docs/P3-WHATSAPP-MULTIMODAL.md`.
- Normalized path separators in `test/unit/config.test.js` and `test/unit/phase1-regression-contract.test.js` for cross-platform consistency.
- Added `test/unit/image-understanding.test.js`, `test/unit/video-understanding.test.js`, `test/unit/phase2-regression-contract.test.js`, and `scripts/phase2-regression.sh`.

---

## 2. Files modified / added

### Modified source files
- `src/config/env.js`
- `src/index.js`
- `src/agent/model-router.js`
- `src/providers/sumopod.js`
- `src/p3/media/service.js`
- `src/agent/message-processor.js`
- `src/agent/runtime.js`

### Added / updated test and script files
- `test/unit/image-understanding.test.js` (new)
- `test/unit/video-understanding.test.js` (new)
- `test/unit/phase2-regression-contract.test.js` (new)
- `test/unit/config.test.js` (updated)
- `test/unit/phase1-regression-contract.test.js` (updated)
- `scripts/phase2-regression.sh` (new)

### Updated documentation
- `docs/BUBU_PHASE_2_ROADMAP_TASKS_HANDOVER.md`
- `docs/PHASE-1-FULL-REGRESSION-PLAN.md`
- `docs/P3-WHATSAPP-MULTIMODAL.md`
- `docs/PATCH_TASK_2_6_2_7_2_8_NOTES.md`

---

## 3. Minimal `.env` policy (all defaults in `src/config/env.js`)

No changes to `.env` are required on the VPS. All STT, VAD, TTS, and Vision settings now default directly in `src/config/env.js`:
- `WHISPER_BIN` defaults to `/opt/whisper.cpp/build/bin/whisper-cli`
- `WHISPER_MODEL_PATH` defaults to `/opt/whisper.cpp/models/ggml-base.bin`
- `WHISPER_LANGUAGE` defaults to `auto`
- `WHISPER_VAD_MODEL_PATH` defaults to `/opt/whisper.cpp/models/ggml-silero-v6.2.0.bin`
- `PIPER_BIN` defaults to `/opt/piper-venv/bin/piper`
- `PIPER_MODEL_PATH` defaults to `/opt/piper-voices/id_ID-news_tts-medium.onnx`
- `MEDIA_VISION_ENABLED` defaults to `true`
- `MODEL_VISION` defaults to `claude-sonnet-5-5`
- `MAX_VISION_IMAGE_BYTES` defaults to `4194304` (4 MiB)
- `MAX_VISION_IMAGE_DIMENSION` defaults to `1280`

---

## 4. VPS validation & WhatsApp acceptance procedure (Task 2.8)

1. Back up the seven modified source files before extracting.
2. Run syntax checks on all changed JS files:
   ```bash
   node --check src/index.js src/config/env.js src/agent/model-router.js src/providers/sumopod.js src/p3/media/service.js src/agent/message-processor.js src/agent/runtime.js
   ```
3. Run the focused unit suite (203 tests):
   ```bash
   node --test test/unit/approval.test.js test/unit/config.test.js test/unit/error-policy.test.js test/unit/event-key.test.js test/unit/group-routing.test.js test/unit/image-understanding.test.js test/unit/inbox-worker.test.js test/unit/memory-service.test.js test/unit/message-context.test.js test/unit/message-processor-formatting.test.js test/unit/message-processor-media-errors.test.js test/unit/model-router.test.js test/unit/normalizer.test.js test/unit/p1-services.test.js test/unit/p3-media.test.js test/unit/phase1-regression-contract.test.js test/unit/phase2-regression-contract.test.js test/unit/rate-limiter.test.js test/unit/reminder-worker.test.js test/unit/response-handler.test.js test/unit/runtime.test.js test/unit/video-understanding.test.js test/unit/voice-output-mode.test.js test/unit/voice-output.test.js test/unit/waha-presence.test.js test/unit/waha-voice.test.js test/unit/whatsapp-formatter.test.js
   ```
4. On the VPS (where `better-sqlite3`, `zod`, `docx`, and `exceljs` are installed), run:
   ```bash
   npm test
   npm run test:phase1
   bash scripts/phase2-regression.sh
   ```
5. Restart PM2 during a planned window and execute the WhatsApp acceptance matrix across **Owner DM**, **Non-owner DM (must be ignored)**, **Group A**, and **Group B**:
   - **Image without text (2 distinct objects/relations)** in DM and Group A -> verify answers differ accurately according to visual content.
   - **Screenshot with text + caption question** in DM and Group A -> verify visual + OCR context.
   - **Reply/quote to message/media** in DM and Group A -> verify same-chat context and mention gate.
   - **Voice note (PTT) inbound + `/voice on`, `/voice both`, `/voice off`, `/voice reset`** in DM and Group A -> verify STT + Piper/Opus `sendVoice`.
   - **Silent video with >= 2 visual state changes** in DM and Group A -> verify timestamped sequence explanation (`Frame #k [t=...]`).
   - **Video with spoken Indonesian soundtrack** in DM and Group A -> verify combined visual frame + audio transcript explanation.
   - **Group A vs Group B isolation** -> verify DOCX/XLSX auto-delivery only to originating group, DM approval requirement, and zero cross-chat memory/history leakage.
