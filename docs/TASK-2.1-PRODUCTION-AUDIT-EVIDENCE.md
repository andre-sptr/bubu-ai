# Bubu Phase 2 --- Task 2.1 Production Test Evidence

**Evidence snapshot date:** 8 November 2026\
**Project/build:** Bubu 2.4.0\
**Purpose:** Preserve the Task 2.1 audit evidence collected from the VPS
and Sumopod before preparing the Task 2.2 patch proposal.

> This report records observed results from the supplied VPS outputs and
> test responses. It does not claim untested capabilities as passing.
> Secrets, private URLs, JIDs, media keys, message IDs, and message
> contents are intentionally excluded.

------------------------------------------------------------------------

## 1. Executive summary

Task 2.1 has produced useful production evidence, but **Task 2.1 is not
yet fully closed**.

Key conclusions:

1.  The VPS baseline matches the supplied Bubu 2.4.0 source snapshot on
    all six checked SHA-256 hashes.
2.  WAHA 2026.10.1 CORE/GOWS successfully delivered image, PTT, ordinary
    audio, video, and reply/quote webhook fixtures into Bubu's inbox.
3.  Image and quote webhook metadata were observed in the actual GOWS
    payload.
4.  PTT and ordinary audio events both reached `dead` after five
    attempts. Both recorded the error category
    `classifyOperationalError_reference`, consistent with the
    missing-import defect identified in
    `src/agent/message-processor.js`.
5.  The original media-processing error that occurred before the
    classifier was called has **not** been recovered from the supplied
    sanitized output. The missing Whisper/Piper prerequisites are a
    separate audio capability blocker.
6.  Video preprocessing completed for the tested silent/no-text clip,
    but Bubu explicitly reported that it could not interpret scenes or
    motion. This is partial processing, not video scene understanding.
7.  Sumopod `claude-sonnet-5-5` passed text control, two-image visual
    identification, and image-plus-tool-call probes.
8.  `claude-sonnet-5-5` is selected as the **candidate visual model**
    for Phase 2. This is a decision based on the limited probes, not a
    completed production integration or broad quality acceptance.

### Overall status

  -----------------------------------------------------------------------
  Subtask                 Status                  Evidence
  ----------------------- ----------------------- -----------------------
  2.1A --- VPS/source     PASS                    VPS output and six
  inventory                                       matching hashes

  2.1B --- GOWS metadata  PARTIAL PASS            Image, PTT, audio,
  fixtures                                        video, quote metadata
                                                  observed

  2.1B --- PTT/audio      FAIL                    Both audio events dead
  processing                                      after 5 attempts; same
                                                  classifier
                                                  ReferenceError category

  2.1C --- Sumopod text   PASS                    HTTP 200; expected text
  control                                         control response

  2.1C --- Sumopod visual PASS (limited fixtures) Apple and banana
  input                                           recognized correctly

  2.1C --- Visual plus    PASS (limited fixtures) One valid expected tool
  tool calling                                    call for each image

  2.1D --- Decision       PENDING                 Remaining evidence and
  freeze                                          owner confirmation
                                                  still required
  -----------------------------------------------------------------------

------------------------------------------------------------------------

## 2. Baseline: source and VPS inventory (Task 2.1A)

### 2.1 VPS/runtime

  -----------------------------------------------------------------------
  Item                                Observed result
  ----------------------------------- -----------------------------------
  Bubu package version                2.4.0

  Node.js shell                       v24.22.1

  Node.js PM2                         v24.22.1

  PM2 process CWD                     Matches
                                      `/www/wwwroot/bot-project/bubu`

  Configuration source used for audit PM2 process environment + local
                                      `.env`

  Config loader                       Readable

  SQLite schema version               9

  Bubu `/health`                      HTTP 200

  Bubu `/ready`                       HTTP 200

  SQLite readiness                    true

  CPU available                       2

  RAM total                           1.9 GiB

  Disk free                           23.7 GiB

  WAHA                                2026.10.1

  WAHA tier/engine                    CORE / GOWS

  WAHA session                        WORKING

  WAHA version/session HTTP checks    HTTP 200

  Registered webhook events visible   `session.status`, `message`

  FFmpeg / FFprobe                    6.1.1

  `libopus`                           available

  Tesseract                           5.3.4

  Tesseract languages                 `ind`, `eng` available

  Whisper CLI                         ENOENT

  Whisper model                       not configured

  Piper CLI                           ENOENT

  Piper model/config                  not configured

  Media enabled                       true

  Configured max media                25 MiB

  Configured max audio duration       900 seconds

  Configured max video duration       180 seconds

  Configured max video frames         8
  -----------------------------------------------------------------------

