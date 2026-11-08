# Bubu Environment Configuration

This document is the full reference for environment variables. The root `.env.example` is intentionally minimal: only settings needed for a standard production deployment are listed there. All other settings have application defaults and should be added to `.env` only when an operator needs to override them.

Do not copy this full reference into `.env`. Do not replace an existing production `.env` wholesale when upgrading Bubu; preserve deployment-specific paths, credentials, voice model paths and any intentional overrides.

## 1. Minimal production `.env`

```env
NODE_ENV=production

OWNER_JID=628xxxxxxxxxx@c.us
WAHA_BASE_URL=http://127.0.0.1:3000
WAHA_SESSION=default
WAHA_WEBHOOK_TOKEN=replace-with-a-long-random-secret
WAHA_API_KEY=

SUMOPOD_API_KEY=
```

Required by `loadConfig()`:
- `SUMOPOD_API_KEY`
- `WAHA_BASE_URL`
- `WAHA_SESSION`
- `OWNER_JID`

Additionally, when `NODE_ENV=production`, `WAHA_WEBHOOK_TOKEN` is mandatory. Configure the same token in the WAHA webhook request header. The default header name is `x-webhook-token`.

`WAHA_API_KEY` is optional and is only needed when WAHA API authentication is enabled.

Generate a strong webhook token, for example with `openssl rand -hex 32`. Do not use the example placeholder in production.

## 2. Runtime defaults and optional overrides

Unless stated otherwise, omit these variables from `.env` to use the defaults in `src/config/env.js`.

### Application and storage

| Variable | Default | When to override |
|---|---|---|
| `HOST` | `127.0.0.1` | Change bind address only when deployment topology requires it |
| `PORT` | `3088` | Change Bubu HTTP port |
| `LOG_LEVEL` | `info` | `debug`, `warn`, etc. for diagnostics |
| `DATABASE_PATH` | `./data/bubu.sqlite` | Custom SQLite location |
| `STORAGE_DIR` | `./storage` | Custom generated/uploaded file location |
| `BACKUP_DIR` | `./backups` | Used by `scripts/backup.js` |

Paths are resolved relative to the process working directory. Keep existing production paths if the deployment stores the database and files outside the application directory.

### WhatsApp group policy

| Variable | Default | When to override |
|---|---|---|
| `BOT_JID` | empty | Set if WAHA mention metadata requires the bot's own JID |
| `GROUP_POLICY` | `all` | Restrict which groups may interact |
| `GROUP_REQUIRE_MENTION` | `true` | Set `false` if Bubu should respond to ordinary group messages |
| `GROUP_MEDIA_REQUIRE_MENTION` | `false` | Set `true` to require a mention for media-only group messages |
| `GROUP_PROACTIVE_ENABLED` | `false` | Enable only if proactive group behavior is implemented and intended |
| `WAHA_WEBHOOK_HEADER` | `x-webhook-token` | Change if WAHA sends the webhook token under another header |

### AI provider and model routing

| Variable | Default | When to override |
|---|---|---|
| `SUMOPOD_BASE_URL` | `https://ai.sumopod.com/v1` | Use another compatible API endpoint |
| `SUMOPOD_TIMEOUT_MS` | `60000` | Change provider request timeout |
| `MODEL_FAST` | `claude-haiku-5-5` | Override fast tier |
| `MODEL_BALANCED` | `claude-sonnet-5-5` | Override balanced tier |
| `MODEL_REASONING` | `claude-opus-5-5` | Override reasoning tier |
| `MODEL_CODING` | `claude-sonnet-5-5` | Override coding tier |
| `MODEL_SUMMARY` | `gemini/gemini-3.1-pro-preview` | Override summary tier |
| `TAVILY_API_KEY` | empty | Enable web search; without it the search tool is not registered |
| `WEB_SEARCH_MAX_RESULTS` | `5` | Set number of web results (bounded 1–10) |

All model tiers currently declare tool support in configuration. A model override should be tested with Bubu's actual tool-calling workflow before production use.

### Documents and generated files

| Variable | Default | When to override |
|---|---:|---|
| `MAX_DOCUMENT_BYTES` | `15728640` (15 MiB) | Change document upload/generation size limit (bounded 1–30 MiB) |
| `MAX_DOCUMENT_CHARS` | `50000` | Change extracted document text limit (bounded 5,000–100,000 characters) |

