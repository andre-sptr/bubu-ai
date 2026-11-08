# Bubu Task 2.4 — Caption, Quote, and Chat Context Patch

**Rebased source:** Owner-uploaded `bubu.zip`  
**Package:** Bubu 2.4.0  
**Source archive SHA-256:** `d0f92ef36be118bb61afd8ecb944c3e25716d6daad5ea331c07a0c98c458dbd2`  
**Status:** Prepared and focused-tested; NOT deployed.

## Baseline verification

The uploaded archive passed ZIP integrity validation. These three source files matched the owner's VPS SHA-256 output exactly:

- `src/channels/waha/client.js`: `94a996c9c134ea65ba653eb5f86085ea596091f439a1deb9d8790d0ddd1344b2`
- `src/agent/message-processor.js`: `d7471ebc5b63073c659ac07112e085600bb17fb50018ce40bea3f654443bcd94`
- `src/agent/runtime.js`: `fec8e131056d44fbd16cf67fc715303ff986a1e185c4014cfcf52c96044b631d`

The Task 2.3 media/document service source in this archive matched the previously validated Task 2.3 workspace. This patch is therefore rebased on the owner's current source, not on the earlier prepared Task 2.4 baseline.

## ZIP layout

Extract this overlay from `/www/wwwroot/bot-project` (the parent directory of the existing `bubu` project).

It replaces three source files and adds/updates three test files:

- `bubu/src/channels/waha/client.js`
- `bubu/src/agent/message-processor.js`
- `bubu/src/agent/runtime.js`
- `bubu/test/unit/normalizer.test.js`
- `bubu/test/unit/runtime.test.js`
- `bubu/test/unit/message-context.test.js` (new)
- `bubu/docs/TASK-2.4-CAPTION-QUOTE-CONTEXT.md`

No `.env`, database, storage, PM2 config, package manifest, dependency lockfile, or dependency is changed.

## Changes

### 1. Separate current body and caption

The WAHA normalizer now exposes:
- `bodyText`
- `captionText`
- `text` (deduplicated current-message body + caption)
- `quote` (sanitized quoted-message context)

`MessageProcessor` uses the current body as the primary instruction. A distinct caption is supplied separately as `captionContext`. If the body is absent, the caption remains the current message instruction. The group mention gate uses only current-message body/caption, never quote text or OCR.

### 2. Quote extraction from embedded GOWS webhook

The normalizer extracts quote metadata from `Message.*.contextInfo.quotedMessage` and `RawMessage.*.contextInfo.quotedMessage`, with a limited fallback to `payload.replyTo`.

It unwraps a limited set of known ephemeral/view-once wrappers and exposes only:
- quoted message type;
- quoted text/caption, if present;
- MIME type;
- media/non-media boolean;
- reference-ID-present boolean.

It does not forward stanza IDs, participant JIDs, raw quote payloads, media URLs, media keys, or encryption fields to the model.

If any explicit quote-chat reference is present and differs from the current chat, the quote is rejected and quoted content is discarded. If the embedded GOWS quote has no explicit remote chat ID, it is treated as part of the current webhook event; no separate lookup is performed.

A quote-only DM can be handled as a request to explain the quoted context. A quote-only event in a group cannot bypass the current-message mention gate. If a quote-only DM contains an explicit cross-chat mismatch, Bubu returns a safe rejection notice.

### 3. Separate attachment evidence from the current instruction

`MessageProcessor` passes separate runtime fields:
- `captionContext`
- `voiceInstruction`
- `attachmentEvidence`
- `quoteContext`

OCR, document extraction, and ordinary audio/video transcript are sent as marked untrusted attachment evidence, not concatenated into the user's current instruction.

A PTT voice-note transcript may be treated as the current user's instruction in the current permitted chat, as allowed by the roadmap. It remains subordinate to system rules, existing chat scope, tool permissions, and approval requirements.

### 4. Chat history and memory safety

Existing history retrieval remains keyed by `chatId` and `scope`.

The user-authored current message (body/caption) remains the history entry. For media-only events, a neutral attachment marker is stored instead of OCR/extracted text. A PTT transcript can be stored as the spoken user message. Quoted text is not promoted to the current user instruction or persisted as a user-authored message.

Automatic memory capture is skipped for media and quote turns. This prevents OCR, document extraction, quoted content, and attachment-derived assistant responses from being automatically captured as durable memory. Normal text-only turns retain the existing memory behavior.

### 5. Runtime instruction boundaries

The system prompt explicitly marks quote/OCR/document/ordinary audio-video extracted text as untrusted evidence. It must not:
- override system/developer rules;
- change current chat scope;
- grant tool permissions;
- bypass approvals;
- trigger automatic memory writes.

The application still determines tool definitions from the existing `scope`; evidence does not change tool availability.

### 6. No external quote lookup

This patch uses only quote content embedded in the current webhook. It does not call WAHA Get Message by ID, and does not retrieve quoted media bytes.

The observed Task 2.1 quote fixture provided `stanzaID`, `participant`, and `quotedMessage.imageMessage`, but did not establish a separate quoted-chat lookup contract. Quoted image pixels are therefore not available to the model in this task unless the current message itself contains the image. A later lookup implementation would need a verified session + current-chat + referenced-message-ID boundary.

## Tests added/updated

- Body/caption separation and deduplication.
- Embedded GOWS quoted image metadata extraction without forwarding URL, stanza ID, participant, or media key.
- Explicit cross-chat quote mismatch rejection.
- Quote-only webhook recognition without promoting quoted text to current instruction.
- MessageProcessor passes body, caption, attachment evidence, quote context, and same-chat history separately.
- OCR evidence is not persisted as user-authored history or automatically saved as memory.
- Cross-chat quote content is discarded.
- Quote-only DM handling.
- Group quote text cannot satisfy the current-message mention gate.
- PTT transcript passed as a current voice instruction without automatic memory capture.
- Group history and quote context remain scoped to the same group.
- Runtime keeps caption, voice instruction, attachment evidence, and quote evidence in separate marked messages.

## Local validation

Syntax checks passed for all six changed JavaScript source/test files.

Focused regression command completed with:

**122 tests passed, 0 failed, 0 skipped.**

The focused set includes:
- normalizer
- message-context
- runtime
- group routing
- message processor formatting
- Task 2.2 media error tests
- inbox worker
- error policy
- voice output
- response handler
- P1 document services
- P3 media services
- Phase 1 regression contract

The full unit suite was also attempted against this uploaded source snapshot: **170 passed, 3 failed** because the isolated source archive does not include the existing runtime dependencies `docx`, `exceljs`, and `zod`. This is not a passing full-suite result. Run full tests in the VPS environment where the project's dependencies are installed.

## Owner validation required

Before deployment:
1. Verify the live VPS source still matches the three baseline hashes above (or rebase again if source changed).
2. Back up all three source files and existing test files listed above.
3. Extract this ZIP from `/www/wwwroot/bot-project`.
4. Run syntax, focused, full unit, full suite, and Phase 1 regression tests on VPS.
5. Run WhatsApp acceptance for:
   - image with body and different caption;
   - reply to a quoted image with caption;
   - quote-only DM;
   - quote with explicit cross-chat mismatch in a controlled fixture;
   - OCR containing an instruction-like string;
   - group reply with and without a current-message mention;
   - PTT voice note when STT is available.
6. Confirm OCR/quote evidence is not automatically saved as memory and tool definitions remain limited to the current chat scope.
7. Do not enable quoted-media lookup until a same-session, same-chat, exact-ID lookup path is independently verified.

No deployment, PM2 restart, database migration, or VPS modification was performed while preparing this patch.