### 2.2 Routing and model configuration observed

  Setting                         Value
  ------------------------------- ---------------------------------
  `GROUP_POLICY`                  `all`
  Group mention required          true
  `GROUP_MEDIA_REQUIRE_MENTION`   false
  `fast`                          `claude-haiku-5-5`
  `balanced`                      `claude-sonnet-5-5`
  `coding`                        `claude-sonnet-5-5`
  `reasoning`                     `claude-opus-5-5`
  `summary`                       `gemini/gemini-3.1-pro-preview`

### 2.3 Snapshot identity

The VPS audit output reported these six source hashes, matching the
supplied archive snapshot:

  ---------------------------------------------------------------------------------------------------------
  File                                 SHA-256
  ------------------------------------ --------------------------------------------------------------------
  `package.json`                       `3fc998e3cb27a9d41985f26145a6c21cbe78e55d8492889a5956dc3b80516910`

  `src/agent/message-processor.js`     `451df27f9d1e2b458c3be82e3c759bfd9a7d1db99802f383c910f6b8929cb8a6`

  `src/channels/waha/client.js`        `f598ebc4ec515037394716ecc4959f267c3a4517fcf620ac5ced11159ab30623`

  `src/channels/response-handler.js`   `466a78f0031697dac39d53387ab80ccbe988ac00b8e8efcc8efcb8f6da0add5c`

  `src/p3/media/service.js`            `452a0d595b967edfd3265afb062c4da775935b0c51d970d4a37fd4601e4bebc6`

  `src/config/env.js`                  `b910fb19f121aea8e77813c48f52c43c06053f476137180c11840c4e50b5469d`
  ---------------------------------------------------------------------------------------------------------

The supplied archive SHA-256 was recorded as:

`6f5861a0b80c59965af5ef529513abfc5583dda3b5ea4143f951a6283a821a5e`

The inventory establishes consistency at the time of the VPS check. It
does not establish that no hotfix occurred after that snapshot.

------------------------------------------------------------------------

## 3. SQLite schema inspection

A read-only schema inspection succeeded after correcting the
configuration property to `cfg.databasePath`.

Observed database schema version: **9**.

Relevant tables and columns:

### `inbox_events`

-   `event_id`
-   `chat_id`
-   `sender_id`
-   `payload_json`
-   `status`
-   `attempts`
-   `available_at`
-   `locked_at`
-   `last_error`
-   `created_at`
-   `updated_at`

This table was used as the primary source for webhook fixture metadata
and processing status.

### `messages`

-   `id`
-   `chat_id`
-   `scope`
-   `role`
-   `sender_id`
-   `content`
-   `event_id`
-   `created_at`

Message content was not needed for the metadata inspections recorded
here.

------------------------------------------------------------------------

## 4. WAHA GOWS fixtures (Task 2.1B)

All payload inspections described below used read-only SQLite queries
and emitted selected metadata or field paths/types rather than raw
payloads.

### 4.1 Images with captions

Two distinct image events were found. The owner clarified that these
were **not duplicates**:

-   First image: sent using WhatsApp Web copy/paste.
-   Second image: sent using WhatsApp Mobile from the phone gallery.

Both events were completed and exposed image metadata in GOWS.

Observed field paths included:

