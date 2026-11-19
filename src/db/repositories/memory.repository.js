const crypto = require('node:crypto');
const { cosineSimilarity } = require('../../utils/vector');

const memoryRepository = {
  saveMemory({
    scope, ownerId = null, chatId = null, kind = 'note',
    memoryType = 'fact', title = null, content,
    source = 'conversation', embedding = null,
    importance = 3, projectId = null, metadata = {},
    sourceEventId = null
  }) {
    const now = new Date().toISOString();
    const normalizedOwner = scope === 'personal' ? ownerId : null;
    const normalizedChat = scope === 'group' ? chatId : null;

    if (sourceEventId) {
      const existing = this.db.prepare(`
        SELECT id FROM memories
        WHERE scope=?
          AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
          AND json_extract(metadata_json,'$.sourceEventId')=?
        LIMIT 1
      `).get(scope, normalizedOwner, normalizedChat, sourceEventId);
      if (existing) return existing.id;
    }

    const result = this.db.prepare(`
      INSERT INTO memories (
        scope,owner_id,chat_id,kind,content,source,created_at,
        memory_type,title,embedding_json,importance,project_id,
        metadata_json,last_accessed_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      scope, normalizedOwner, normalizedChat, kind, content, source, now,
      memoryType, title, embedding ? JSON.stringify(embedding) : null,
      Math.max(1, Math.min(5, Number(importance) || 3)),
      projectId, JSON.stringify({ ...metadata, ...(sourceEventId ? { sourceEventId } : {}) }),
      now, now
    );
    return Number(result.lastInsertRowid);
  },

  searchMemories({ scope, ownerId = null, chatId = null, query = '', limit = 8 }) {
    const rows = this.db.prepare(`SELECT id,kind,content,created_at FROM memories
      WHERE scope=? AND (
        (scope='personal' AND owner_id=?)
        OR
        (scope='group' AND chat_id=?)
      )
      ORDER BY id DESC LIMIT 300`).all(scope, ownerId, chatId);

    const terms = String(query || '')
      .toLowerCase()
      .split(/\W+/)
      .filter((term) => term.length > 2);

    const scored = rows.map((row) => ({
      ...row,
      score: terms.reduce(
        (total, term) => total + (String(row.content || '').toLowerCase().includes(term) ? 1 : 0),
        0
      )
    }));

    const relevant = terms.length > 0
      ? scored.filter((row) => row.score > 0)
      : scored;

    return relevant
      .sort((a, b) => b.score - a.score || b.id - a.id)
      .slice(0, Math.max(1, Math.min(Number(limit) || 8, 50)));
  },

  searchMemoriesSemantic({
    scope, ownerId = null, chatId = null, query = '',
    queryEmbedding = null, projectId = null, limit = 8
  }) {
    const rows = this.db.prepare(`
      SELECT id,kind,memory_type,title,content,importance,project_id,
             embedding_json,created_at,last_accessed_at
      FROM memories
      WHERE scope=?
        AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
        AND (? IS NULL OR project_id=?)
      ORDER BY importance DESC,id DESC
      LIMIT 500
    `).all(scope, ownerId, chatId, projectId, projectId);

    const terms = String(query || '').toLowerCase().split(/\W+/).filter((term) => term.length > 2);
    const scored = rows.map((row) => {
      const haystack = `${row.title || ''} ${row.content || ''}`.toLowerCase();
      const lexical = terms.length
        ? terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0) / terms.length
        : 0;
      let semantic = 0;
      if (queryEmbedding && row.embedding_json) {
        try { semantic = cosineSimilarity(queryEmbedding, JSON.parse(row.embedding_json)); } catch {}
      }
      const recency = Math.max(0, 1 - ((Date.now() - Date.parse(row.created_at)) / (180 * 86400000)));
      const importance = Math.max(1, Math.min(5, row.importance || 3)) / 5;
      const score = queryEmbedding
        ? semantic * 0.72 + lexical * 0.18 + importance * 0.07 + recency * 0.03
        : lexical * 0.75 + importance * 0.18 + recency * 0.07;
      return { ...row, score, semanticScore: semantic, lexicalScore: lexical };
    });

    const relevant = scored
      .filter((row) => queryEmbedding
        ? row.semanticScore >= 0.25 || row.lexicalScore > 0
        : terms.length === 0 || row.lexicalScore > 0)
      .sort((a, b) => b.score - a.score || b.id - a.id)
      .slice(0, Math.max(1, Math.min(limit, 30)));

    const ids = relevant.map((row) => row.id);
    if (ids.length) {
      const update = this.db.prepare('UPDATE memories SET last_accessed_at=?,updated_at=? WHERE id=?');
      const now = new Date().toISOString();
      this.db.transaction(() => ids.forEach((id) => update.run(now, now, id)))();
    }
    return relevant.map(({ embedding_json, ...row }) => row);
  },

  createProject(project) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO projects (
        id,scope,owner_id,chat_id,name,description,status,metadata_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(
      project.id, project.scope,
      project.scope === 'personal' ? project.ownerId : null,
      project.scope === 'group' ? project.chatId : null,
      project.name, project.description || null, project.status || 'active',
      JSON.stringify(project.metadata || {}), now, now
    );
    return this.getProject(project.id, project.scope, project.ownerId || null, project.chatId || null);
  },

  getProject(id, scope, ownerId = null, chatId = null) {
    return this.db.prepare(`
      SELECT * FROM projects WHERE id=? AND scope=?
        AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
    `).get(id, scope, ownerId, chatId) || null;
  },

  listProjects({ scope, ownerId = null, chatId = null, status = 'active', limit = 20 }) {
    return this.db.prepare(`
      SELECT id,name,description,status,created_at,updated_at
      FROM projects WHERE scope=?
        AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
        AND (? IS NULL OR status=?)
      ORDER BY updated_at DESC LIMIT ?
    `).all(scope, ownerId, chatId, status, status, Math.max(1, Math.min(limit, 50)));
  },

  updateProject({ id, scope, ownerId = null, chatId = null, fields }) {
    const allowed = ['name', 'description', 'status', 'metadata_json'];
    const keys = Object.keys(fields).filter((key) => allowed.includes(key));
    if (!keys.length) return this.getProject(id, scope, ownerId, chatId);
    const assignments = keys.map((key) => `${key}=@${key}`).join(',');
    const result = this.db.prepare(`
      UPDATE projects SET ${assignments},updated_at=@updated_at
      WHERE id=@id AND scope=@scope
        AND ((scope='personal' AND owner_id=@ownerId) OR (scope='group' AND chat_id=@chatId))
    `).run({ ...fields, id, scope, ownerId, chatId, updated_at: new Date().toISOString() });
    return result.changes ? this.getProject(id, scope, ownerId, chatId) : null;
  },

  saveMemoryEvent({
    scope,
    ownerId = null,
    chatId = null,
    eventType,
    summary,
    sourceEventId = null
  }) {
    const normalizedOwner = scope === 'personal' ? ownerId : null;
    const normalizedChat = scope === 'group' ? chatId : null;

    if (sourceEventId) {
      const existing = this.db.prepare(`
        SELECT id FROM memory_events
        WHERE scope=? AND owner_id IS ? AND chat_id IS ? AND source_event_id=?
        LIMIT 1
      `).get(scope, normalizedOwner, normalizedChat, sourceEventId);
      if (existing) return existing.id;
    }

    const id = crypto.randomUUID();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO memory_events(
        id,scope,owner_id,chat_id,event_type,summary,source_event_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?)
    `).run(
      id, scope, normalizedOwner, normalizedChat, eventType, summary,
      sourceEventId, new Date().toISOString()
    );

    if (result.changes) return id;

    if (sourceEventId) {
      const existing = this.db.prepare(`
        SELECT id FROM memory_events
        WHERE scope=? AND owner_id IS ? AND chat_id IS ? AND source_event_id=?
        LIMIT 1
      `).get(scope, normalizedOwner, normalizedChat, sourceEventId);
      if (existing) return existing.id;
    }

    throw new Error('Failed to save memory event');
  },

  hasMemoryExtraction(sourceEventId) {
    return !!this.db.prepare('SELECT 1 FROM memory_extraction_runs WHERE source_event_id=?').get(sourceEventId);
  },

  recordMemoryExtraction({ sourceEventId, status, extractedCount = 0, error = null }) {
    this.db.prepare(`
      INSERT OR REPLACE INTO memory_extraction_runs(source_event_id,status,extracted_count,error,created_at)
      VALUES(?,?,?,?,?)
    `).run(sourceEventId, status, extractedCount, error, new Date().toISOString());
  },

  listMemoryEvents({ scope, ownerId = null, chatId = null, limit = 20 }) {
    return this.db.prepare(`
      SELECT id,event_type,summary,created_at FROM memory_events
      WHERE scope=? AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
      ORDER BY created_at DESC LIMIT ?
    `).all(scope, ownerId, chatId, Math.max(1, Math.min(limit, 50)));
  }
};

module.exports = { memoryRepository };
