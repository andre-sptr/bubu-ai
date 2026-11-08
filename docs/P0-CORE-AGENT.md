# P0 — Core Agent

## Product decisions locked
- Product: hybrid personal + community assistant.
- Primary target: personal assistant.
- Provider: Sumopod only; no provider fallback.
- Model strategy: dynamic routing across configured Sumopod model IDs.
- Database: SQLite.
- Approval: confirm before external WhatsApp send.
- Group policy: all groups may interact, but group scope is isolated and does not gain personal tools.
- Group invocation: mention `Bubu` or issue a slash command by default; no unsolicited group replies.

## P0 scope
1. Clean Node.js project, no v1 code/data.
2. Fastify HTTP service and authenticated WAHA webhook.
3. SQLite migrations, WAL, foreign keys.
4. Durable inbox queue with deduplication, retries, stale-event recovery.
5. Sumopod provider adapter and authenticated model catalog script.
6. Dynamic model routing using benchmark-informed defaults; no per-model validation flags.
7. Agent planner/execution loop, schema-validated tool calls, bounded rounds/calls/time.
8. Core tools: save note, search notes, create reminder, request external WhatsApp send.
9. Owner-only approval and audit logging.
10. Persistent chat history, tasks, task steps, reminders, model usage and audit records.
11. Per-sender sliding-window rate limiting for non-owner traffic.
12. Health/readiness endpoints and graceful shutdown.

## Model configuration
Model defaults are benchmark-informed and defined in `src/config/env.js`. No per-tier validation flags are required. Optional `MODEL_FAST`, `MODEL_BALANCED`, `MODEL_REASONING`, `MODEL_CODING`, and `MODEL_SUMMARY` environment variables can override the defaults, but the normal `.env` does not need them.

Default mapping:
- Fast: `claude-haiku-5-5`
- Balanced: `claude-sonnet-5-5`
- Reasoning/agent: `claude-opus-5-5`
- Coding: `claude-sonnet-5-5`
- Long-context summary: `gemini/gemini-3.1-pro-preview`

These defaults use published benchmark and vendor capability reports as a starting policy. The model names must exist in the Sumopod catalog supplied by the owner. Sumopod's OpenAI-compatible tool-call translation is relied on; no additional per-model validation gate is imposed.

## Security boundaries
- Personal scope is available only to the configured owner JID after phone-JID normalization and best-effort LID resolution.
- Group scope is isolated by chat ID. Group tools cannot read personal memories or create personal reminders.
- External WhatsApp send is personal-only and always asks for owner approval.
- Approval codes expire and can only be resolved by the configured owner.
- A send with ambiguous network result is marked `uncertain`; it is not automatically retried to avoid duplicate messages.
- Quoted messages and retrieved notes are treated as untrusted content.
- Production startup requires a webhook token.
- All agent/tool actions are recorded in SQLite audit logs.

## Durable event processing
Webhook requests are authenticated and inserted into SQLite before HTTP 200 is returned. The inbox worker claims one event at a time. Failed events retry with exponential backoff and become dead after five attempts. Stale `processing` events are recovered at startup.

This is at-least-once processing. A crash after a remote WhatsApp send but before the inbox event is marked complete can still make a retry duplicate a response. Outbound idempotency and WAHA message reconciliation are follow-up hardening items.

## Test strategy
- Unit: configuration, JID normalization, payload normalization, model routing, approval behavior, agent runtime.
- Integration: SQLite migrations, event deduplication, memory scope isolation, atomic approval claim.
- Live: Sumopod model catalog and tool-call smoke test; WAHA send/receive and approval round trip.
- Deployment: restart recovery, backup/restore, and aaPanel reverse-proxy check.

## Not included in P0
Vision, voice, transcription, document parsing, web search, calendar, spreadsheet tools, vector embeddings, multi-agent, dashboard, and broad proactive behavior. Those are later milestones.


## Known P0 limitations and hardening backlog
- Inbox processing is durable and at-least-once. A process crash after WAHA accepted an outbound send but before event completion can still produce a duplicate reply on retry; outbound message reconciliation/idempotency is a P0.1 hardening item.
- A restarted in-progress agent task is replayed from its inbound event, not resumed from the exact model/tool round. Tool side effects need per-tool idempotency keys before enabling long-running autonomous workflows.
- Rate limiting is in-memory and resets on process restart. Persistent abuse controls can be added if group traffic increases.
- LID resolution is best-effort and should be validated against the installed WAHA version and real payloads.
- The current media payload path intentionally handles text messages only.
- Recurring reminders, group proactive policy, group administration, and advanced command management are outside this P0 deliverable.


## Dependency compatibility note
`@fastify/helmet` is pinned to `^13.2.0`, compatible with Fastify 5. The previously distributed `^12.1.0` range was invalid because that package version was not published; the published 12.x line ends at 12.0.1.


## P0.1 hardening
- Stable task IDs are derived from the normalized inbound event key.
- User/assistant messages are idempotent per event and role.
- Tool execution has a persistent idempotency ledger; interrupted executions are marked uncertain and are not blindly repeated.
- Task responses use a durable delivery state (`pending`, `sending`, `sent`, `uncertain`) to reduce duplicate WhatsApp replies.
- Approval execution is single-claim and interrupted sends become uncertain.
- One-time reminders are idempotent per inbound event. Ambiguous reminder delivery is marked failed/uncertain and is not automatically resent.
- Per-sender rate limits are persisted in SQLite.
- Stale approvals, tool executions, task responses, inbox events, and reminder sends are reconciled at startup.
- `.env` contains only connection/identity essentials; model selection defaults live in code and can be overridden optionally.
