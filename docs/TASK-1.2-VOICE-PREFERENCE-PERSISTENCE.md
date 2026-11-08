# Task 1.2 — Voice preference persistence and reset

## Scope

This task hardens the per-chat output preference introduced in Task 1.1.

- Explicit choices (`text`, `voice`, `both`) persist per `(chat_id, requester_id)`.
- A chat without an explicit override inherits `VOICE_REPLY_DEFAULT`.
- `/voice status` reports both the effective mode and whether it comes from a chat override or the Bubu default.
- `/voice reset` removes the current chat's override and returns it to the configured default.
- Resetting one chat does not affect any other chat.
- Only the configured owner can change or reset preferences.

## Commands

- `/voice on`: set current chat to voice-only.
- `/voice off`: set current chat to text-only.
- `/voice both`: set current chat to text + voice.
- `/voice status`: show effective mode and its source.
- `/voice reset`: clear current chat override and inherit `VOICE_REPLY_DEFAULT`.

`VOICE_REPLY_DEFAULT=true` maps to `both`; `false` maps to `text`. This environment setting is only the fallback for chats without an explicit override.

## Database migration

Migration 9 adds `chat_preferences.voice_reply_mode_is_set`.

- `1`: a user/owner explicitly selected the mode; use `voice_reply_mode`.
- `0`: no explicit override; use the runtime default.

Rows already present when migration 9 runs are marked explicit, preserving the choices made before this update. No existing mode or chat preference is discarded.

## Deployment

1. Back up the project and SQLite database.
2. Apply the supplied Task 1.2 ZIP over the current Task 1.1 deployment. Preserve `.env`, `data/`, `storage/`, and PM2 configuration.
3. Run:
   - `node --check src/db/database.js`
   - `node --check src/agent/message-processor.js`
   - `node --test test/unit/voice-output-mode.test.js`
4. Restart Bubu using the existing PM2 process. Migration 9 is applied automatically at startup.
5. Inspect PM2 logs for migration or SQLite errors.

No new npm dependencies or port changes are required.

## Acceptance tests

1. In DM, set `/voice on`; restart Bubu; verify `/voice status` reports voice-only and a custom chat preference.
2. In Group A, set `/voice off`; restart Bubu; verify Group A remains text-only.
3. Verify the DM remains voice-only; Group A and DM must be independent.
4. In Group B, do not set any preference. With `VOICE_REPLY_DEFAULT=false`, verify `/voice status` reports text-only and default configuration.
5. If testing `VOICE_REPLY_DEFAULT=true` in staging, an unset chat should inherit text + voice.
6. In Group A, send `/voice reset`; verify the group returns to the configured default.
7. Verify resetting Group A does not change the DM or Group B.
8. Verify a non-owner cannot run `/voice on`, `/voice off`, `/voice both`, or `/voice reset`.

## Expected result

Task 1.2 passes only after migration 9 succeeds on the VPS and all persistence, fallback, reset, and per-chat isolation checks pass.

## Not included

Group message routing, automatic group document delivery, media handling, WhatsApp Markdown formatting, and general response delivery remain separate tasks.
