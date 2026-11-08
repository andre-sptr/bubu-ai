# Task 1.8 — Error Handling & Recovery

## Scope

This task makes operational errors visible, classifies retry safety, applies bounded inbox retries, and informs the user after terminal processing failures.

## Error categories

- `delivery_uncertain`: WAHA may have accepted a send before timeout. Non-retryable; no dead-letter user notification is sent to avoid creating a second ambiguous message.
- `authentication`: HTTP 401/403. Non-retryable; terminal notice asks admin to check credentials/configuration.
- `invalid_request`: other HTTP 4xx. Non-retryable; terminal notice asks for a corrected request/admin review.
- `rate_limit`: HTTP 429. Retryable with bounded exponential backoff.
- `timeout`: provider/model/task timeout. Retryable with bounded exponential backoff.
- `upstream_unavailable`: network errors and HTTP 5xx. Retryable with bounded exponential backoff.
- `validation`: known schema/argument validation errors. Non-retryable.
- `internal`: unexpected errors. Retryable but bounded by the maximum attempts.

## Inbox worker behavior

- Successful handler execution marks the inbox event completed.
- Retryable errors are scheduled using the existing exponential backoff (1s, 2s, 4s, ... capped at 5 minutes).
- Non-retryable errors are moved directly to `dead` state.
- Retryable errors are moved to `dead` after `INBOX_MAX_ATTEMPTS`.
- Dead-letter notices are sent through the shared ResponseHandler and respect the chat's text/voice/both preference.
- Delivery-uncertain errors are never retried and do not trigger a second user notification.
- All retry and terminal transitions are logged with event ID, chat ID, category and attempt count. Raw payloads and credentials are not logged.

## Configuration

Optional `.env` settings:

```env
INBOX_POLL_MS=500
INBOX_MAX_ATTEMPTS=5
INBOX_STALE_MS=120000
```

Values are bounded:
- Poll interval: 100–5000 ms.
- Maximum attempts: 1–10.
- Stale processing lock: 30,000–600,000 ms.

## Media errors

Media processing errors now use safe, categorized user-facing messages instead of exposing raw internal exception text or filesystem paths. The response respects the current chat output preference.

## Recovery and duplicate safety

- Existing stable task IDs and tool idempotency remain unchanged.
- Existing `tool_executions` uncertain state blocks automatic replay of external actions.
- Existing `tasks.response_status='uncertain'` prevents a blind resend when a process crashes during response delivery.
- Inbox retries do not imply that an uncertain WAHA send is safe to repeat.
- Stale inbox events are recovered using the configured stale window. Existing stale tool execution and response recovery safeguards remain authoritative.

## Deployment

Apply Task 1.8 ZIP over current Task 1.7 deployment. Preserve `.env`, database, storage and PM2 configuration. No dependency or database migration is required. Optional inbox environment variables can be added to `.env`; defaults work without them.

## Acceptance tests

1. Normal DM and group responses still work.
2. Simulated model timeout is retried with exponential backoff and stops after configured maximum attempts.
3. HTTP 429 and 5xx/network errors are retryable.
4. HTTP 401/403 and invalid 4xx requests are moved directly to dead-letter.
5. Dead-letter notification is sent once and respects chat voice preference.
6. WAHA delivery uncertainty is not retried and does not trigger a second notification.
7. Media processing failures produce safe messages without leaking filesystem paths or raw stack details.
8. A crash during external tool execution remains `uncertain` and is not replayed automatically.
9. A crash during response delivery remains `uncertain` and is not blindly resent.
10. Voice-only, voice-both, Markdown formatting, file delivery and seen/typing behavior remain unchanged.
11. Restart Bubu and verify stale inbox recovery uses `INBOX_STALE_MS`.

## Not included

- Automatic retries of uncertain WAHA sends.
- A manual dead-letter replay dashboard/command.
- Provider failover to another LLM vendor.
- Durable per-file delivery queue beyond existing task/tool idempotency.
