# Bubu Task 2.2 — Overlay patch

This ZIP is an overlay, not a complete replacement of the Bubu project.

Extract it from `/www/wwwroot/bot-project` (the parent directory of the existing `bubu` folder). It contains only:

- `bubu/src/agent/message-processor.js` — replace the existing file.
- `bubu/test/unit/message-processor-media-errors.test.js` — add the regression test file.

No `.env`, database, storage, package files, PM2 files, or other source files are included.

Base snapshot: Bubu 2.4.0, archive SHA-256:
`6f5861a0b80c59965af5ef529513abfc5583dda3b5ea4143f951a6283a821a5e`

Patch scope:
- Re-throw original media-processing errors to InboxWorker so its existing classifier/retry/dead-letter logic remains the single owner.
- Route early media validation notices through ResponseHandler using the current chat output mode.
- Keep voice-only fail-closed; no text fallback when TTS delivery fails.

Do not extract over a different project directory. Back up the two target paths first.
