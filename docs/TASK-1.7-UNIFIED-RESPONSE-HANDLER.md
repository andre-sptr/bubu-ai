# Task 1.7 — Unified Response Handler

## Goal

Centralize outbound WhatsApp response delivery behind `ResponseHandler`, so formatting, output modes, delivery receipts and failure semantics are consistent across the application.

## Supported response types

- `text`: WhatsApp-native Markdown formatting, with an explicit `format:false` escape hatch for strings already authored in WhatsApp syntax.
- `voice`: voice note delivery.
- `file`: DOCX, XLSX, PDF and other supported files through WAHA `sendFile`.
- `image`: image delivery through WAHA `sendImage`.
- `video`: video delivery through WAHA `sendVideo`.

`sendAssistantResponse(text, chatId, mode)` supports per-chat `text`, `voice`, and `both` modes:
- `text`: formatted text only.
- `voice`: TTS + voice note only; no text fallback.
- `both`: formatted text then voice note. If text succeeds but voice delivery is uncertain, the error records the partial delivery (`sentTypes: ['text']`).

## Integration points

- `MessageProcessor`: all command replies, errors, summaries and final Agent responses use the response handler. The existing seen/typing lifecycle remains in `MessageProcessor`.
- `createP1Tools`: generated group DOCX/XLSX delivery uses `ResponseHandler.sendFile`.
- `ApprovalManager`: approved text and file actions use the response handler; approval authorization and one-time claim remain unchanged.
- `ReminderWorker`: scheduled reminder messages use the response handler.
- `index.js`: creates one shared response handler and injects it into all outbound components.

A fallback handler is retained in constructors for compatibility with unit tests and older direct instantiations.

## Delivery receipts and errors

Successful sends return a normalized receipt containing `ok`, `type`, `chatId`, `messageId` when exposed by WAHA, and the WAHA response.

Delivery errors are wrapped as `ResponseDeliveryError` with `deliveryStatus='uncertain'`, because a network timeout can occur after WhatsApp has accepted a send. The handler never retries automatically. Existing task-response, approval, reminder and tool-execution idempotency remain responsible for replay protection.

Logs include response type, target chat ID, filename (for media), message ID when available, and failure message. Message content, base64 payloads, and local file paths are not logged.

## Text formatting

All outbound text is formatted using the existing WhatsApp Native Markdown Formatter. `format:false` is available only for already-formatted WhatsApp strings (for example, reminder headings) to avoid converting native single-star bold into italic.

Captions for files, images and videos are formatted through the same formatter.

## Deployment

Apply the Task 1.7 ZIP over the current Task 1.6.1 deployment. Preserve `.env`, SQLite, storage and PM2 configuration. No database migration, new npm dependency or port change is required.

## Acceptance tests

1. Send normal text in text mode; verify formatting and normalized receipt.
2. Test voice-only; verify only a voice note is sent.
3. Test text+voice; verify text then voice and that TTS receives the original unformatted response.
4. Simulate TTS failure in voice-only; verify no text fallback.
5. Simulate voice failure after text in both mode; verify partial/uncertain delivery is surfaced.
6. Generate group DOCX and XLSX; verify both use the shared file delivery handler and reach the originating group.
7. Approve a personal DM file/text action; verify approval flow still works.
8. Deliver a reminder; verify it uses the shared handler and preserves its WhatsApp-native bold heading.
9. Send an image and video through the response handler adapter.
10. Verify captions use WhatsApp formatting.
11. Verify no outbound text/file/image/video/voice delivery calls remain outside `ResponseHandler` (presence endpoints are intentionally separate).
12. Verify WAHA delivery failures are logged and not automatically retried.
13. Verify voice, group routing, stale approval, document generation/delivery and Markdown regression tests.

## Not included

- Delivery queues with automatic retry.
- New WhatsApp message types such as polls, contacts, locations or stickers.
- A durable cross-channel delivery ledger beyond existing task, approval, reminder and tool execution state.
