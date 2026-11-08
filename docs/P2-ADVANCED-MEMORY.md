# P2 — Advanced Memory Intelligence

## Scope
P2 adds persistent, workspace-scoped memory intelligence on top of P0.1/P1:
- Semantic retrieval using Sumopod's OpenAI-compatible embeddings endpoint.
- Hybrid search: cosine similarity + lexical relevance + importance + recency.
- Memory types: fact, preference, goal and project.
- Automatic extraction from explicit durable-memory signals (e.g. "ingat", "mulai sekarang", "preferensi", "proyek").
- Episodic conversation events, stored idempotently by source event.
- Project registry and project-aware context injection.
- Tools: `remember_fact`, `search_memory`, `create_project`, `list_projects`, `update_project`, `list_memory_events`.
- Personal and group memory/project isolation.

## Embedding model
The default embedding model is `gemini/gemini-embedding-001`, which appears in the model catalog supplied by the owner. Bubu calls the same Sumopod base URL:
`POST /embeddings`

The vector is stored as JSON in SQLite. Similarity is computed locally using cosine similarity; no separate vector database is required.

If Sumopod's embeddings endpoint is unavailable or returns an incompatible response, Bubu logs a warning, activates a five-minute circuit breaker, and falls back to lexical search. This prevents repeated embedding timeouts from slowing every WhatsApp message. Chat and agent execution continue normally.

## Automatic memory capture
Automatic extraction is intentionally conservative and is triggered only by durable-memory signals in the user's message. A Sumopod summary-tier model extracts a small JSON list. Temporary requests and ordinary small talk are not automatically stored.

Examples of trigger phrases:
- "Ingat, saya lebih suka jawaban ringkas."
- "Mulai sekarang gunakan bahasa Indonesia."
- "Saya sedang mengerjakan proyek X."
- "Catat keputusan rapat ini."

The extraction prompt rejects passwords, secrets, sensitive personal inferences and temporary information. In group scope it stores only shared group decisions and project context, never an individual member's personal preferences or private profile.

Users can explicitly ask Bubu to remember something; the agent can call `remember_fact`.

## Project awareness
Projects belong to either:
- Personal workspace: owner ID.
- Group workspace: WhatsApp group ID.

Project names, descriptions and statuses are injected into agent context. Relevant project memories can be attached to a project ID. A project ID is validated against the current workspace before a memory can be associated with it.

## Retrieval
At each addressed conversation, Bubu:
1. Generates an embedding for the new query.
2. Retrieves candidate memories only from the current workspace.
3. Scores by semantic similarity, lexical overlap, importance and recency.
4. Injects the top memories and active projects into the system context.
5. Falls back to lexical search if embedding generation fails.

The initial implementation scans at most 500 workspace memories per retrieval. This is suitable for personal use and small group contexts. A dedicated vector index can be introduced only if actual memory volume requires it.

## Migration
P2 adds SQLite migration version 5. Existing P0.1/P1 data is retained. No manual SQL commands are required. Back up before upgrading.

## Minimal environment
No new required `.env` values. Sumopod is still the only AI provider. The embedding model is configured in code as `gemini/gemini-embedding-001`.

## Known limitations
- Embeddings depend on Sumopod exposing a compatible `/embeddings` endpoint for `gemini/gemini-embedding-001`; when unavailable, retrieval falls back to lexical search.
- Automatic extraction is signal-based, not continuous profiling.
- No automatic deletion/expiry policy is enabled yet.
- Project context is selected by lexical relevance over active project names/descriptions; deeper project-specific retrieval uses `projectId`.
- Memory corrections, merge and forget workflows are a future enhancement.
