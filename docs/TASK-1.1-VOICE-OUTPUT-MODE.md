# Task 1.1 — Per-chat voice output mode

## Behavior

- `/voice on`: voice-only for the current chat, including its activation acknowledgement.
- `/voice off`: text-only for the current chat.
- `/voice both`: text + voice for the current chat.
- `/voice status`: report the current chat's output mode.
- Only the configured owner may change the mode. The owner may configure a group from inside that group.
- The preference is stored per `chat_id`, keyed to the configured owner JID. Group members inherit that group's mode.
- Existing persisted `voice_reply_enabled=1` preferences are migrated to `both` to preserve the previous behavior.

## Safety behavior

Voice-only is fail-closed. Bubu generates audio before sending any answer. If Piper, FFmpeg, or WAHA voice delivery fails, Bubu does not send the answer as text. The task is marked uncertain by the existing response-delivery guard; inspect logs before manually retrying to avoid duplicate messages.

## Database

Migration 8 adds `chat_preferences.voice_reply_mode` with allowed values `text`, `voice`, and `both`. The previous boolean column remains for backward compatibility.

## Deployment

1. Back up the project and SQLite database.
2. Copy the changed source and test files into the existing project, preserving `.env`, `data/`, `storage/`, and PM2 configuration.
3. Run `node --check src/agent/message-processor.js` and `node --check src/db/database.js`.
4. Run `node --test test/unit/voice-output-mode.test.js`.
5. Run `npm test` after confirming dependencies are installed.
6. Restart Bubu with the existing PM2 process name and inspect its logs. On first startup, migration 8 is applied automatically.

Do not run `npm ci` as part of this task unless dependencies are missing; no package dependencies changed.

## Acceptance tests

1. In a DM, send `/voice on`; expect a voice-note confirmation and no text confirmation.
2. Send a normal question; expect exactly one voice note and no text answer.
3. Send `/voice status`; expect `voice-only`.
4. Send `/voice off`; ask another question; expect text only.
5. Send `/voice both`; ask another question; expect text and voice.
6. Configure `/voice on` inside a test group as the owner; ask Bubu a question in that group; expect voice-only in that group.
7. Configure `/voice off` in that group; verify the DM preference remains unchanged.
8. Temporarily set an invalid `PIPER_MODEL_PATH` in a staging environment or stop the TTS executable; with voice-only active, ask a question. Verify no text answer is sent and inspect PM2 logs for the TTS failure. Restore the correct voice configuration afterwards.

## Not included

This task does not change group mention routing, media ingestion, document generation, group file permissions, WhatsApp Markdown formatting, or the general response formatter. Those remain separate Phase 1 tasks.
