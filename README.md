# Bubu v2 — P1 Advanced Agent Tools · v2.2.0

Clean rebuild. No Bubu v1 source or data is included.

## Decisions
- Hybrid personal + community assistant, personal-first.
- All WhatsApp groups may interact; by default Bubu responds only when mentioned or addressed by command.
- SQLite persistence.
- Sumopod only, with benchmark-informed dynamic model routing.
- Confirm before external WhatsApp sends.
- No per-model validation flags or model variables required in `.env`.

## Default models
- Fast: `claude-haiku-5-5`
- Balanced: `claude-sonnet-5-5`
- Reasoning/agent: `claude-opus-5-5`
- Coding: `claude-sonnet-5-5`
- Long-context summary: `gemini/gemini-3.1-pro-preview`

See `docs/MODEL-ROUTING.md` for benchmark rationale and optional overrides.

## P0.1 hardening
- Durable SQLite inbox queue with deduplication, retry/backoff, dead-letter state and stale-event recovery.
- Stable task IDs derived from inbound webhook events.
- Persistent tool execution idempotency ledger.
- Durable task response outbox with uncertain-send handling.
- Owner-only, single-claim approvals.
- Persistent reminder delivery state and deduplication.
- Persistent per-sender rate limiting.
- Startup recovery for stale inbox events, tools, approvals, responses and reminders.

## Install
```bash
cp .env.example .env
# Fill OWNER_JID, WAHA_BASE_URL, WAHA_SESSION, WAHA_WEBHOOK_TOKEN and SUMOPOD_API_KEY
# See docs/ENVIRONMENT-CONFIGURATION.md for optional overrides
npm install
npm test
npm run models
npm start
```

Node.js >=22 is required. See `docs/P0-CORE-AGENT.md`, `docs/DEPLOY-AAPANEL.md`, `docs/MODEL-ROUTING.md`, and `docs/TEST-REPORT.md`.

## Important
This build uses at-least-once inbound processing with idempotency safeguards. Remote WhatsApp sends cannot be committed transactionally with SQLite. If delivery status is ambiguous, Bubu marks the action `uncertain` and will not automatically resend it, to avoid duplicate messages.


## P1 Advanced Agent Tools
- Web research: optional Tavily search + safe public web fetch.
- Document intelligence: incoming PDF/DOCX/XLSX/XLSM/CSV/TXT extraction.
- Document creation: DOCX and XLSX with owner-approved WhatsApp delivery.
- Task management: scoped personal and group tasks.
- Reminder management: list and cancel pending reminders.

See `docs/P1-ADVANCED-AGENT-TOOLS.md`. Add optional `TAVILY_API_KEY` to enable web search. WAHA must include `payload.media.url` for incoming file attachments.


## P2 Advanced Memory Intelligence
- Semantic and hybrid long-term memory retrieval using Sumopod embeddings.
- Conservative automatic extraction of durable facts/preferences/goals.
- Episodic conversation event history.
- Project-aware memory and project management tools.
- Strict personal/group workspace isolation.
- No new required `.env` settings; embedding model defaults to `gemini/gemini-embedding-001`.

See `docs/P2-ADVANCED-MEMORY.md`.


## P3 WhatsApp Multimodal Intelligence
- Image OCR using Tesseract.
- Voice-note transcription using local whisper.cpp.
- Video keyframe OCR and optional soundtrack transcription using FFmpeg + Whisper.
- Optional voice replies using Piper TTS + WAHA sendVoice.
- `/voice on`, `/voice off`, `/voice`.
- Sumopod remains the only remote LLM provider; media preprocessing is local.

See `docs/P3-WHATSAPP-MULTIMODAL.md`.
