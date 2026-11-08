# Hotfix — Agent output budget and model response diagnostics

## Production evidence

The production `model_usage` rows supplied for the affected tasks show `completion_tokens=2200` for every model request. The runtime previously hard-coded `maxTokens: 2200`. This strongly suggests responses are consistently reaching the configured output cap, but the database did not persist `finish_reason`, so token truncation is not yet proven solely by those rows.

The task-step records independently confirm repeated `create_document` calls with `{}` arguments, rejected by Zod because `title` and `content` are required.

## Changes

- Add `AGENT_MAX_OUTPUT_TOKENS`, default 4096 and bounded to 1024–8192.
- Replace the hard-coded 2200 output-token cap with the configured value.
- Log model response finish reason, input/output token counts, tool count and tool names.
- Emit a warning when the model reports a length-related finish reason.
- Emit a warning when a tool call has empty or malformed JSON arguments; log only argument byte count and parsed keys, never argument contents.
- Document the Agent settings in `.env.example`, including existing default values for rounds, tool calls and timeouts.

## Important

This is a diagnostic and bounded mitigation, not proof that token exhaustion is the only cause. After deployment, inspect logs for:
- `finishReason`
- `outputTokens`
- `Model output reached token limit`
- `Model returned empty or malformed tool arguments`

If the model still emits `{}` while finish reason is `tool_calls` or `stop`, investigate model/provider tool-call compatibility next. Do not increase the output budget further without evidence.

## Deployment

Apply the supplied files over the current Task 1.4 + Agent Loop Protection deployment. Preserve `.env`, SQLite, storage and PM2 configuration. No dependency or database migration is required.

`AGENT_MAX_OUTPUT_TOKENS` defaults to 4096 even if it is absent from `.env`. It may be explicitly set in `.env` if desired.

## Tests

- `node --test test/unit/config.test.js`
- `node --test test/unit/runtime.test.js`
- Regression: voice output, group routing and normalizer unit tests.
