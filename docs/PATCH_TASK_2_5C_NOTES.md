# Bubu Task 2.5C — Piper → FFmpeg OGG/Opus → WAHA sendVoice

**Baseline:** owner-uploaded Bubu 2.4.0 source archive used for Task 2.5B work  
**Status:** Output path exists in source; focused contract tests added; VPS/WAHA acceptance required  
**Patch type:** Test-and-documentation overlay. No production source file is replaced.

## ZIP contents

Extract from `/www/wwwroot/bot-project` (parent of the existing `bubu` folder).

- `bubu/test/unit/voice-output.test.js` — new tests for DM/group delivery modes and WAHA `sendVoice` payload contract.
- `bubu/docs/PATCH_TASK_2_5C_NOTES.md` — this handover.
- `bubu/docs/BUBU_PHASE_2_5_TEST_EVIDENCE.docx` — consolidated Task 2.5 evidence provided/approved in the conversation.

The ZIP intentionally does not replace `src/p3/media/service.js`, `src/channels/response-handler.js`, `src/channels/waha/client.js`, `.env`, database, PM2 files, or dependencies. The source snapshot already contains the Piper synthesis, FFmpeg Opus conversion, ResponseHandler modes, and WAHA `/api/sendVoice` adapter. Avoid overwriting the Task 2.5B source that has already been accepted on the VPS.

## Existing output implementation inspected

1. `MediaIntelligenceService.synthesizeSpeech(text, workDir)` invokes configured Piper with the configured ONNX model, writes `reply.wav`, then invokes FFmpeg with `libopus`, 32 kbps, 48 kHz, mono to create `reply.ogg`.
2. `MediaIntelligenceService.createVoiceReply(text)` creates a temporary directory, synthesizes, reads the OGG bytes, and removes the temporary directory in `finally`.
3. `ResponseHandler.sendAssistantResponse(text, chatId, mode)` supports:
   - `text`: send formatted text only.
   - `voice`: synthesize and send voice only.
   - `both`: send text then voice.
4. Voice-only is fail-closed: if TTS generation fails, no text fallback is sent.
5. Both mode reports `ResponseDeliveryError` with `deliveryStatus='uncertain'` and `sentTypes=['text']` if voice send fails after text was delivered.
6. `WahaClient.sendVoice()` posts to `/api/sendVoice`, with session, chatId, filename, MIME type, base64 audio data, and `convert` option.
7. Owner chat preferences are scoped by chatId. Existing `/voice on`, `/voice both`, `/voice off`, and `/voice reset` behavior is covered by `voice-output-mode.test.js`.

## New regression coverage

`test/unit/voice-output.test.js` adds:
- DM: text, voice, and both modes.
- Group: text, voice, and both modes.
- DM/group: voice-only TTS failure sends no text fallback.
- DM/group: both-mode voice failure after text is represented as uncertain partial delivery.
- WAHA `sendVoice` adapter sends the expected `/api/sendVoice` payload with base64 OGG/Opus data.
- Explicit filename, MIME, and convert option are forwarded.

Local focused command:

```bash
node --test \
  test/unit/voice-output.test.js \
  test/unit/response-handler.test.js \
  test/unit/p3-media.test.js \
  test/unit/voice-output-mode.test.js \
  test/unit/message-context.test.js
```

Result on the source workspace: **48 tests passed, 0 failed, 0 skipped**. Syntax checks passed for the new test and relevant source modules.

These are contract/unit tests. They do not prove that the live WAHA GOWS session accepted and delivered the audio to a real DM or group.

## Required VPS validation

1. Confirm Task 2.5B is already deployed and do not replace its source files with an older snapshot.
2. Extract this small overlay. Back up `test/unit/voice-output.test.js` if it already exists.
3. Run `node --check test/unit/voice-output.test.js`.
4. Run the focused command above.
5. Run `npm run test:unit`, `npm test`, and `npm run test:phase1`.
6. Verify `.env` contains correct existing paths (do not paste `.env` contents into chat):
   - `PIPER_BIN=/opt/piper-venv/bin/piper`
   - `PIPER_MODEL_PATH=/opt/piper-voices/id_ID-news_tts-medium.onnx`
   - FFmpeg executable path, if a non-default path is configured.
   The Piper model's matching `.onnx.json` is adjacent to the ONNX file; the existing Piper smoke test already proved the pair works.
7. Confirm `MEDIA_INTELLIGENCE_ENABLED=true` and the model path is present in the running process configuration. Keep `VOICE_REPLY_DEFAULT=false` unless the owner deliberately wants all chats to default to voice/both.
8. Perform actual WAHA GOWS acceptance in a controlled owner DM and an owner-controlled test group:
   - `/voice off`, ask Bubu to reply: text only.
   - `/voice on`, ask Bubu to reply: voice only.
   - `/voice both`, ask Bubu to reply: text then voice.
   - `/voice reset`: restores configured default.
   - Confirm each reply goes to the same originating chat.
9. Listen to received audio. Confirm it is intelligible Indonesian speech, OGG/Opus, and not an empty/corrupt attachment.
10. Do not deliberately break the production Piper model or force WAHA timeouts to simulate failure. Fail-closed and uncertain partial-delivery paths are covered by unit tests. A controlled staging-only fault injection may be performed separately if needed.

## Acceptance and limitations

Task 2.5C passes only after real voice delivery is confirmed in both DM and group for text, voice, and both modes, and after failure semantics and regressions pass.

Evidence already available from the Task 2.5A tests:
- Piper 1.8.0 Indonesian News Medium synthesized a 3.97-second mono WAV in 2.04 seconds with 188,516 KB peak RSS.
- FFmpeg encoded it to 48 kHz mono Opus in an OGG file of 20,477 bytes.
- The prior evidence document records these local results.

Still not established by those local tests:
- Actual WAHA GOWS delivery and playback on recipient devices.
- Simultaneous STT+TTS memory/CPU use.
- Production behavior under long responses or network degradation.

No `.env` change, source modification, PM2 restart, database migration, or live WAHA send was performed while preparing this overlay.