-   `payload.hasMedia`
-   `payload._data.Info.IsFromMe`
-   `payload._data.Info.IsGroup`
-   `payload._data.Info.MediaType`
-   `payload._data.Message.imageMessage.URL`
-   `payload._data.Message.imageMessage.caption`
-   `payload._data.Message.imageMessage.mimetype`
-   `payload._data.Message.imageMessage.fileLength`
-   `payload._data.Message.imageMessage.width`
-   `payload._data.Message.imageMessage.height`
-   `payload._data.RawMessage.imageMessage.*`

**Result:** PASS for image webhook metadata and caption field discovery
across the two send methods.

The observed structure contains both `Message` and `RawMessage`
representations. A production normalizer should avoid assuming that
every optional field is always present in both representations.

### 4.2 Image without caption

A WhatsApp Mobile image event was observed:

  Field                Observed value
  -------------------- ----------------
  Inbox status         `completed`
  `Info.IsGroup`       false
  `Info.Type`          `media`
  `Info.MediaType`     `image`
  Caption              missing
  Raw caption          missing
  `payload.hasMedia`   true
  URL scheme           HTTPS
  MIME                 `image/jpeg`
  File length          153,976 bytes
  Dimensions           1200 × 1600
  Raw image object     present

**Result:** PASS for image-without-caption metadata detection.

Important distinction: `caption: missing` was observed. This is not the
same as a present caption field containing `null` or an empty string.

### 4.3 PTT voice note

A WhatsApp Mobile PTT fixture was observed:

  Field                Observed value
  -------------------- --------------------------
  Inbox status         `dead`
  Attempts             5
  `Info.MediaType`     `ptt`
  `Info.Type`          `media`
  `payload.hasMedia`   true
  `audioMessage.PTT`   true
  MIME                 `audio/ogg; codecs=opus`
  Duration             8 seconds
  File length          20,519 bytes
  URL field            present
  Audio metadata       present

Observed audio fields included URL, MIME, file hash, file length,
duration, PTT flag, media key, direct path, media-key timestamp,
media-domain metadata, and waveform.

**Result:** PASS for PTT webhook metadata; FAIL for inbox processing.

### 4.4 Ordinary audio file

An ordinary audio file (not PTT) was observed:

  Field                Observed value
  -------------------- --------------------------
  Inbox status         `dead`
  Attempts             5
  `Info.MediaType`     `audio`
  `Info.Type`          `media`
  `payload.hasMedia`   true
  `audioMessage.PTT`   false
  MIME                 `audio/ogg; codecs=opus`
  Duration             19 seconds
  File length          43,612 bytes
  URL field            present

**Result:** PASS for ordinary-audio webhook metadata; FAIL for inbox
processing.

### 4.5 Audio failure comparison

A read-only diagnostic compared the two audio events:

  -----------------------------------------------------------------------------------------------------
  Field                   PTT                                    Ordinary audio
  ----------------------- -------------------------------------- --------------------------------------
  Status                  `dead`                                 `dead`

  Attempts                5                                      5

  Error present           true                                   true

  Error category          `classifyOperationalError_reference`   `classifyOperationalError_reference`

  Media type              `ptt`                                  `audio`
  -----------------------------------------------------------------------------------------------------

This independently confirms that both audio fixtures reached the same
recorded error category.

The source audit found that `src/agent/message-processor.js` calls
`classifyOperationalError(error)` without importing the function, while
the function exists in `src/utils/error-policy.js`.

**Confirmed defect:** the missing classifier import can cause a
`ReferenceError` while handling an earlier media-processing error.

**Not established:** the original media-processing error that occurred
before the classifier call. The sanitized outputs do not establish
whether that original error was caused by missing Whisper, media
download, decoding, or another condition.

**Separate known blocker:** the VPS inventory showed Whisper CLI/model
and Piper CLI/model/config were not available. This blocks current
STT/TTS acceptance independently of the classifier defect.

Do not manually retry or delete these dead-letter events as part of
evidence collection.

### 4.6 Video fixture

