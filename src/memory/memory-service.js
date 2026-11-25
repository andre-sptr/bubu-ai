const crypto = require('node:crypto');

const DURABLE_SIGNAL = /\b(ingat|remember|catat|simpan|preferensi|saya suka|saya tidak suka|mulai sekarang|ke depannya|proyek|sedang mengerjakan|rencana saya|tujuan saya|target saya|fokus saya|jangan lupa|nama saya|panggil saya|saya tinggal|pekerjaan saya|kerja saya|saya bekerja|saya kuliah|saya sedang kuliah|jurusan saya|kampus saya|hobi saya|ulang tahun|zona waktu|timezone|my name is|call me|i prefer|i like|i dislike|i live in|i work|i am working on|my goal|my project)\b/i;

function extractJsonObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const text = raw;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              return parsed;
            }
          } catch {
            // Keep scanning when earlier braces are non-JSON prose.
          }
          break;
        }
      }
    }
  }
  return null;
}

class MemoryService {
  constructor({ db, provider, router, logger, embeddingModel = 'gemini/gemini-embedding-001' }) {
    Object.assign(this, { db, provider, router, logger, embeddingModel });
    this.embeddingCooldownUntil = 0;
    this._embedInFlight = new Map();
  }

  async embed(text) {
    const normalized = String(text || '').trim().slice(0, 8000);
    if (normalized.length < 2) return null;
    if (Date.now() < this.embeddingCooldownUntil) return null;
    if (!this.provider || typeof this.provider.embed !== 'function') return null;

    if (this._embedInFlight.has(normalized)) {
      return this._embedInFlight.get(normalized);
    }

    const promise = (async () => {
      try {
        const vector = await this.provider.embed({
          input: normalized,
          model: this.embeddingModel,
          timeoutMs: 8000
        });
        this.embeddingCooldownUntil = 0;
        return vector;
      } catch (error) {
        // Avoid adding an 8-second delay to every WhatsApp message if this
        // Sumopod account does not expose the embeddings endpoint.
        this.embeddingCooldownUntil = Date.now() + 5 * 60 * 1000;
        this.logger?.warn({ error: error.message }, 'Embedding unavailable; using lexical memory search for five minutes');
        return null;
      } finally {
        this._embedInFlight.delete(normalized);
      }
    })();

    this._embedInFlight.set(normalized, promise);
    return promise;
  }

  async remember({
    scope, ownerId = null, chatId = null, content,
    title = null, memoryType = 'fact', importance = 3,
    projectId = null, source = 'conversation', sourceEventId = null,
    metadata = {}, supersedeId = null, kind = null
  }) {
    if (projectId) {
      const project = this.db.getProject(projectId, scope,
        scope === 'personal' ? ownerId : null,
        scope === 'group' ? chatId : null);
      if (!project) throw new Error('Project tidak ditemukan pada workspace ini.');
    }
    if (supersedeId !== null && supersedeId !== undefined && typeof this.db.getMemory === 'function') {
      const existingOld = this.db.getMemory({ id: supersedeId, scope, ownerId, chatId });
      if (!existingOld) throw new Error('Memori yang akan digantikan tidak ditemukan pada workspace ini.');
    }
    const resolvedKind = kind || memoryType;
    const vector = await this.embed(`${title || ''}\n${content}`);
    if (supersedeId !== null && supersedeId !== undefined) {
      const result = this.db.supersedeMemory({
        oldId: Number(supersedeId),
        scope,
        ownerId,
        chatId,
        newMemory: {
          content, title, memoryType, kind: resolvedKind,
          importance, projectId, source,
          embedding: vector, sourceEventId, metadata
        }
      });
      return {
        saved: true,
        memoryId: result.newId,
        supersededId: result.oldId,
        memoryType,
        embedded: !!vector
      };
    }
    const id = this.db.saveMemory({
      scope, ownerId, chatId, content, title, memoryType,
      kind: resolvedKind, importance, projectId, source,
      embedding: vector, sourceEventId, metadata
    });
    return { saved: true, memoryId: id, memoryType, embedded: !!vector };
  }

