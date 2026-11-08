# Bubu Task 2.3 — Normalization and Media Download Patch

**Project baseline:** Bubu 2.4.0 with the owner-applied Task 2.2 patch  
**Patch status:** Prepared and locally focused-tested; NOT deployed  
**Scope:** Task 2.3 only. Apply on top of the successfully deployed Task 2.2 state.

## ZIP layout

This is an overlay ZIP. Extract it from `/www/wwwroot/bot-project` (the parent directory of the existing `bubu` project).

It replaces four source files and adds/updates five test files:

- `bubu/src/channels/waha/client.js`
- `bubu/src/agent/message-processor.js`
- `bubu/src/p1/documents/service.js`
- `bubu/src/p3/media/service.js`
- `bubu/test/unit/normalizer.test.js`
- `bubu/test/unit/p1-services.test.js`
- `bubu/test/unit/p3-media.test.js`
- `bubu/test/unit/group-routing.test.js`
- `bubu/test/unit/message-processor-media-errors.test.js`
- `bubu/docs/PATCH_TASK_2_3_NOTES.md`

The Task 2.2 media-error test file is included with a small fixture update (`config.waha.baseUrl`) because Task 2.3 now normalizes media URLs at the MessageProcessor boundary.

No `.env`, database, storage files, PM2 config, package manifest, or dependency lockfile is included.

## Changes

### 1. Native GOWS metadata normalization

`normalizeIncoming()` now supports native WAHA GOWS structures in `_data.Message` and `_data.RawMessage` for:

- `imageMessage`
- `videoMessage`
- `audioMessage` (including PTT)
- `documentMessage`
- `documentWithCaptionMessage`

It maps native `URL`, `fileName`, `mimetype`, caption, duration, file length, media type, and PTT flag into the normalized media object.

The normalizer deliberately does not copy native encryption fields such as `mediaKey`, `e2EeMediaKey`, or message secrets into the normalized media metadata.

Caption extraction now includes native GOWS image/video/document caption fields.

### 2. URL/origin normalization

The shared `normalizeMediaUrl()`:

- accepts relative and absolute media URLs;
- resolves relative paths against configured WAHA base URL;
- preserves the existing local WAHA alias remapping for `localhost`, `127.0.0.1`, `0.0.0.0`, and IPv6 loopback;
- permits only HTTP/HTTPS;
- rejects embedded URL credentials;
- requires the final origin to exactly match configured WAHA origin;
- removes URL fragments.

`MessageProcessor` now normalizes and validates the URL before deriving a media filename/kind, so a relative WAHA URL does not fail at `new URL(relativeUrl)`.

### 3. Redirect, size, MIME and signature checks

Both media and document download paths now:

- set Axios `maxRedirects: 0`;
- reject non-2xx responses, including redirects;
- check declared `Content-Length` before persisting;
- retain Axios response-size limits and check actual buffer size;
- normalize MIME parameters such as `audio/ogg; codecs=opus`;
- compare declared MIME and response `Content-Type` with the extension/category;
- validate file signatures before writing to storage;
- avoid creating inbound storage directories before validation succeeds;
- clean up a partially written file if writing fails.

The media service now uses stricter signatures for AMR, M4A, AAC, and WebM rather than accepting any payload longer than 12 bytes. AMR magic validation uses the actual newline byte.

Missing/generic media filenames can derive an extension from a recognized MIME type. Document filenames without extensions can derive supported extensions from declared MIME.

### 4. Redirect and SSRF boundary

Redirects are disabled rather than followed, so an approved WAHA URL cannot redirect the download to a different origin.

The URL origin is constrained to the configured WAHA origin. The configured WAHA endpoint remains a trusted deployment setting; this patch does not independently pin DNS answers for that configured host. Do not allow untrusted parties to change `WAHA_BASE_URL`.

### 5. Cleanup

`MediaIntelligenceService.processIncoming()` now creates its work directory inside the `try/finally`, so the downloaded file is still removed if temporary work-directory creation fails.

The media download path creates storage directories only after URL, response, size, MIME, and signature validation.

## Tests added/updated

- Native GOWS image caption/media normalization.
- Native GOWS PTT metadata mapping without encryption-field propagation.
- Native GOWS video/document caption normalization.
- Media-only event with empty native URL remains recognized as media.
- Relative URL resolution, foreign-origin rejection, URL credentials and non-HTTP scheme rejection.
- MIME parameter normalization.
- Relative PDF download with redirects disabled.
- Document redirect/MIME rejection before persistence.
- Document extension inference when filename is missing.
- Missing/generic media filename extension inference.
- MIME/extension mismatch rejection.
- Strict AMR/M4A/AAC/WebM signatures.
- Relative media URL download with MIME parameters.
- Redirect, oversized content length, response MIME mismatch and bad-signature rejection.
- Foreign-origin and credential-bearing media URL rejection.
- Audio WebM versus video WebM MIME-category validation.
- MessageProcessor relative media URL routing.
- MessageProcessor foreign-origin media rejection before media processing.

## Local validation performed

Syntax checks passed for all changed source and test files.

Focused regression command completed with:

**101 tests passed, 0 failed, 0 skipped.**

The focused set includes:
- normalizer
- P1 document services
- P3 media service
- group routing
- Task 2.2 media error tests
- inbox worker
- error policy
- voice output
- response handler
- Phase 1 regression contract

The full unit suite was also attempted in the patch workspace: 156 passed, 3 failed because the workspace did not have the `docx`, `exceljs`, and `zod` runtime dependencies installed. The Phase 1 script similarly reports missing local runtime/test dependencies in this isolated workspace. These are environment limitations, not passing results. Run full tests on the VPS where the project's dependencies are installed.

## Owner test/deployment procedure

1. Verify ZIP integrity with `unzip -t`.
2. Back up the four source files and existing test files listed above.
3. Extract from `/www/wwwroot/bot-project`, not from inside `bubu`.
4. Run `node --check` on all changed JavaScript source and test files.
5. Run the focused regression command supplied in the handover.
6. Run `npm run test:unit`, `npm test`, and `npm run test:phase1` in the VPS project environment.
7. If automated tests pass, perform actual WAHA media download acceptance in a staging/owner-controlled DM and test group. Cover image, PTT/audio, video, and a small document fixture.
8. Confirm foreign-origin URLs and redirects are rejected, and valid files are cleaned up after processing.
9. Do not replay old dead-letter events automatically.

No PM2 restart, deployment, database migration, or VPS modification was performed while preparing this patch.