The owner sent a silent video with no visible text and reported Bubu's
response. The response said that the video had entered processing, but
Bubu could not infer scenes or motion; its current processing only
extracts frame text and speech transcription.

The corresponding inbox fixture showed:

  Field                Observed value
  -------------------- -----------------
  Inbox status         `completed`
  Attempts             1
  `Info.MediaType`     `video`
  `Info.Type`          `media`
  `Info.IsGroup`       false
  `payload.hasMedia`   true
  Video object         present
  Caption              non-empty
  MIME                 `video/mp4`
  Duration metadata    5 seconds
  File length          1,301,114 bytes
  Dimensions           480 × 864
  URL field            present
  Raw video object     present

Bubu's WhatsApp response referred to the clip as 6 seconds, while the
inspected WAHA metadata reported 5 seconds. This discrepancy is recorded
for later investigation; the evidence does not identify which duration
measurement is authoritative.

**Result:** PASS for video webhook ingress and metadata. PARTIAL for
existing OCR/transcription processing. FAIL / NOT IMPLEMENTED for visual
scene and motion understanding.

### 4.7 Reply/quote to an image

A reply event was observed:

  Field                           Result
  ------------------------------- -------------
  Inbox status                    `completed`
  Event type                      `message`
  `Info.IsGroup`                  false
  `payload.replyTo.participant`   present
  `contextInfo`                   present
  `contextInfo.stanzaID`          present
  `contextInfo.participant`       present
  `contextInfo.quotedMessage`     present
  RawMessage quote                present
  Current chat metadata           present

A follow-up sanitized inspection found:

-   `quotedMessage` contains an `imageMessage` key.
-   `rawQuotedMessagePresent` is true.
-   `replyTo` exposes keys `_data`, `hasMedia`, `id`, `media`, and
    `participant`.

**Result:** PASS for quote metadata availability and quoted-image type
identification.

**Not yet tested:** whether Bubu validates the quoted message's chat
against the current chat, rejects cross-chat references, and safely
handles missing or malformed quote references. Metadata presence alone
does not prove same-chat isolation.

------------------------------------------------------------------------

## 5. Sumopod capability probes (Task 2.1C)

All probes used the configured `balanced` model, `claude-sonnet-5-5`,
and the active Sumopod configuration loaded locally on the VPS. The API
key was not printed.

### 5.1 Text control

  Field               Result
  ------------------- ---------------------
  HTTP status         200
  Configured model    `claude-sonnet-5-5`
  Returned model      `claude-sonnet-5-5`
  Finish reason       `stop`
  Answer              `TEXT_CONTROL_OK`
  Latency             1,950 ms
  Prompt tokens       29
  Completion tokens   15
  Total tokens        44

**Result:** PASS.

### 5.2 Visual image identification

Two different JPEG fixtures were sent with the same prompt: "What is the
main object in this image? Answer with one short sentence."

  Field                        Apple fixture                 Banana fixture
  ------------------- ---------------------- ------------------------------
  HTTP status                            200                            200
  Returned model         `claude-sonnet-5-5`            `claude-sonnet-5-5`
  Finish reason                       `stop`                         `stop`
  Answer                Red and yellow apple   Bunch of ripe yellow bananas
  Latency                           2,506 ms                       2,896 ms
  Image size                    28,850 bytes                   15,445 bytes
  Prompt tokens                          430                            430
  Completion tokens                       18                             21
  Total tokens                           448                            451

**Result:** PASS on the two tested synthetic fixtures.

The observed 2/2 result is not a broad production accuracy benchmark.

### 5.3 Visual input plus tool calling

A synthetic function tool, `report_visual_observation`, was declared in
the request. Tool execution was not performed; only model-generated
tool-call structure was inspected.

  -----------------------------------------------------------------------------------
  Field                   Apple fixture                 Banana fixture
  ----------------------- ----------------------------- -----------------------------
  HTTP status             200                           200

  Returned model          `claude-sonnet-5-5`           `claude-sonnet-5-5`

  Finish reason           `tool_calls`                  `tool_calls`

  Tool call count         1                             1

  Tool name               `report_visual_observation`   `report_visual_observation`

  Main object             `apple`                       `A bunch of bananas`

  Dominant color          `red`                         `Yellow`

  Latency                 2,226 ms                      1,635 ms
  -----------------------------------------------------------------------------------

