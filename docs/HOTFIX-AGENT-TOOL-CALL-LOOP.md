# Hotfix — Agent tool-call loop protection

## Diagnosis from production task_steps

The supplied production database output shows repeated `create_document` calls with raw arguments `{}`. Zod rejects every call because required `title` and `content` fields are missing. No DOCX generation occurred for those calls. The agent returned the validation error to the model, which repeated the same invalid call until the planning/tool-call loop failed. Inbox retries can replay a failed task and add more task-step records.

## Changes

- System prompt explicitly requires all required tool arguments and forbids repeating invalid tool calls.
- Agent logs each model planning round, selected model/tier, response finish reason, tool count and tool names (not raw user arguments).
- The runtime detects repeated identical schema-invalid tool calls. On the second identical invalid call, it marks the task completed with a useful user-facing diagnostic and queues the response. This prevents the same deterministic validation loop from becoming repeated Inbox retries.
- If the planning-round limit is reached after tool results have been collected, the runtime makes one final model request without tools, instructing it to summarize existing results instead of calling tools again.
- If the total tool-call limit is reached, the runtime returns a user-facing stop notice rather than throwing and retrying the same event.

## Scope and safety

This hotfix does not change document generation schemas, file storage, group permissions, approval rules, WAHA delivery, database schema or dependencies. It does not auto-retry external actions. Successful tool results remain protected by existing idempotency records.

## Deployment

Apply the two changed JavaScript files from the ZIP over the current Task 1.4 deployment. Preserve `.env`, database, storage and PM2 configuration. Run syntax checks and `node --test test/unit/runtime.test.js`, then run the full test suite on the VPS.

## Acceptance tests

1. Send a normal DM text question; expect a normal response.
2. In a test group, ask for a simple SOP DOCX; verify exactly one generated document record and a response that it is ready for group delivery.
3. Ask for a simple XLSX; verify the workbook is generated and saved once.
4. Confirm malformed/empty model tool arguments stop after the second identical invalid call and produce a user-facing diagnostic, not an Inbox retry loop.
5. Confirm when the planning-round limit is reached after a successful tool call, a final no-tools request summarizes the result.
6. Confirm voice-only and group media routing regressions still pass.
7. Inspect PM2 logs for model request timeout separately; this hotfix addresses the confirmed invalid tool-call loop, not external Sumopod latency.
