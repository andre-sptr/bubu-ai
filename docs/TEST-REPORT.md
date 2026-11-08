# Bubu v2.4.0 — P3 WhatsApp Multimodal Test Report

## Checks completed in the build environment
- JavaScript syntax checks: 0 errors across all source/test/script files.
- Unit tests: 45 passed, 0 failed.
- SQLite migrations: fresh install versions 1–7 passed.
- SQLite schema upgrade from P1 versions 1–4 to P3 versions 1–7 passed.
- No live WAHA media, local Tesseract, Whisper model, Piper model or Sumopod credentials were used.

## Unit test coverage
- Media kind detection with MIME precedence.
- MIME-to-extension mapping when WAHA filename is absent.
- Media signature validation.
- Local process runner success, stdin and missing-command behavior.
- WAHA sendVoice request payload.
- Incoming voice media normalization.
- P3 environment defaults.
- Existing P0/P1/P2 tests.

## VPS acceptance tests
1. Install Tesseract and language packs; send a photo containing Indonesian text.
2. Send a screenshot and ask Bubu to extract its text.
3. Install whisper.cpp and a multilingual model; send an Indonesian voice note and verify transcript.
4. Send a short MP4 with spoken audio and on-screen text; verify sampled frame OCR and audio transcript.
5. Install Piper and a suitable voice; send `/voice on` in owner DM and verify a text + voice response.
6. Send `/voice off` and verify voice replies stop.
7. Restart Bubu and verify voice preference persists.
8. Send unsupported/oversized media and verify a safe error response.
9. Verify group media is processed only after group mention/caption policy is satisfied.

## Known limitations
- Sumopod official docs currently describe text-only model output. This P3 therefore uses local OCR/STT/TTS preprocessing and does not claim full model vision/audio input.
- OCR does not understand visual scenes, objects, people or actions.
- Video is sampled into a limited number of frames and OCR; motion/scene understanding is not available.
- Voice transcription requires whisper.cpp binary and a local GGML model.
- Voice response requires Piper binary and a voice model; Indonesian language quality depends on the selected voice.
- PDF scanned-page OCR is not included yet.
- P3 media binaries and model files are not bundled in the source archive.
