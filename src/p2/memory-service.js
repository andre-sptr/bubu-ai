const crypto = require('node:crypto');

const DURABLE_SIGNAL = /\b(ingat|remember|catat|simpan|preferensi|saya suka|saya tidak suka|mulai sekarang|ke depannya|proyek|sedang mengerjakan|rencana saya|tujuan saya|jangan lupa)\b/i;

class MemoryService {
  constructor({ db, provider, router, logger, embeddingModel = 'gemini/gemini-embedding-001' }) {
    Object.assign(this, { db, provider, router, logger, embeddingModel });
    this.embeddingCooldownUntil = 0;
  }

  async embed(text) {
    if (Date.now() < this.embeddingCooldownUntil) return null;
    try {
      const vector = await this.provider.embed({
        input: String(text).slice(0, 8000),
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
    }
  }

  async remember({
    scope, ownerId = null, chatId = null, content,
    title = null, memoryType = 'fact', importance = 3,
    projectId = null, source = 'conversation', sourceEventId = null,
    metadata = {}
  }) {
    if (projectId) {
      const project = this.db.getProject(projectId, scope,
        scope === 'personal' ? ownerId : null,
        scope === 'group' ? chatId : null);
      if (!project) throw new Error('Project tidak ditemukan pada workspace ini.');
    }
    const vector = await this.embed(`${title || ''}\n${content}`);
    const id = this.db.saveMemory({
      scope, ownerId, chatId, content, title, memoryType,
      kind: memoryType, importance, projectId, source,
      embedding: vector, sourceEventId, metadata
    });
    return { saved: true, memoryId: id, memoryType, embedded: !!vector };
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

    try {
      const selected = this.router.select('simple_question');
      const response = await this.provider.chat({
        model: selected.model,
        maxTokens: 1000,
        messages: [
          {
            role: 'system',
            content: `Extract only durable information that the user explicitly states or clearly asks Bubu to remember. Do not infer sensitive personal attributes, passwords, secrets, or temporary details. ${scope === 'group' ? 'This is a shared group workspace: store only group decisions, shared project facts and group-relevant context. Never store an individual member personal preference, private detail or profile.' : 'This is the owner personal workspace: durable facts, preferences, goals and project context may be stored when explicitly stated or useful.'} Return ONLY valid JSON: {"memories":[{"title":"short title","content":"standalone fact","memoryType":"fact|preference|project|goal","importance":1}]}. If nothing durable, return {"memories":[]}.`
          },
          {
            role: 'user',
            content: `User message:\n${String(userText).slice(0,4000)}\nAssistant response:\n${String(assistantText || '').slice(0,2000)}`
          }
        ]
      });
      const raw = String(response.message.content || '').trim();
      const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
      if (!jsonText) throw new Error('Memory extractor did not return JSON');
      const parsed = JSON.parse(jsonText);
      const items = Array.isArray(parsed.memories) ? parsed.memories.slice(0, 5) : [];
      let captured = 0;
      for (const item of items) {
        if (!item?.content || typeof item.content !== 'string') continue;
        await this.remember({
          scope, ownerId, chatId,
          title: String(item.title || '').slice(0,160) || null,
          content: item.content.slice(0,1200),
          memoryType: ['fact','preference','project','goal'].includes(item.memoryType) ? item.memoryType : 'fact',
          importance: Math.max(1,Math.min(5,Number(item.importance) || 3)),
          source: 'automatic_extraction',
          sourceEventId: `${sourceEventId}:${captured}`
        });
        captured++;
      }
      this.db.recordMemoryExtraction({ sourceEventId, status: 'completed', extractedCount: captured });
      return { captured, skipped: false };
    } catch (error) {
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
    const terms = String(query).toLowerCase().split(/\W+/).filter(x => x.length > 2);
    return projects.map(project => ({
      ...project,
      relevance: terms.filter(term =>
        `${project.name} ${project.description || ''}`.toLowerCase().includes(term)
      ).length
    })).sort((a,b) => b.relevance-a.relevance).slice(0,limit);
  }
}

module.exports = { MemoryService, DURABLE_SIGNAL };
