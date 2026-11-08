# Hotfix — Prevent stale approval prompts in later conversations

## Symptom

After an owner approved and sent a generated file, a later unrelated greeting caused the model to repeat an old `/approve <id>` prompt as if it were still pending.

## Root cause

The approval prompt was present in conversation history. The runtime supplied chat history to the model but did not supply authoritative current approval state for that chat. The model could therefore repeat stale approval instructions from history even though the approval had already been completed.

## Changes

- Add `DatabaseStore.getPendingApprovalsForChat(chatId)` to return only unexpired approvals whose status is `pending` for the current chat.
- Include the live approval state in the Agent system context.
- Explicitly instruct the model that database state is authoritative, history is not, and old approval prompts must not be repeated.
- Tell the model not to mention pending approvals during unrelated greetings or ordinary questions.
- After a successful `/approve` or `/deny`, append a confirmation to conversation history so later turns have a newer factual event.

## Security and scope

The query returns only approval IDs, action names and expiry timestamps; it does not expose file paths or approval arguments to the model. Results are scoped by exact chat ID. No database migration or new dependency is required.

## Deployment

Apply the three changed source/test files over the current Bubu deployment. Preserve `.env`, database, storage and PM2 configuration. Run syntax checks and tests, then restart Bubu.

## Acceptance tests

1. Create a file approval and approve it.
2. Confirm the file is delivered.
3. Send `halo bubu`; the assistant must greet normally and must not mention the old approval ID.
4. Create a new pending approval; if asked about pending approvals, the assistant may report only the current live pending item.
5. Verify approvals in another chat are not included in the current chat's live state.
6. Verify expired approvals are not presented as pending.