**Result:** PASS for combined image input and tool-call generation on
these two fixtures.

**Scope limitation:** the synthetic tool was not executed. This test
does not prove Bubu's full runtime tool execution, authorization,
idempotency, or delivery path works with image input.

### 5.4 Visual model decision

The owner explicitly selected `claude-sonnet-5-5` as the **candidate
visual model**.

This decision is recorded as a candidate selection for Phase 2.6. It is
not yet a completed production integration, nor proof of performance
across complex photos, screenshots, documents, low-quality images, or
adversarial content.

------------------------------------------------------------------------

## 6. Consolidated capability matrix

  --------------------------------------------------------------------------
  Capability              Status                  Notes
  ----------------------- ----------------------- --------------------------
  VPS/source baseline     PASS                    Six hashes match supplied
                                                  snapshot

  WAHA GOWS session/API   PASS                    Reported WORKING; HTTP 200
                                                  checks

  Image with caption      PASS                    Web and Mobile fixtures
  ingress                                         

  Image without caption   PASS                    Missing caption field
  ingress                                         observed

  Image media metadata    PASS                    URL/MIME/size/dimensions
                                                  present

  PTT ingress metadata    PASS                    OGG/Opus, PTT true

  Ordinary audio ingress  PASS                    OGG/Opus, PTT false
  metadata                                        

  PTT processing          FAIL                    Dead after five attempts;
                                                  classifier ReferenceError
                                                  category

  Ordinary audio          FAIL                    Dead after five attempts;
  processing                                      same classifier error
                                                  category

  Whisper STT             BLOCKED                 CLI/model unavailable
  prerequisite                                    

  Piper TTS prerequisite  BLOCKED                 CLI/model/config
                                                  unavailable

  Video ingress metadata  PASS                    MP4 metadata present

  Video OCR/transcription PARTIAL                 Bubu reported text/speech
  pipeline                                        extraction only

  Video scene             NOT IMPLEMENTED / GAP   No motion/scene
  understanding                                   comprehension demonstrated

  Quote metadata          PASS                    Quoted image present in
                                                  webhook

  Same-chat quote         NOT TESTED              Must be verified
  enforcement                                     

  Sumopod text control    PASS                    HTTP 200, correct response

  Sumopod visual          PASS (limited)          2 synthetic images
  identification                                  

  Sumopod visual +        PASS (limited)          2 valid tool calls
  tool-call generation                            

  Full Bubu runtime       NOT TESTED              Synthetic tool was not
  visual tool execution                           executed

  Sumopod audio/video     NOT TESTED              No direct probe performed
  input                                           

  Group media/mention     NOT TESTED in this      Existing policy recorded,
  controls                fixture set             acceptance pending
  --------------------------------------------------------------------------

------------------------------------------------------------------------

## 7. Risks and follow-up items

### 7.1 Audio error handling

The missing `classifyOperationalError` import is a confirmed
source-level defect with matching production dead-letter evidence for
both PTT and ordinary audio.

Task 2.2 should correct the classifier path and verify:

-   Terminal errors do not retry.
-   Temporary errors follow existing bounded retry/backoff.
-   Dead-letter behavior remains correct.
-   Chat response preferences (`text`, `voice`, `both`) are respected.
-   Voice-only remains fail-closed if TTS fails.
-   `uncertain` delivery does not trigger duplicate sends or a second
    notification.
-   Presence cleanup remains intact.

The original underlying media-processing error should be preserved in
logs/diagnostics in a sanitized form where possible.

### 7.2 Media download and SSRF

Metadata presence and an HTTPS URL scheme do not prove that download
succeeds or that the destination is safe.

