const crypto = require('node:crypto');
const { cosineSimilarity } = require('../../utils/vector');

function normalizeWorkspace(scope, ownerId = null, chatId = null) {
  return {
    normalizedOwner: scope === 'personal' ? ownerId : null,
    normalizedChat: scope === 'group' ? chatId : null
  };
}

function parseValidMemoryId(id) {
  if (id === null || id === undefined || id === '') return null;
  const numeric = Number(id);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function sanitizeMemoryRow(row) {
  if (!row) return null;
  const { embedding_json, ...rest } = row;
  return { ...rest, embedded: Boolean(embedding_json) };
}

const MEMORY_SELECT_COLUMNS = `
  id,scope,owner_id,chat_id,kind,memory_type,title,content,source,
  importance,project_id,status,superseded_by,metadata_json,
  embedding_json,created_at,last_accessed_at,updated_at
`;

const memoryRepository = {
  saveMemory({
    scope, ownerId = null, chatId = null, kind = 'note',
    memoryType = 'fact', title = null, content,
    source = 'conversation', embedding = null,
    importance = 3, projectId = null, metadata = {},
    sourceEventId = null
  }) {
    const now = new Date().toISOString();
    const { normalizedOwner, normalizedChat } = normalizeWorkspace(scope, ownerId, chatId);
    const normalizedImportance = Math.max(1, Math.min(5, Number(importance) || 3));
    const normalizedTitle = title ?? null;
    const embeddingJson = embedding ? JSON.stringify(embedding) : null;

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

    const duplicate = this.db.prepare(`
      SELECT id FROM memories
      WHERE scope=?
        AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
        AND COALESCE(status, 'active') = 'active'
        AND LOWER(TRIM(content)) = LOWER(TRIM(?))
        AND COALESCE(LOWER(TRIM(title)), '') = COALESCE(LOWER(TRIM(?)), '')
      ORDER BY importance DESC, id ASC
      LIMIT 1
    `).get(scope, normalizedOwner, normalizedChat, content, normalizedTitle);

    if (duplicate) {
      this.db.prepare(`
        UPDATE memories
        SET importance = MAX(importance, ?),
            last_accessed_at = ?,
            updated_at = ?,
            embedding_json = COALESCE(?, embedding_json)
        WHERE id = ?
      `).run(normalizedImportance, now, now, embeddingJson, duplicate.id);
      return Number(duplicate.id);
    }

    const result = this.db.prepare(`
      INSERT INTO memories (
        scope,owner_id,chat_id,kind,content,source,created_at,
        memory_type,title,embedding_json,importance,project_id,
        metadata_json,last_accessed_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      scope, normalizedOwner, normalizedChat, kind, content, source, now,
      memoryType, normalizedTitle, embeddingJson,
      normalizedImportance,
      projectId, JSON.stringify({ ...metadata, ...(sourceEventId ? { sourceEventId } : {}) }),
      now, now
    );
    return Number(result.lastInsertRowid);
  },

  searchMemories({ scope, ownerId = null, chatId = null, query = '', limit = 8, includeArchived = false }) {
    const { normalizedOwner, normalizedChat } = normalizeWorkspace(scope, ownerId, chatId);
    const statusFilter = includeArchived ? '' : "AND COALESCE(status, 'active') = 'active'";
    const rows = this.db.prepare(`SELECT id,kind,content,created_at FROM memories
      WHERE scope=? AND (
        (scope='personal' AND owner_id=?)
        OR
        (scope='group' AND chat_id=?)
      )
      ${statusFilter}
      ORDER BY id DESC LIMIT 300`).all(scope, normalizedOwner, normalizedChat);

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
    queryEmbedding = null, projectId = null, limit = 8,
    includeArchived = false
  }) {
    const { normalizedOwner, normalizedChat } = normalizeWorkspace(scope, ownerId, chatId);
    const statusFilter = includeArchived ? '' : "AND COALESCE(status, 'active') = 'active'";
    const rows = this.db.prepare(`
      SELECT id,kind,memory_type,title,content,importance,project_id,
             status,embedding_json,created_at,last_accessed_at,updated_at
      FROM memories
      WHERE scope=?
        AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
        AND (? IS NULL OR project_id=?)
        ${statusFilter}
      ORDER BY importance DESC,id DESC
      LIMIT 500
    `).all(scope, normalizedOwner, normalizedChat, projectId, projectId);

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
      const update = this.db.prepare('UPDATE memories SET last_accessed_at=? WHERE id=?');
      const now = new Date().toISOString();
      this.db.transaction(() => ids.forEach((id) => update.run(now, id)))();
    }
    return relevant.map(({ embedding_json, ...row }) => row);
  },

  getMemory({ id, scope, ownerId = null, chatId = null }) {
    const numericId = parseValidMemoryId(id);
    if (!numericId) return null;
    const { normalizedOwner, normalizedChat } = normalizeWorkspace(scope, ownerId, chatId);
    const row = this.db.prepare(`
      SELECT ${MEMORY_SELECT_COLUMNS}
      FROM memories
      WHERE id=? AND scope=?
        AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
    `).get(numericId, scope, normalizedOwner, normalizedChat);
    return sanitizeMemoryRow(row);
  },

  listMemories({ scope, ownerId = null, chatId = null, memoryType = null, projectId = null, status = 'active', limit = 20 }) {
    const { normalizedOwner, normalizedChat } = normalizeWorkspace(scope, ownerId, chatId);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
    const rows = this.db.prepare(`
      SELECT ${MEMORY_SELECT_COLUMNS}
      FROM memories
      WHERE scope=?
        AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
        AND (? IS NULL OR memory_type=?)
        AND (? IS NULL OR project_id=?)
        AND (? IS NULL OR COALESCE(status, 'active')=?)
      ORDER BY importance DESC, updated_at DESC, id DESC
      LIMIT ?
    `).all(
      scope, normalizedOwner, normalizedChat,
      memoryType, memoryType,
      projectId, projectId,
      status, status,
      safeLimit
    );
    return rows.map(sanitizeMemoryRow);
  },

  updateMemory({ id, scope, ownerId = null, chatId = null, fields = {} }) {
    const numericId = parseValidMemoryId(id);
    if (!numericId) return null;
    const { normalizedOwner, normalizedChat } = normalizeWorkspace(scope, ownerId, chatId);
    const allowed = [
      'title', 'content', 'memory_type', 'kind', 'importance',
      'project_id', 'status', 'superseded_by', 'embedding_json', 'metadata_json'
    ];
    const keys = Object.keys(fields).filter((key) => allowed.includes(key) && fields[key] !== undefined);
    if (!keys.length) return this.getMemory({ id: numericId, scope, ownerId, chatId });

    const params = {
      id: numericId,
      scope,
      ownerId: normalizedOwner,
      chatId: normalizedChat,
      updated_at: new Date().toISOString()
    };
    for (const key of keys) {
      let value = fields[key];
      if (key === 'importance') {
        value = Math.max(1, Math.min(5, Number(value) || 3));
      } else if ((key === 'embedding_json' || key === 'metadata_json') && value !== null && typeof value !== 'string') {
        value = JSON.stringify(value);
      }
      params[key] = value;
    }

    const assignments = keys.map((key) => `${key}=@${key}`).join(',');
    const result = this.db.prepare(`
      UPDATE memories
      SET ${assignments}, updated_at=@updated_at
      WHERE id=@id AND scope=@scope
        AND ((scope='personal' AND owner_id=@ownerId) OR (scope='group' AND chat_id=@chatId))
    `).run(params);

    return result.changes ? this.getMemory({ id: numericId, scope, ownerId, chatId }) : null;
  },

  supersedeMemory({ oldId, scope, ownerId = null, chatId = null, newMemory }) {
    const targetOldId = parseValidMemoryId(oldId);
    const { normalizedOwner, normalizedChat } = normalizeWorkspace(scope, ownerId, chatId);
    return this.db.transaction(() => {
      if (!targetOldId) {
        throw new Error('Memori yang akan digantikan tidak ditemukan pada workspace ini.');
      }
      const existingOld = this.getMemory({ id: targetOldId, scope, ownerId, chatId });
      if (!existingOld) {
        throw new Error('Memori yang akan digantikan tidak ditemukan pada workspace ini.');
      }
      const newId = this.saveMemory({
        ...newMemory,
        scope,
        ownerId,
        chatId
      });
      if (newId !== targetOldId) {
        const now = new Date().toISOString();
        this.db.prepare(`
          UPDATE memories
          SET status='superseded', superseded_by=?, updated_at=?
          WHERE id=? AND scope=?
            AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
        `).run(newId, now, targetOldId, scope, normalizedOwner, normalizedChat);
      }
      return {
        superseded: true,
        oldId: Number(oldId),
        newId,
        memory: this.getMemory({ id: newId, scope, ownerId, chatId })
      };
    })();
  },

  deleteMemory({ id, scope, ownerId = null, chatId = null, hard = false }) {
    const mode = hard ? 'hard' : 'archived';
    const numericId = parseValidMemoryId(id);
    if (!numericId) return { deleted: false, id: Number(id), mode };
    const { normalizedOwner, normalizedChat } = normalizeWorkspace(scope, ownerId, chatId);

    const result = hard
      ? this.db.prepare(`
          DELETE FROM memories
          WHERE id=? AND scope=?
            AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
        `).run(numericId, scope, normalizedOwner, normalizedChat)
      : this.db.prepare(`
          UPDATE memories
          SET status='archived', updated_at=?
          WHERE id=? AND scope=?
            AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
        `).run(new Date().toISOString(), numericId, scope, normalizedOwner, normalizedChat);

    return { deleted: result.changes > 0, id: Number(id), mode };
  },

  listUnembeddedMemories({ scope = null, ownerId = null, chatId = null, limit = 20 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
    if (scope) {
      const { normalizedOwner, normalizedChat } = normalizeWorkspace(scope, ownerId, chatId);
      return this.db.prepare(`
        SELECT id, scope, owner_id, chat_id, title, content, memory_type
        FROM memories
        WHERE COALESCE(status, 'active') = 'active'
          AND embedding_json IS NULL
          AND scope = ?
          AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
        ORDER BY importance DESC, id DESC
        LIMIT ?
      `).all(scope, normalizedOwner, normalizedChat, safeLimit);
    }
    return this.db.prepare(`
      SELECT id, scope, owner_id, chat_id, title, content, memory_type
      FROM memories
      WHERE COALESCE(status, 'active') = 'active'
        AND embedding_json IS NULL
      ORDER BY importance DESC, id DESC
      LIMIT ?
    `).all(safeLimit);
  },

  setMemoryEmbedding(id, embedding) {
    const numericId = parseValidMemoryId(id);
    if (!numericId) return false;
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE memories SET embedding_json=?, updated_at=? WHERE id=?
    `).run(embedding ? JSON.stringify(embedding) : null, now, numericId);
    return result.changes > 0;
  },

  consolidateWorkspaceMemories({ scope, ownerId = null, chatId = null, staleDays = 180, maxActive = 500 } = {}) {
    const { normalizedOwner, normalizedChat } = normalizeWorkspace(scope, ownerId, chatId);
    const now = new Date().toISOString();
    const safeStaleDays = Number.isFinite(Number(staleDays)) ? Math.max(0, Number(staleDays)) : 180;
    const cutoffMs = Date.now() - safeStaleDays * 86400000;
    void maxActive;

    return this.db.transaction(() => {
      const activeRows = this.db.prepare(`
        SELECT id, content, importance, created_at, last_accessed_at
        FROM memories
        WHERE scope=?
          AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
          AND COALESCE(status, 'active') = 'active'
        ORDER BY importance DESC, id ASC
      `).all(scope, normalizedOwner, normalizedChat);

      const seen = new Set();
      const duplicateIds = [];
      for (const row of activeRows) {
        const key = String(row.content || '').trim().toLowerCase();
        if (seen.has(key)) {
          duplicateIds.push(row.id);
        } else {
          seen.add(key);
        }
      }

      const archiveStmt = this.db.prepare("UPDATE memories SET status='archived', updated_at=? WHERE id=?");
      for (const dupId of duplicateIds) {
        archiveStmt.run(now, dupId);
      }

      const duplicateSet = new Set(duplicateIds);
      let archivedStaleCount = 0;
      for (const row of activeRows) {
        if (duplicateSet.has(row.id)) continue;
        if ((Number(row.importance) || 0) <= 1) {
          const touchedMs = Date.parse(row.last_accessed_at || row.created_at);
          if (Number.isFinite(touchedMs) && touchedMs < cutoffMs) {
            archiveStmt.run(now, row.id);
            archivedStaleCount++;
          }
        }
      }

      return {
        deduplicatedCount: duplicateIds.length,
        archivedStaleCount
      };
    })();
  },

  getMemoryStats({ scope, ownerId = null, chatId = null }) {
    const { normalizedOwner, normalizedChat } = normalizeWorkspace(scope, ownerId, chatId);
    const mem = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN COALESCE(status, 'active') = 'active' THEN 1 ELSE 0 END), 0) AS activeCount,
        COALESCE(SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END), 0) AS supersededCount,
        COALESCE(SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END), 0) AS archivedCount,
        COALESCE(SUM(CASE WHEN COALESCE(status, 'active') = 'active' AND embedding_json IS NULL THEN 1 ELSE 0 END), 0) AS unembeddedCount
      FROM memories
      WHERE scope=?
        AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
    `).get(scope, normalizedOwner, normalizedChat);

    const proj = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM projects
      WHERE scope=?
        AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
    `).get(scope, normalizedOwner, normalizedChat);

    const evt = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_events
      WHERE scope=?
        AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
    `).get(scope, normalizedOwner, normalizedChat);

    return {
      activeCount: Number(mem?.activeCount || 0),
      supersededCount: Number(mem?.supersededCount || 0),
      archivedCount: Number(mem?.archivedCount || 0),
      unembeddedCount: Number(mem?.unembeddedCount || 0),
      projectCount: Number(proj?.count || 0),
      eventCount: Number(evt?.count || 0)
    };
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