  async update({
    id, scope, ownerId = null, chatId = null,
    title, content, memoryType, importance, projectId, status
  }) {
    if (projectId) {
      const project = this.db.getProject(
        projectId,
        scope,
        scope === 'personal' ? ownerId : null,
        scope === 'group' ? chatId : null
      );
      if (!project) throw new Error('Project tidak ditemukan pada workspace ini.');
    }

    const fields = {};
    if (title !== undefined) fields.title = title;
    if (content !== undefined) fields.content = content;
    if (memoryType !== undefined) {
      fields.memory_type = memoryType;
      fields.kind = memoryType;
    }
    if (importance !== undefined) fields.importance = importance;
    if (projectId !== undefined) fields.project_id = projectId;
    if (status !== undefined) fields.status = status;

    if (title !== undefined || content !== undefined) {
      const hasGetMemory = typeof this.db.getMemory === 'function';
      const existing = hasGetMemory ? this.db.getMemory({ id, scope, ownerId, chatId }) : null;
      if (hasGetMemory && !existing) return null;
      const nextTitle = title !== undefined ? title : (existing?.title ?? '');
      const nextContent = content !== undefined ? content : (existing?.content ?? '');
      const vector = await this.embed(`${nextTitle || ''}\n${nextContent || ''}`);
      fields.embedding_json = vector ? JSON.stringify(vector) : null;
    }

    return this.db.updateMemory({ id, scope, ownerId, chatId, fields });
  }

  async forget({ id, scope, ownerId = null, chatId = null, hard = false }) {
    return this.db.deleteMemory({ id, scope, ownerId, chatId, hard });
  }

  async backfillEmbeddings({ scope = null, ownerId = null, chatId = null, limit = 10 } = {}) {
    if (Date.now() < this.embeddingCooldownUntil) return { attempted: 0, backfilled: 0 };
    const rows = this.db.listUnembeddedMemories({ scope, ownerId, chatId, limit });
    let backfilled = 0;
    for (const row of rows) {
      if (Date.now() < this.embeddingCooldownUntil) break;
      const vector = await this.embed(`${row.title || ''}\n${row.content}`);
      if (vector) {
        this.db.setMemoryEmbedding(row.id, vector);
        backfilled++;
      }
    }
    return { attempted: rows.length, backfilled };
  }

  async consolidateWorkspace({ scope, ownerId = null, chatId = null, backfillLimit = 10 } = {}) {
    const consolidated = this.db.consolidateWorkspaceMemories({ scope, ownerId, chatId });
    const safeLimit = Number(backfillLimit) || 0;
    const backfill = safeLimit > 0
      ? await this.backfillEmbeddings({ scope, ownerId, chatId, limit: safeLimit })
      : { attempted: 0, backfilled: 0 };
    return {
      deduplicatedCount: consolidated.deduplicatedCount,
      archivedStaleCount: consolidated.archivedStaleCount,
      backfilledCount: backfill.backfilled
    };
  }

  async retrieve({ scope, ownerId = null, chatId = null, query, projectId = null, limit = 8 }) {
    const vector = await this.embed(query);
    return this.db.searchMemoriesSemantic({
      scope, ownerId, chatId, query, queryEmbedding: vector, projectId, limit
    });
  }

