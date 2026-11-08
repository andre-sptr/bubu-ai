# Task 1.3 — Group message routing

## Behavior

- DM routing is unchanged.
- In groups, ordinary text still requires a detectable Bubu mention when `GROUP_REQUIRE_MENTION=true`.
- Text mentions are recognized as the word `Bubu` (case-insensitive).
- Native WhatsApp mention metadata is matched against optional `BOT_JID`.
- A rendered `@<bot-number>` in the message body is also recognized when `BOT_JID` is configured.
- Slash commands continue to pass the mention gate; command-specific authorization remains enforced by each command.
- Media-only group messages (no caption/body) are accepted by default even when `GROUP_REQUIRE_MENTION=true`.
- Captioned group media still requires a Bubu mention when mention gating is enabled.
- Set `GROUP_MEDIA_REQUIRE_MENTION=true` to require a detectable mention for media-only group messages too.
- Group content remains in group scope and uses the existing group memory/document scope. It is not added to the owner's personal memory scope.

## Configuration

Optional `.env` settings:

```env
BOT_JID=628xxxxxxxxxx@c.us
GROUP_REQUIRE_MENTION=true
GROUP_MEDIA_REQUIRE_MENTION=false
```

`BOT_JID` should be the WhatsApp JID/number of the Bubu account, not the owner's JID. If omitted, the literal word `Bubu` remains a supported mention, but native @number mentions cannot be reliably identified as Bubu.

`GROUP_MEDIA_REQUIRE_MENTION=false` is the default and intentionally allows a voice note, image, video, or document sent without a caption to trigger Bubu in an eligible group. This is a trade-off to support media-only interactions. Set it to `true` for stricter group privacy, but then WAHA must expose a detectable mention in the webhook payload for those media messages.

## Routing details

- The normalizer collects mention identifiers from common WAHA/WhatsApp webhook locations.
- It also selects the first non-empty text/caption candidate. This avoids losing a caption when `body` is present but empty.
- Ordinary group text without mention is silently ignored; Bubu does not send an unsolicited explanation.
- If media is routed but WAHA did not provide `media.url`, the existing explicit diagnostic response is retained.
- `GROUP_POLICY` continues to be an outer group allow/deny switch.

## Deployment

1. Back up the project and SQLite database.
2. Apply the Task 1.3 ZIP over the current Task 1.2 deployment. Preserve `.env`, `data/`, `storage/`, and PM2 configuration.
3. Optionally add `BOT_JID` to `.env` using the Bubu WhatsApp account's JID. Add `GROUP_MEDIA_REQUIRE_MENTION=false` if you want to make the default explicit.
4. Run:
   - `node --check src/channels/waha/client.js`
   - `node --check src/agent/message-processor.js`
   - `node --test test/unit/normalizer.test.js test/unit/group-routing.test.js`
   - `node --test test/unit/config.test.js`
5. Restart Bubu using the existing PM2 process and inspect logs.

No database migration or new npm dependency is required. WAHA and Bubu ports remain unchanged.

## Acceptance tests

1. In a group, send ordinary text without mentioning Bubu; Bubu must remain silent.
2. In a group, send `Bubu, tolong bantu`; Bubu must respond.
3. Mention Bubu using the WhatsApp native @mention picker; with `BOT_JID` configured, Bubu must respond.
4. Send a voice note to a group without a caption; Bubu must process it and return a transcription/summary according to current media capability.
5. Send an image without a caption; Bubu must process it.
6. Send a supported document without a caption; Bubu must ingest and analyze it.
7. Send a captioned image/document without mentioning Bubu; Bubu must remain silent when mention gating is enabled.
8. In a staging group with `GROUP_MEDIA_REQUIRE_MENTION=true`, send media without mention; Bubu must remain silent.
9. Send a normal DM without mentioning Bubu; behavior must remain unchanged.
10. Verify group content is stored and retrieved only within that group's context, not the owner's personal context.

## Not included

Group document-generation authorization and automatic file delivery are Task 1.4/1.5. Voice preference, WhatsApp Markdown formatting, and general output delivery are not changed by this task.
