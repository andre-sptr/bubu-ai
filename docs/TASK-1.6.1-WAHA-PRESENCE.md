# Task 1.6.1 — WAHA Seen & Typing Presence

## Behavior

For eligible incoming messages (after DM/group policy and group mention filtering):

1. Call `POST /api/sendSeen` with `{ session, chatId }`.
2. Call `POST /api/startTyping` with `{ session, chatId }`.
3. Keep typing active while Bubu processes media, commands, model/tool execution and sends the final response.
4. Always call `POST /api/stopTyping` in `finally`, including early returns and processing errors after presence starts.

Presence API failures are logged as warnings and must not block the actual message processing. A stopTyping failure is also non-fatal.

Ignored group chatter (no required mention), disallowed groups, broadcasts/newsletters, fromMe events and untrusted DM senders do not receive seen/typing actions.

## WAHA API

Uses documented endpoints:
- `POST /api/sendSeen`
- `POST /api/startTyping`
- `POST /api/stopTyping`

All request bodies include `session` and `chatId`.

`sendSeen` intentionally uses the chat-level payload without `messageIds` for engine compatibility. WAHA documents `messageIds` targeting for NOWEB/GOWS; the chat-level payload is supported across engines and marks unread messages in that chat as read. In a group this can mark other unread messages in the same group as read as well.

## Deployment

Apply the Task 1.6.1 ZIP over the current Task 1.6 deployment. Preserve `.env`, database, storage and PM2 configuration. No dependency, database migration, environment variable or port change is required.

## Acceptance tests

1. DM: send a message and verify seen/read receipt is triggered before typing and response.
2. DM: verify typing is visible while model/tools work and disappears after response.
3. Group: mention Bubu and verify seen/typing lifecycle.
4. Group: send ordinary text without mention and verify no seen/typing is sent.
5. Send media and verify typing stays active during media processing.
6. Force an Agent error in staging and verify stopTyping is still called.
7. Simulate sendSeen/startTyping endpoint failure and verify message processing still continues.
8. Verify typing stops after text, voice, and file response paths.
9. Verify voice-only behavior and WhatsApp Markdown formatting remain unchanged.

## Not included

- Randomized human-like delays.
- Typing animation renewal/heartbeat for extremely long jobs.
- Message-specific read receipts via `messageIds`; current implementation uses the cross-engine chat-level endpoint.