  async captureFromTurn({ scope, ownerId = null, chatId = null, userText, assistantText, sourceEventId }) {
    if (!sourceEventId || !DURABLE_SIGNAL.test(userText) || this.db.hasMemoryExtraction(sourceEventId)) {
      return { captured: 0, skipped: true };
    }

    const started = Date.now();
    let selected = null;
    try {
      let existingRows = this.db.searchMemories?.({ scope, ownerId, chatId, query: userText, limit: 8 }) || [];
      if (!existingRows.length && typeof this.db.listMemories === 'function') {
        existingRows = this.db.listMemories({ scope, ownerId, chatId, status: 'active', limit: 8 }) || [];
      }
      const existingBrief = existingRows.slice(0, 8).map((m) => ({
        id: m.id,
        title: m.title || null,
        content: String(m.content || '').slice(0, 200),
        memoryType: m.memory_type || m.kind || 'fact'
      }));

      selected = this.router.select('simple_question');
      const controller = new AbortController();
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Memory extraction timed out'));
        }, 25000);
        timer.unref?.();
      });
      let response;
      try {
        response = await Promise.race([
          this.provider.chat({
            model: selected.model,
            maxTokens: 2048,
            signal: controller.signal,
            messages: [
              {
                role: 'system',
                content: `Extract only durable information that the user explicitly states or clearly asks Bubu to remember. Do not infer sensitive personal attributes, passwords, secrets, or temporary details. ${scope === 'group' ? 'This is a shared group workspace: store only group decisions, shared project facts and group-relevant context. Never store an individual member personal preference, private detail or profile.' : 'This is the owner personal workspace: durable facts, preferences, goals and project context may be stored when explicitly stated or useful.'} When a new fact updates or replaces one of the existing workspace memories provided, include "supersedesId": <existing_id> on that memory object; otherwise omit "supersedesId". Return ONLY valid JSON: {"memories":[{"title":"short title","content":"standalone fact","memoryType":"fact|preference|project|goal","importance":1,"supersedesId":123}]}. If nothing durable, return {"memories":[]}.`
              },
              {
                role: 'user',
                content: `User message:\n${String(userText).slice(0, 4000)}\nAssistant response:\n${String(assistantText || '').slice(0, 2000)}${existingBrief.length ? `\nExisting workspace memories:\n${JSON.stringify(existingBrief).slice(0, 2000)}` : ''}`
              }
            ]
          }),
          timeoutPromise
        ]);
      } finally {
        clearTimeout(timer);
      }

      this.db.logModelUsage?.({
        taskId: null,
        modelId: response?.model || selected.model,
        tier: selected.tier || 'fast',
        usage: response?.usage || null,
        latencyMs: Date.now() - started,
        outcome: 'success'
      });

      const raw = String(response.message.content || '').trim();
      const parsed = extractJsonObject(raw);
      if (!parsed) throw new Error('Memory extractor did not return JSON');
      const items = Array.isArray(parsed.memories) ? parsed.memories.slice(0, 5) : [];
      let captured = 0;
      for (const item of items) {
        if (!item?.content || typeof item.content !== 'string') continue;
        let supersedeId = null;
        const rawSupersedes = item.supersedesId;
        const candidateId = typeof rawSupersedes === 'number'
          ? rawSupersedes
          : (typeof rawSupersedes === 'string' && /^\d+$/.test(rawSupersedes.trim()) ? Number(rawSupersedes.trim()) : NaN);
        if (Number.isInteger(candidateId) && candidateId > 0 && typeof this.db.getMemory === 'function') {
          const existing = this.db.getMemory({ id: candidateId, scope, ownerId, chatId });
          if (existing) supersedeId = candidateId;
        }
        await this.remember({
          scope, ownerId, chatId,
          title: String(item.title || '').slice(0, 160) || null,
          content: item.content.slice(0, 1200),
          memoryType: ['fact', 'preference', 'project', 'goal'].includes(item.memoryType) ? item.memoryType : 'fact',
          importance: Math.max(1, Math.min(5, Number(item.importance) || 3)),
          source: 'automatic_extraction',
          sourceEventId: `${sourceEventId}:${captured}`,
          supersedeId
        });
        captured++;
      }
      this.db.recordMemoryExtraction({ sourceEventId, status: 'completed', extractedCount: captured });
      return { captured, skipped: false };
    } catch (error) {
      if (selected) {
        this.db.logModelUsage?.({
          taskId: null,
          modelId: selected.model,
          tier: selected.tier || 'fast',
          usage: null,
          latencyMs: Date.now() - started,
          outcome: 'error'
        });
      }
      this.db.recordMemoryExtraction({ sourceEventId, status: 'failed', error: error.message });
      this.logger?.warn({ error: error.message, sourceEventId }, 'Automatic memory extraction failed');
      return { captured: 0, error: error.message };
    }
  }

  async createProject({ scope, ownerId = null, chatId = null, name, description = '' }) {
    const id = crypto.randomUUID();
    const project = this.db.createProject({ id, scope, ownerId, chatId, name, description });
    await this.remember({
      scope, ownerId, chatId,
      title: `Project: ${name}`,
      content: `Active project: ${name}. ${description}`.trim(),
      memoryType: 'project', importance: 5, projectId: id,
      source: 'project_creation'
    });
    return project;
  }

  async projectContext({ scope, ownerId = null, chatId = null, query = '', limit = 5 }) {
    const projects = this.db.listProjects({
      scope, ownerId, chatId, status: 'active', limit: 20
    });
    const terms = String(query).toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((x) => x.length >= 2);
    return projects.map((project) => ({
      ...project,
      relevance: terms.filter((term) =>
        `${project.name} ${project.description || ''}`.toLowerCase().includes(term)
      ).length
    })).sort((a, b) => b.relevance - a.relevance).slice(0, limit);
  }
}

module.exports = { MemoryService, DURABLE_SIGNAL, extractJsonObject };