Before Task 2.3 acceptance, verify:

-   Origin allowlisting against the configured WAHA origin.
-   Redirect destination validation or redirects disabled.
-   DNS/private-network destination restrictions as appropriate.
-   MIME, extension, signature, and size consistency.
-   Cleanup on every success and failure path.

### 7.3 Quote isolation

Task 2.4 must verify that quoted content cannot cross chat boundaries. A
present `stanzaID`, participant, or quoted object is not by itself proof
of same-chat ownership.

### 7.4 Video duration discrepancy

The inspected WAHA metadata was 5 seconds; Bubu's response said 6
seconds. Compare the source media's FFprobe duration and the application
duration calculation before changing any limit or user-facing claim.

### 7.5 VPS resources

The VPS has 2 CPUs and 1.9 GiB RAM. Keep initial media concurrency
conservative. Benchmark before adding local models or increasing limits.

------------------------------------------------------------------------

## 8. Task 2.1 closure criteria still outstanding

Do not mark Task 2.1 fully complete until the following have been
addressed or explicitly accepted as blocked/not tested:

1.  Document fixture metadata and validation, if required by the agreed
    2.1B evidence matrix.
2.  Same-chat quote verification and cross-chat quote rejection
    evidence.
3.  Sumopod probes for other modalities only if the selected
    implementation path requires them. Image capability is already
    demonstrated for the selected candidate.
4.  Record remaining media download validation gaps.
5.  Separate PASS, FAIL, BLOCKED, and NOT TESTED in the final
    owner-facing decision freeze.
6.  Owner confirms the Task 2.2 priority and patch scope.

The roadmap says Task 2.1D must freeze verified formats, remaining gaps,
and VPS trial limits before the Task 2.2 patch is proposed.

------------------------------------------------------------------------

## 9. Proposed next engineering action: Task 2.2

The owner has selected Task 2.2 as the next implementation priority and
selected `claude-sonnet-5-5` as the visual candidate.

### Proposed narrow patch scope

**Primary file:**

-   `src/agent/message-processor.js`

**Additional files only if tests show they are necessary:**

-   `src/utils/error-policy.js`
-   `src/workers/inbox-worker.js`

**Expected initial scope:**

1.  Import `classifyOperationalError` correctly.
2.  Route media terminal notifications through the established
    response-mode handling.
3.  Preserve existing `InboxWorker` retry/backoff and dead-letter
    policy.
4.  Preserve uncertain-delivery handling and presence cleanup.
5.  Avoid schema migration.
6.  Avoid changing the visual provider decision in this patch.
7.  Keep Whisper/Piper provisioning out of Task 2.2.

### Required tests before owner review

-   Processor tests for media DM/group failures.
-   403 terminal behavior.
-   429 and timeout bounded retry behavior.
-   Missing URL, unsupported format, and media-disabled validation
    paths.
-   `text`, `voice`, and `both` preferences.
-   Voice-only with TTS failure remains fail-closed.
-   `uncertain` delivery does not duplicate notification or send.
-   Existing group routing and presence cleanup tests.

### Deployment boundary

No production patch, restart, migration, or VPS configuration change is
included in this evidence report. The owner retains deployment and
WhatsApp acceptance responsibility.

------------------------------------------------------------------------

## 10. Evidence handling and privacy

This report intentionally preserves:

-   Sanitized test outcomes.
-   Event processing statuses and attempt counts.
-   Media types, MIME types, sizes, durations, and dimensions.
-   Model names, HTTP status, finish reasons, latency, and token usage.
-   Source hash evidence.

It intentionally excludes:

-   API keys and `.env` values.
-   WAHA tokens and private media URLs.
-   JIDs, phone numbers, and raw chat identifiers.
-   Media keys, encryption keys, and message secrets.
-   Raw webhook payloads and private conversation contents.

**Document status:** Task 2.1 evidence record --- version 1.0, 8
November 2026.\
**Overall audit status:** evidence preserved; Task 2.1D decision freeze
still pending.
