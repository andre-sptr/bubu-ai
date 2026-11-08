# Phase 1 — Full Regression Test Plan (Task 1.9)

## Purpose

Task 1.9 is a release gate, not a feature task. It verifies the complete Phase 1 behavior after Tasks 1.1–1.8 and the intervening hotfixes. No production runtime behavior is intentionally changed by this task.

## Automated regression

Run on the production VPS from the Bubu project directory:

```bash
npm run test:phase1
```

The script performs, in order:

1. Node.js >=22 check.
2. Required dependency preflight (`dotenv`, `better-sqlite3`, `docx`, `exceljs`, `zod`).
3. Syntax check of every JavaScript file under `src`, `test`, and `scripts`.
4. Effective `.env` validation without printing secrets.
5. Full `npm test` unit + integration suite.
6. SQLite `PRAGMA integrity_check`.
7. Presence check for core Phase 1 tables and document storage directory.

The script exits non-zero on the first failure. It does not mutate the production database, send WhatsApp messages, create files, or print API keys/webhook tokens.

## Coverage matrix

| Area | Main coverage |
|---|---|
| 1.1–1.2 Voice preference | text, voice-only, both, per-chat persistence, reset, default behavior |
| 1.3 Group routing | mention gate, native mention, media-only messages, DM isolation |
| 1.4 Document generation | DOCX, XLSX, multi-sheet, formulas, formatting, size and MIME checks |
| 1.5 Group file delivery | group scope, destination binding, auto-send, DM approval, uncertain-send safety |
| 1.6 WhatsApp formatting | heading, bold, italic, lists, tables, links, quotes, code blocks |
| 1.6.1 Presence | sendSeen, startTyping, stopTyping, ignored-group behavior, finally cleanup |
| 1.7 Unified ResponseHandler | text, voice, file, image, video, receipt, partial/uncertain delivery |
| 1.8 Error recovery | timeout, 429, 4xx, 5xx, bounded retries, dead-letter, stale event recovery |
| Cross-cutting | memory isolation, rate limits, approval lifecycle, reminders, database integrity |

## Manual WhatsApp end-to-end acceptance

Automated tests do not replace these real WAHA/WhatsApp checks. Use one test DM and two test groups. Avoid testing failure injection against a production group.

### A. DM

1. Send a normal greeting; Bubu replies with WhatsApp-native formatting.
2. Verify seen/read receipt occurs before response.
3. Verify typing appears while the Agent is working and stops after response.
4. Set `/voice on`; send a question; verify only a voice note is delivered.
5. Set `/voice both`; verify formatted text and voice are delivered.
6. Set `/voice off`; verify text-only.
7. Restart Bubu; verify per-chat preference persists.
8. Create a DOCX; approve it; verify exactly one file is delivered.
9. After approval, send `halo`; verify Bubu does not repeat a stale approval prompt.
10. Create an XLSX and verify it opens in Excel/LibreOffice with expected worksheets and formulas.
11. Run `/rangkum`; verify WhatsApp formatting.
12. Verify reminders are delivered through the unified response path.

### B. Group A

1. Send ordinary text without mention; Bubu remains silent and does not mark the chat seen/start typing.
2. Mention Bubu; verify seen, typing, response, and stopTyping.
3. Send a voice note without caption; verify transcription/processing.
4. Send an image without caption; verify image analysis.
5. Send a supported document without caption; verify document analysis.
6. Request a DOCX; verify it is stored with `scope='group'` and `chat_id=Group A`, then delivered to Group A.
7. Request an XLSX; verify same group-scoped delivery behavior.
8. Confirm no personal owner approval is created for group-generated files.
9. Verify a group member's content does not leak into the owner's personal memory/workspace.

### C. Group B isolation

1. Request a DOCX in Group B.
2. Verify delivery goes only to Group B.
3. Verify the document is not retrievable through Group A or personal scope.
4. Verify Group B voice preference does not modify Group A or DM preferences.

### D. Failure and recovery (staging only)

1. Simulate model timeout; verify bounded retry and terminal notification after maximum attempts.
2. Simulate HTTP 429; verify retryable classification.
3. Simulate HTTP 401/403; verify terminal handling without repeated retry.
4. Simulate WAHA send timeout; verify delivery becomes uncertain and no automatic resend occurs.
5. Simulate TTS failure in voice-only mode; verify no text fallback.
6. Simulate media processing failure; verify safe user-facing error.
7. Restart Bubu during an in-flight test event; verify stale recovery does not duplicate external sends.

## Production data spot checks

Use read-only SQLite queries. Do not dump secrets or full document content into shared logs.

### Database integrity

```sql
PRAGMA integrity_check;
```

Expected: `ok`.

### Group document scope

```sql
SELECT id, scope, chat_id, filename, mime_type, file_size, created_at
FROM documents
WHERE scope='group'
ORDER BY created_at DESC
LIMIT 20;
```

Expected: each group document has the originating group JID in `chat_id`.

### Dead-letter events

```sql
SELECT event_id, chat_id, status, attempts, last_error, updated_at
FROM inbox_events
WHERE status='dead'
ORDER BY updated_at DESC
LIMIT 20;
```

Review that permanent failures are terminal and transient failures stop at the configured maximum.

### Uncertain external actions

Inspect `tool_executions` and task response state for `uncertain` records. Do not replay these automatically; reconcile against WhatsApp delivery first.

## Local validation result and limitations

In the available local review environment, `npm test` ran 124 tests: 120 passed and 4 could not run because `better-sqlite3`, `docx`, `exceljs`, and `zod` were not installed there. This is an environment limitation, not a passing result for those four tests.

The full suite must be rerun on the VPS where the project's dependencies are installed. The release gate is a zero-failure `npm run test:phase1` plus the manual DM/group acceptance above.

## Exit criteria

Task 1.9 is complete only when:

- `npm run test:phase1` exits 0 on VPS.
- All unit and integration tests pass.
- SQLite integrity check returns `ok`.
- All manual DM, Group A, Group B, and staging failure tests pass.
- No duplicate or cross-chat file delivery is observed.
- Voice-only, group routing, Markdown, presence, approval, and error recovery remain correct.
- PM2 remains stable after restart and logs contain no new recurring errors.

After exit criteria pass, Phase 1 can be marked complete and Phase 2 can be planned.