### Multimodal processing and voice

| Variable | Default | When to override |
|---|---|---|
| `MEDIA_INTELLIGENCE_ENABLED` | `true` | Disable image/audio/video preprocessing |
| `MAX_MEDIA_BYTES` | `26214400` (25 MiB) | Change media size limit (bounded 1–50 MiB) |
| `MAX_AUDIO_SECONDS` | `900` | Change maximum audio duration (bounded 30–1,800 seconds) |
| `MAX_VIDEO_SECONDS` | `180` | Change maximum video duration (bounded 10–300 seconds) |
| `MAX_VIDEO_FRAMES` | `8` | Change extracted video frame limit (bounded 1–12) |
| `TESSERACT_BIN` | `tesseract` | Custom Tesseract executable path |
| `FFMPEG_BIN` | `ffmpeg` | Custom FFmpeg executable path |
| `FFPROBE_BIN` | `ffprobe` | Custom FFprobe executable path |
| `WHISPER_BIN` | `whisper-cli` | Custom whisper.cpp executable path |
| `WHISPER_MODEL_PATH` | empty | Required to enable local voice transcription |
| `WHISPER_LANGUAGE` | `auto` | Set transcription language |
| `PIPER_BIN` | `piper` | Custom Piper executable path |
| `PIPER_MODEL_PATH` | empty | Required to enable local voice replies |
| `VOICE_REPLY_DEFAULT` | `false` | Default new-chat output mode (`true` selects text + voice) |

Important: keep `WHISPER_MODEL_PATH` and `PIPER_MODEL_PATH` in the real `.env` if your production installation uses local models. Removing them disables the corresponding local STT/TTS capability.

### Agent runtime

| Variable | Default | When to override |
|---|---:|---|
| `AGENT_ENABLED` | `true` | Disable AI agent processing |
| `AGENT_MAX_ROUNDS` | `5` | Change model planning round limit |
| `AGENT_MAX_TOOL_CALLS` | `8` | Change tool-call limit per task |
| `AGENT_MAX_TOOL_RESULT_CHARS` | `12000` | Change tool result context limit |
| `AGENT_MAX_OUTPUT_TOKENS` | `4096` | Change model output budget (bounded 1,024–8,192) |
| `AGENT_TASK_TIMEOUT_MS` | `90000` | Change total Agent deadline |
| `AGENT_TOOL_TIMEOUT_MS` | `15000` | Change individual tool deadline |
| `AGENT_MAX_CONCURRENT_JOBS` | `1` | Change Agent concurrency |
| `MESSAGE_RATE_LIMIT` | `10` | Change messages allowed per rate window |
| `MESSAGE_RATE_WINDOW_MS` | `60000` | Change rate-limit window |
| `APPROVAL_TTL_MINUTES` | `5` | Change approval expiration |

### Inbox reliability

| Variable | Default | When to override |
|---|---:|---|
| `INBOX_POLL_MS` | `500` | Change worker polling interval (bounded 100–5,000 ms) |
| `INBOX_MAX_ATTEMPTS` | `5` | Change maximum event attempts (bounded 1–10) |
| `INBOX_STALE_MS` | `120000` | Change stale processing lock threshold (bounded 30,000–600,000 ms) |

## 3. Suggested production `.env` policy

Keep only:
1. Required secrets and service connection details.
2. Non-default paths needed by the actual VPS directory layout.
3. Local model paths needed for STT/TTS.
4. Intentional behavior overrides (for example group mention policy or default voice mode).

Do not add a variable just because it exists in this reference. Defaults are part of the application configuration.

## 4. Safe cleanup procedure

1. Back up the current `.env` before editing.
2. Compare each existing key with this reference and `src/config/env.js`.
3. Keep credentials, custom paths and settings that differ from the defaults.
4. Remove only keys whose current value exactly matches the intended default and whose behavior is not intentionally pinned.
5. Restart Bubu and run `node -e "require('dotenv').config(); const {loadConfig}=require('./src/config/env'); const c=loadConfig(); console.log({port:c.port, databasePath:c.databasePath, storageDir:c.storageDir, inbox:c.inbox, agent:c.agent});"`.
6. Verify DM, group, voice, file generation/delivery, reminders and webhook authentication.

Never print or share the real `.env` contents because it contains API keys and webhook secrets.
