# Task 1.5 — Automatic group file delivery

## Behavior

- DOCX and XLSX generation in a group automatically sends the generated file to the same originating group chat.
- The destination is always `ctx.chatId`; the model cannot supply or override a destination.
- Group destination must have a WhatsApp group JID ending in `@g.us`.
- Before sending, Bubu re-reads the document record using `(document_id, scope='group', chat_id=current_group)` and verifies that the file path is inside the configured document storage directory.
- File existence, non-zero size, configured maximum size and database/file size agreement are checked before sending.
- Group file delivery does not create a personal owner approval.
- Personal DM generation retains the existing owner approval workflow.
- Both document-generation tools are marked as external-risk tools so an unexpected thrown error is treated conservatively by Agent Runtime.
- A WAHA send error is returned as `deliveryStatus='uncertain'`, not retried automatically. WhatsApp may have accepted the file even if the client timed out.
- Successful WAHA response returns `deliveryStatus='sent'` and the generated document metadata.
- Existing Agent Runtime idempotency protects a repeated identical tool call in the same task from sending the same file again.

## WAHA integration

Uses the existing `WahaClient.sendFile(filePath, chatId, { filename, mimetype, caption })`, which sends to WAHA `/api/sendFile`.

The target is derived only from the incoming group context. No arbitrary recipient/forwarding destination is accepted from model arguments.

## Deployment

Apply the Task 1.5 ZIP over the current Task 1.4 + Agent Loop Protection + Output Diagnostics + Stale Approval Fix deployment. Preserve `.env`, database, storage and PM2 configuration. No database migration, new npm dependency, or port change is required.

## Acceptance tests

1. In a test group, request a DOCX. Confirm the generated file is delivered to that exact group, not to the owner's DM.
2. In the same group, request an XLSX. Confirm the generated file is delivered to that exact group.
3. Confirm the task result and assistant response say the file was sent only when WAHA returns success.
4. Confirm the group document record has `scope='group'` and the originating `chat_id`.
5. Confirm no owner approval is created for group DOCX/XLSX delivery.
6. In a personal DM, request a DOCX/XLSX. Confirm the existing owner approval workflow remains unchanged.
7. Confirm a group tool call cannot choose a different destination.
8. Confirm invalid non-group JIDs are rejected before generation.
9. Simulate a WAHA timeout. Confirm `deliveryStatus='uncertain'`, the file remains saved, and Bubu does not automatically retry the send.
10. Confirm an identical tool call replay within the same task does not send a duplicate file.
11. Confirm voice-only and stale-approval fixes still pass regression tests.

## Not included

- Sending arbitrary user-selected files from a group.
- Sending files to other groups or contacts.
- Automatic retry of uncertain WAHA sends.
- File-delivery queue with background retry. These require a separate durable delivery state machine and explicit reconciliation to avoid duplicates.
