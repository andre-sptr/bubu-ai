const fs = require('node:fs');
const path = require('node:path');
const { searchDocumentSnippets } = require('../p1/documents/service');

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS inbox_events (
        event_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','processing','completed','failed','dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        locked_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_ready ON inbox_events(status, available_at);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('personal','group')),
        role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
        sender_id TEXT,
        content TEXT NOT NULL,
        event_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_event_role ON messages(event_id,role) WHERE event_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id,id);
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL CHECK(scope IN ('personal','group')),
        owner_id TEXT,
        chat_id TEXT,
        kind TEXT NOT NULL DEFAULT 'note',
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'conversation',
        created_at TEXT NOT NULL,
        CHECK((scope='personal' AND owner_id IS NOT NULL AND chat_id IS NULL)
           OR (scope='group' AND chat_id IS NOT NULL AND owner_id IS NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories(scope,owner_id,chat_id,id);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        source_event_id TEXT UNIQUE,
        chat_id TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        request_text TEXT NOT NULL,
        result_text TEXT,
        response_status TEXT NOT NULL DEFAULT 'none',
        response_text TEXT,
        response_updated_at TEXT,
        model_tier TEXT,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        step_no INTEGER NOT NULL,
        tool_name TEXT,
        input_json TEXT,
        output_json TEXT,
        status TEXT NOT NULL,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        chat_id TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','executing','approved','denied','failed','expired','uncertain')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        execution_error TEXT
      );
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_event_id TEXT UNIQUE,
        chat_id TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        message TEXT NOT NULL,
        due_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        delivery_uncertain INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status,due_at);
      CREATE TABLE IF NOT EXISTS model_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        model_id TEXT NOT NULL,
        tier TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        latency_ms INTEGER,
        outcome TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT,
        actor_id TEXT,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rate_limit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rate_key TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rate_limit_key_time ON rate_limit_events(rate_key,created_at_ms);
    `
  },
  {
    version: 2,
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_event_role ON messages(event_id,role) WHERE event_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_event ON tasks(source_event_id) WHERE source_event_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_step_unique ON task_steps(task_id,step_no);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_source_event ON reminders(source_event_id) WHERE source_event_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS tool_executions (
        idempotency_key TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('executing','completed','uncertain','failed')),
        output_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tool_executions_task ON tool_executions(task_id);
      CREATE TABLE IF NOT EXISTS rate_limit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rate_key TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rate_limit_key_time ON rate_limit_events(rate_key,created_at_ms);
    `
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('personal','group')),
        owner_id TEXT,
        chat_id TEXT,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        extracted_text TEXT NOT NULL,
        source_event_id TEXT,
        created_at TEXT NOT NULL,
        CHECK((scope='personal' AND owner_id IS NOT NULL AND chat_id IS NULL)
           OR (scope='group' AND chat_id IS NOT NULL AND owner_id IS NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_documents_scope ON documents(scope,owner_id,chat_id,created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_event ON documents(source_event_id) WHERE source_event_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS user_tasks (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('personal','group')),
        owner_id TEXT,
        chat_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','blocked','completed','cancelled')),
        priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
        due_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK((scope='personal' AND owner_id IS NOT NULL AND chat_id IS NULL)
           OR (scope='group' AND chat_id IS NOT NULL AND owner_id IS NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_user_tasks_scope ON user_tasks(scope,owner_id,chat_id,status,due_at);
    `
  },
  {
    version: 4,
    sql: `
      CREATE TABLE reminders_rebuild (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_event_id TEXT UNIQUE,
        chat_id TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        message TEXT NOT NULL,
        due_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        delivery_uncertain INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO reminders_rebuild
        (id,source_event_id,chat_id,requester_id,message,due_at,status,attempts,delivery_uncertain,created_at,updated_at)
      SELECT id,source_event_id,chat_id,requester_id,message,due_at,status,attempts,delivery_uncertain,created_at,updated_at
      FROM reminders;
      DROP TABLE reminders;
      ALTER TABLE reminders_rebuild RENAME TO reminders;
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status,due_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_source_event ON reminders(source_event_id) WHERE source_event_id IS NOT NULL;
    `
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('personal','group')),
        owner_id TEXT, chat_id TEXT, name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active','paused','completed','archived')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CHECK((scope='personal' AND owner_id IS NOT NULL AND chat_id IS NULL)
          OR (scope='group' AND chat_id IS NOT NULL AND owner_id IS NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_projects_scope
        ON projects(scope,owner_id,chat_id,status,updated_at);
      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('personal','group')),
        owner_id TEXT, chat_id TEXT, event_type TEXT NOT NULL,
        summary TEXT NOT NULL, source_event_id TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_events_scope
        ON memory_events(scope,owner_id,chat_id,created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_events_source
        ON memory_events(source_event_id) WHERE source_event_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS memory_extraction_runs (
        source_event_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('completed','skipped','failed')),
        extracted_count INTEGER NOT NULL DEFAULT 0,
        error TEXT, created_at TEXT NOT NULL
      );
    `
  },
  {
    version: 6,
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_events_source
      ON memory_events(scope,owner_id,chat_id,source_event_id)
      WHERE source_event_id IS NOT NULL;
    `
  },
  {
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS chat_preferences (
        chat_id TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        voice_reply_enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(chat_id,requester_id)
      );
    `
  },
  {
    version: 8,
    sql: `
      ALTER TABLE chat_preferences
        ADD COLUMN voice_reply_mode TEXT NOT NULL DEFAULT 'text'
        CHECK(voice_reply_mode IN ('text','voice','both'));
      UPDATE chat_preferences
        SET voice_reply_mode = CASE
          WHEN voice_reply_enabled = 1 THEN 'both'
          ELSE 'text'
        END;
    `
  },
  {
    version: 9,
    sql: `
      ALTER TABLE chat_preferences
        ADD COLUMN voice_reply_mode_is_set INTEGER NOT NULL DEFAULT 0
        CHECK(voice_reply_mode_is_set IN (0,1));
      UPDATE chat_preferences SET voice_reply_mode_is_set = 1;
    `
  },
];

const { cosineSimilarity } = require('../p2/vector');

class DatabaseStore {
  constructor(databasePath) {
    const Database = require('better-sqlite3');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(this.db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      const tx = this.db.transaction(() => {
        if (migration.version === 2) {
          const columns = (table) => new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
          if (!columns('messages').has('event_id')) this.db.exec('ALTER TABLE messages ADD COLUMN event_id TEXT');
          if (!columns('tasks').has('source_event_id')) this.db.exec('ALTER TABLE tasks ADD COLUMN source_event_id TEXT');
          if (!columns('tasks').has('response_status')) this.db.exec("ALTER TABLE tasks ADD COLUMN response_status TEXT NOT NULL DEFAULT 'none'");
          if (!columns('tasks').has('response_text')) this.db.exec('ALTER TABLE tasks ADD COLUMN response_text TEXT');
          if (!columns('tasks').has('response_updated_at')) this.db.exec('ALTER TABLE tasks ADD COLUMN response_updated_at TEXT');
          if (!columns('reminders').has('delivery_uncertain')) this.db.exec('ALTER TABLE reminders ADD COLUMN delivery_uncertain INTEGER NOT NULL DEFAULT 0');
          if (!columns('reminders').has('source_event_id')) this.db.exec('ALTER TABLE reminders ADD COLUMN source_event_id TEXT');
        }
        if (migration.version === 5) {
          const columns = (table) => new Set(
            this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
          );
          const memoryColumns = columns('memories');
          if (!memoryColumns.has('memory_type')) this.db.exec("ALTER TABLE memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'fact'");
          if (!memoryColumns.has('title')) this.db.exec('ALTER TABLE memories ADD COLUMN title TEXT');
          if (!memoryColumns.has('embedding_json')) this.db.exec('ALTER TABLE memories ADD COLUMN embedding_json TEXT');
          if (!memoryColumns.has('importance')) this.db.exec('ALTER TABLE memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 3');
          if (!memoryColumns.has('project_id')) this.db.exec('ALTER TABLE memories ADD COLUMN project_id TEXT');
          if (!memoryColumns.has('metadata_json')) this.db.exec("ALTER TABLE memories ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
          if (!memoryColumns.has('last_accessed_at')) this.db.exec('ALTER TABLE memories ADD COLUMN last_accessed_at TEXT');
          if (!memoryColumns.has('updated_at')) this.db.exec('ALTER TABLE memories ADD COLUMN updated_at TEXT');
          this.db.exec("UPDATE memories SET updated_at=COALESCE(updated_at,created_at), last_accessed_at=COALESCE(last_accessed_at,created_at)");
          this.db.exec('CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id,created_at)');
        }

        this.db.exec(migration.sql);
        this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
          .run(migration.version, new Date().toISOString());
      });
      tx();
      applied.add(migration.version);
    }
  }

  enqueueEvent({ eventId, chatId, senderId, payload }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`INSERT OR IGNORE INTO inbox_events
      (event_id,chat_id,sender_id,payload_json,status,attempts,available_at,created_at,updated_at)
      VALUES(?,?,?,?,'pending',0,?,?,?)`)
      .run(eventId, chatId, senderId, JSON.stringify(payload), now, now, now);
    return result.changes === 1;
  }

  claimNextEvent() {
    const now = new Date().toISOString();
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM inbox_events
        WHERE status IN ('pending','failed') AND available_at<=?
        ORDER BY created_at LIMIT 1`).get(now);
      if (!row) return null;
      const update = this.db.prepare(`UPDATE inbox_events SET status='processing',
        attempts=attempts+1,locked_at=?,updated_at=?
        WHERE event_id=? AND status IN ('pending','failed')`).run(now, now, row.event_id);
      if (!update.changes) return null;
      return { ...row, status: 'processing', attempts: row.attempts + 1, payload: JSON.parse(row.payload_json) };
    });
    return claim();
  }

  finishEvent(eventId) {
    this.db.prepare(`UPDATE inbox_events SET status='completed',locked_at=NULL,updated_at=? WHERE event_id=?`)
      .run(new Date().toISOString(), eventId);
  }

  failEvent(eventId, error, attempts, maxAttempts = 5) {
    const dead = attempts >= maxAttempts;
    const delay = Math.min(300000, 1000 * (2 ** Math.max(0, attempts - 1)));
    this.db.prepare(`UPDATE inbox_events SET status=?,last_error=?,locked_at=NULL,
      available_at=?,updated_at=? WHERE event_id=?`).run(
      dead ? 'dead' : 'failed', String(error).slice(0,1000),
      new Date(Date.now() + delay).toISOString(), new Date().toISOString(), eventId
    );
  }

  recoverStaleEvents(staleMs = 120000) {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    return this.db.prepare(`UPDATE inbox_events SET status='failed',locked_at=NULL,
      available_at=?,last_error='Recovered stale processing event',updated_at=?
      WHERE status='processing' AND locked_at<?`)
      .run(new Date().toISOString(), new Date().toISOString(), cutoff).changes;
  }

  addMessage({ chatId, scope, role, senderId = null, content, eventId = null }) {
    const result = this.db.prepare(`INSERT OR IGNORE INTO messages(chat_id,scope,role,sender_id,content,event_id,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(chatId, scope, role, senderId, content, eventId, new Date().toISOString());
    return result.changes === 1;
  }

  clearMessages(chatId) {
    this.db.prepare('DELETE FROM messages WHERE chat_id=?').run(chatId);
  }

  getHistory(chatId, scope, limit = 16, excludeEventId = null) {
    return this.db.prepare(`SELECT role,content,sender_id FROM messages
      WHERE chat_id=? AND scope=? AND (? IS NULL OR event_id IS NULL OR event_id<>?)
      ORDER BY id DESC LIMIT ?`).all(chatId, scope, excludeEventId, excludeEventId, limit)
      .reverse().map((m) => ({ role: m.role, content: m.content, sender: m.sender_id }));
  }

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
      scope,normalizedOwner,normalizedChat,kind,content,source,now,
      memoryType,title,embedding ? JSON.stringify(embedding) : null,
      Math.max(1,Math.min(5,Number(importance) || 3)),
      projectId,JSON.stringify({ ...metadata, ...(sourceEventId ? { sourceEventId } : {}) }),
      now,now
    );
    return Number(result.lastInsertRowid);
  }

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
  }

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
    `).all(scope,ownerId,chatId,projectId,projectId);

    const terms = String(query || '').toLowerCase().split(/\\W+/).filter(term => term.length > 2);
    const scored = rows.map(row => {
      const haystack = `${row.title || ''} ${row.content || ''}`.toLowerCase();
      const lexical = terms.length
        ? terms.reduce((sum,term) => sum + (haystack.includes(term) ? 1 : 0),0) / terms.length
        : 0;
      let semantic = 0;
      if (queryEmbedding && row.embedding_json) {
        try { semantic = cosineSimilarity(queryEmbedding,JSON.parse(row.embedding_json)); } catch {}
      }
      const recency = Math.max(0,1 - ((Date.now() - Date.parse(row.created_at))/(180*86400000)));
      const importance = Math.max(1,Math.min(5,row.importance || 3))/5;
      const score = queryEmbedding
        ? semantic*0.72 + lexical*0.18 + importance*0.07 + recency*0.03
        : lexical*0.75 + importance*0.18 + recency*0.07;
      return { ...row,score,semanticScore:semantic,lexicalScore:lexical };
    });

    const relevant = scored
      .filter(row => queryEmbedding
        ? row.semanticScore >= 0.25 || row.lexicalScore > 0
        : terms.length === 0 || row.lexicalScore > 0)
      .sort((a,b) => b.score-a.score || b.id-a.id)
      .slice(0,Math.max(1,Math.min(limit,30)));

    const ids = relevant.map(row => row.id);
    if (ids.length) {
      const update = this.db.prepare('UPDATE memories SET last_accessed_at=?,updated_at=? WHERE id=?');
      const now = new Date().toISOString();
      this.db.transaction(() => ids.forEach(id => update.run(now,now,id)))();
    }
    return relevant.map(({ embedding_json, ...row }) => row);
  }

  createProject(project) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO projects (
        id,scope,owner_id,chat_id,name,description,status,metadata_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(
      project.id,project.scope,
      project.scope === 'personal' ? project.ownerId : null,
      project.scope === 'group' ? project.chatId : null,
      project.name,project.description || null,project.status || 'active',
      JSON.stringify(project.metadata || {}),now,now
    );
    return this.getProject(project.id,project.scope,project.ownerId || null,project.chatId || null);
  }

  getProject(id,scope,ownerId=null,chatId=null) {
    return this.db.prepare(`
      SELECT * FROM projects WHERE id=? AND scope=?
        AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
    `).get(id,scope,ownerId,chatId) || null;
  }

  listProjects({ scope,ownerId=null,chatId=null,status='active',limit=20 }) {
    return this.db.prepare(`
      SELECT id,name,description,status,created_at,updated_at
      FROM projects WHERE scope=?
        AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
        AND (? IS NULL OR status=?)
      ORDER BY updated_at DESC LIMIT ?
    `).all(scope,ownerId,chatId,status,status,Math.max(1,Math.min(limit,50)));
  }

  updateProject({ id,scope,ownerId=null,chatId=null,fields }) {
    const allowed = ['name','description','status','metadata_json'];
    const keys = Object.keys(fields).filter(key => allowed.includes(key));
    if (!keys.length) return this.getProject(id,scope,ownerId,chatId);
    const assignments = keys.map(key => `${key}=@${key}`).join(',');
    const result = this.db.prepare(`
      UPDATE projects SET ${assignments},updated_at=@updated_at
      WHERE id=@id AND scope=@scope
        AND ((scope='personal' AND owner_id=@ownerId) OR (scope='group' AND chat_id=@chatId))
    `).run({ ...fields,id,scope,ownerId,chatId,updated_at:new Date().toISOString() });
    return result.changes ? this.getProject(id,scope,ownerId,chatId) : null;
  }

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
      `).get(scope,normalizedOwner,normalizedChat,sourceEventId);
      if (existing) return existing.id;
    }

    const id = require('node:crypto').randomUUID();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO memory_events(
        id,scope,owner_id,chat_id,event_type,summary,source_event_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?)
    `).run(
      id,scope,normalizedOwner,normalizedChat,eventType,summary,
      sourceEventId,new Date().toISOString()
    );

    if (result.changes) return id;

    if (sourceEventId) {
      const existing = this.db.prepare(`
        SELECT id FROM memory_events
        WHERE scope=? AND owner_id IS ? AND chat_id IS ? AND source_event_id=?
        LIMIT 1
      `).get(scope,normalizedOwner,normalizedChat,sourceEventId);
      if (existing) return existing.id;
    }

    throw new Error('Failed to save memory event');
  }

  getChatOutputPreference({ chatId, requesterId, defaultMode = 'text' }) {
    const row = this.db.prepare(`
      SELECT voice_reply_mode, voice_reply_mode_is_set
      FROM chat_preferences
      WHERE chat_id=? AND requester_id=?
    `).get(chatId, requesterId);
    if (!row || !row.voice_reply_mode_is_set) {
      return { mode: defaultMode, isCustom: false };
    }
    return { mode: row.voice_reply_mode, isCustom: true };
  }

  getChatOutputMode({ chatId, requesterId, defaultMode = 'text' }) {
    return this.getChatOutputPreference({ chatId, requesterId, defaultMode }).mode;
  }

  setChatOutputMode({ chatId, requesterId, mode }) {
    if (!['text', 'voice', 'both'].includes(mode)) {
      throw new Error(`Unsupported chat output mode: ${mode}`);
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO chat_preferences(
        chat_id,requester_id,voice_reply_enabled,voice_reply_mode,
        voice_reply_mode_is_set,created_at,updated_at
      ) VALUES(?,?,?,?,1,?,?)
      ON CONFLICT(chat_id,requester_id)
      DO UPDATE SET voice_reply_enabled=excluded.voice_reply_enabled,
                    voice_reply_mode=excluded.voice_reply_mode,
                    voice_reply_mode_is_set=1,
                    updated_at=excluded.updated_at
    `).run(chatId, requesterId, mode === 'text' ? 0 : 1, mode, now, now);
    return this.getChatOutputMode({ chatId, requesterId });
  }

  resetChatOutputMode({ chatId, requesterId }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE chat_preferences
      SET voice_reply_mode_is_set=0, updated_at=?
      WHERE chat_id=? AND requester_id=?
    `).run(now, chatId, requesterId);
    return result.changes > 0;
  }

  // Backward-compatible boolean API for older integrations and tests.
  getChatPreference({ chatId, requesterId, defaultEnabled = false }) {
    const defaultMode = defaultEnabled ? 'both' : 'text';
    return this.getChatOutputMode({ chatId, requesterId, defaultMode }) !== 'text';
  }

  setVoiceReplyPreference({ chatId, requesterId, enabled }) {
    this.setChatOutputMode({
      chatId, requesterId, mode: enabled ? 'both' : 'text'
    });
    return this.getChatPreference({ chatId, requesterId });
  }

  hasMemoryExtraction(sourceEventId) {
    return !!this.db.prepare('SELECT 1 FROM memory_extraction_runs WHERE source_event_id=?').get(sourceEventId);
  }

  recordMemoryExtraction({ sourceEventId,status,extractedCount=0,error=null }) {
    this.db.prepare(`
      INSERT OR REPLACE INTO memory_extraction_runs(source_event_id,status,extracted_count,error,created_at)
      VALUES(?,?,?,?,?)
    `).run(sourceEventId,status,extractedCount,error,new Date().toISOString());
  }

  listMemoryEvents({ scope,ownerId=null,chatId=null,limit=20 }) {
    return this.db.prepare(`
      SELECT id,event_type,summary,created_at FROM memory_events
      WHERE scope=? AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
      ORDER BY created_at DESC LIMIT ?
    `).all(scope,ownerId,chatId,Math.max(1,Math.min(limit,50)));
  }

  createTask(task) {
    this.db.prepare(`INSERT OR IGNORE INTO tasks(id,source_event_id,chat_id,requester_id,scope,status,request_text,created_at,updated_at)
      VALUES(?,?,?, ?,?,'running',?,?,?)`).run(task.id, task.sourceEventId || null, task.chatId, task.requesterId, task.scope,
      task.requestText, new Date().toISOString(), new Date().toISOString());
    return this.getTask(task.id);
  }

  getTask(id) {
    return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) || null;
  }

  beginToolExecution({ idempotencyKey, taskId, toolName }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`INSERT OR IGNORE INTO tool_executions
      (idempotency_key,task_id,tool_name,status,created_at,updated_at)
      VALUES(?,?,?,'executing',?,?)`).run(idempotencyKey,taskId,toolName,now,now);
    if (result.changes === 1) return { state: 'claimed' };
    const existing = this.db.prepare('SELECT * FROM tool_executions WHERE idempotency_key=?').get(idempotencyKey);
    if (existing.status === 'completed') return { state: 'completed', output: JSON.parse(existing.output_json) };
    if (existing.status === 'uncertain' || existing.status === 'executing') return { state: 'uncertain', error: existing.error };
    if (existing.status === 'failed') {
      const retry = this.db.prepare(`UPDATE tool_executions SET status='executing',error=NULL,updated_at=?
        WHERE idempotency_key=? AND status='failed'`).run(now,idempotencyKey);
      if (retry.changes) return { state: 'claimed' };
    }
    return { state: existing.status, error: existing.error };
  }

  completeToolExecution(idempotencyKey, output) {
    this.db.prepare(`UPDATE tool_executions SET status='completed',output_json=?,error=NULL,updated_at=?
      WHERE idempotency_key=? AND status='executing'`)
      .run(JSON.stringify(output),new Date().toISOString(),idempotencyKey);
  }

  failToolExecution(idempotencyKey, error, uncertain = false) {
    this.db.prepare(`UPDATE tool_executions SET status=?,error=?,updated_at=?
      WHERE idempotency_key=? AND status='executing'`)
      .run(uncertain ? 'uncertain' : 'failed',String(error).slice(0,1000),new Date().toISOString(),idempotencyKey);
  }

  recoverStaleToolExecutions(staleMs = 120000) {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare("SELECT DISTINCT task_id FROM tool_executions WHERE status='executing' AND updated_at<?").all(cutoff);
      const changed = this.db.prepare(`UPDATE tool_executions SET status='uncertain',
        error='Recovered interrupted tool execution; manual reconciliation may be required',updated_at=?
        WHERE status='executing' AND updated_at<?`).run(now,cutoff).changes;
      const updateTask = this.db.prepare("UPDATE tasks SET status='uncertain',error='A tool execution was interrupted; automatic replay is blocked',updated_at=? WHERE id=? AND status IN ('running','awaiting_approval')");
      for (const row of rows) updateTask.run(now,row.task_id);
      return changed;
    });
    return tx();
  }

  updateTask(id, fields) {
    const allowed = ['status','result_text','response_status','response_text','response_updated_at','model_tier','tool_calls','error'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) return;
    const sql = `UPDATE tasks SET ${keys.map((k) => `${k}=@${k}`).join(',')},updated_at=@updated_at WHERE id=@id`;
    this.db.prepare(sql).run({ ...fields, id, updated_at: new Date().toISOString() });
  }

  queueTaskResponse(taskId, text) {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE tasks SET response_text=?,response_status='pending',
      response_updated_at=?,updated_at=? WHERE id=? AND response_status IN ('none','pending')`)
      .run(text,now,now,taskId);
  }

  claimTaskResponse(taskId) {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const row = this.db.prepare("SELECT response_text,response_status FROM tasks WHERE id=?").get(taskId);
      if (!row || row.response_status !== 'pending') return null;
      const changed = this.db.prepare("UPDATE tasks SET response_status='sending',response_updated_at=?,updated_at=? WHERE id=? AND response_status='pending'")
        .run(now,now,taskId).changes;
      return changed ? row.response_text : null;
    });
    return tx();
  }

  finishTaskResponse(taskId, status) {
    this.db.prepare('UPDATE tasks SET response_status=?,response_updated_at=?,updated_at=? WHERE id=? AND response_status=?')
      .run(status,new Date().toISOString(),new Date().toISOString(),taskId,'sending');
  }

  recoverStaleTaskResponses(staleMs = 120000) {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    return this.db.prepare("UPDATE tasks SET response_status='uncertain',response_updated_at=?,updated_at=? WHERE response_status='sending' AND response_updated_at<?")
      .run(new Date().toISOString(),new Date().toISOString(),cutoff).changes;
  }

  countTaskSteps(taskId) {
    return this.db.prepare('SELECT COUNT(*) AS count FROM task_steps WHERE task_id=?').get(taskId).count;
  }

  addTaskStep({ taskId, stepNo, toolName, input, output, status, durationMs }) {
    this.db.prepare(`INSERT OR IGNORE INTO task_steps(task_id,step_no,tool_name,input_json,output_json,status,duration_ms,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(taskId, stepNo, toolName || null,
      input == null ? null : JSON.stringify(input), output == null ? null : JSON.stringify(output),
      status, durationMs ?? null, new Date().toISOString());
  }

  createApproval(item) {
    this.db.prepare(`INSERT INTO approvals(id,task_id,chat_id,requester_id,tool_name,arguments_json,status,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'pending',?,?,?)`).run(item.id,item.taskId || null,item.chatId,item.requesterId,item.toolName,
      JSON.stringify(item.arguments),item.expiresAt,new Date().toISOString(),new Date().toISOString());
  }

  getApproval(id) {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
    return row ? { ...row, arguments: JSON.parse(row.arguments_json) } : null;
  }

  getPendingApprovalForTask(taskId) {
    const row = this.db.prepare("SELECT * FROM approvals WHERE task_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1").get(taskId);
    return row ? { ...row, arguments: JSON.parse(row.arguments_json) } : null;
  }

  getPendingApprovalsForChat(chatId) {
    const now = new Date().toISOString();
    return this.db.prepare(`
      SELECT id, task_id, tool_name, expires_at, created_at
      FROM approvals
      WHERE chat_id=? AND status='pending' AND expires_at>?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(chatId, now);
  }

  claimApproval(id, ownerId, configuredOwnerId) {
    if (ownerId !== configuredOwnerId) return null;
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM approvals WHERE id=? AND status='pending'").get(id);
      if (!row) return null;
      if (Date.parse(row.expires_at) < Date.now()) {
        this.db.prepare("UPDATE approvals SET status='expired',updated_at=? WHERE id=?").run(now,id);
        if (row.task_id) this.updateTask(row.task_id, { status: 'cancelled', result_text: 'Approval expired.' });
        return null;
      }
      const result = this.db.prepare("UPDATE approvals SET status='executing',updated_at=? WHERE id=? AND status='pending'").run(now,id);
      return result.changes ? { ...row, arguments: JSON.parse(row.arguments_json) } : null;
    });
    return tx();
  }

  failPendingApproval(id, error) {
    this.db.prepare("UPDATE approvals SET status='failed',execution_error=?,updated_at=? WHERE id=? AND status='pending'")
      .run(String(error).slice(0,1000),new Date().toISOString(),id);
  }

  denyApproval(id) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE approvals SET status='denied',updated_at=?
      WHERE id=? AND status='pending' AND expires_at>?`).run(now,id,now);
    if (result.changes) {
      const row = this.db.prepare('SELECT task_id FROM approvals WHERE id=?').get(id);
      if (row?.task_id) this.updateTask(row.task_id, { status: 'cancelled', result_text: 'Owner denied the action.' });
      return true;
    }
    this.db.prepare(`UPDATE approvals SET status='expired',updated_at=?
      WHERE id=? AND status='pending' AND expires_at<=?`).run(now,id,now);
    const row = this.db.prepare('SELECT task_id FROM approvals WHERE id=?').get(id);
    if (row?.task_id) this.updateTask(row.task_id, { status: 'cancelled', result_text: 'Approval expired.' });
    return false;
  }

  finishApproval(id, status, error = null) {
    this.db.prepare('UPDATE approvals SET status=?,execution_error=?,updated_at=? WHERE id=? AND status=?')
      .run(status,error,new Date().toISOString(),id,'executing');
    const row = this.db.prepare('SELECT task_id FROM approvals WHERE id=?').get(id);
    if (row?.task_id) {
      this.updateTask(row.task_id, {
        status: status === 'approved' ? 'completed' : status === 'uncertain' ? 'uncertain' : 'failed',
        result_text: status === 'approved' ? 'Approved external action executed.' : null,
        error: error || null
      });
    }
  }

  createReminder({ chatId, requesterId, message, dueAt, sourceEventId = null }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`INSERT OR IGNORE INTO reminders(source_event_id,chat_id,requester_id,message,due_at,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'pending',?,?)`).run(sourceEventId,chatId,requesterId,message,dueAt,now,now);
    if (result.changes) return Number(result.lastInsertRowid);
    if (sourceEventId) {
      const existing = this.db.prepare('SELECT id FROM reminders WHERE source_event_id=?').get(sourceEventId);
      if (existing) return Number(existing.id);
    }
    throw new Error('Unable to create reminder');
  }

  claimDueReminders(now = new Date().toISOString()) {
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM reminders WHERE status='pending' AND due_at<=? ORDER BY due_at LIMIT 20").all(now);
      const update = this.db.prepare("UPDATE reminders SET status='sending',attempts=attempts+1,updated_at=? WHERE id=? AND status='pending'");
      const claimed = [];
      for (const row of rows) {
        if (update.run(new Date().toISOString(),row.id).changes) claimed.push({ ...row, status:'sending' });
      }
      return claimed;
    });
    return tx();
  }

  finishReminder(id, success, error = null) {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE reminders SET status=?,delivery_uncertain=?,updated_at=?
      WHERE id=? AND status='sending'`)
      .run(success ? 'sent' : 'failed', success ? 0 : 1, now, id);
    if (!success) {
      this.audit({
        action: 'reminder_delivery_uncertain',
        outcome: 'manual_review',
        details: { reminderId: id, error: String(error || '').slice(0, 300) }
      });
    }
  }

  recoverStaleReminders(staleMs = 120000) {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    return this.db.prepare(`UPDATE reminders SET status='failed',delivery_uncertain=1,updated_at=?
      WHERE status='sending' AND updated_at<?`)
      .run(new Date().toISOString(), cutoff).changes;
  }

  recoverStaleApprovals(staleMs = 120000) {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare("SELECT task_id FROM approvals WHERE status='executing' AND updated_at<? AND task_id IS NOT NULL").all(cutoff);
      const changed = this.db.prepare("UPDATE approvals SET status='uncertain',execution_error='Recovered interrupted approval; remote send status must be checked manually',updated_at=? WHERE status='executing' AND updated_at<?")
        .run(now,cutoff).changes;
      const updateTask = this.db.prepare("UPDATE tasks SET status='uncertain',error='Approval execution interrupted; check WhatsApp delivery manually',updated_at=? WHERE id=?");
      for (const row of rows) updateTask.run(now,row.task_id);
      return changed;
    });
    return tx();
  }

  saveDocument(doc) {
    const now = new Date().toISOString();
    if (doc.sourceEventId) {
      const existing = this.db.prepare(`SELECT id,scope,filename,mime_type,file_size,extracted_text,created_at
        FROM documents WHERE source_event_id=? AND scope=? AND
        ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))`)
        .get(doc.sourceEventId,doc.scope,doc.ownerId || null,doc.chatId || null);
      if (existing) return existing;
    }
    this.db.prepare(`INSERT OR IGNORE INTO documents
      (id,scope,owner_id,chat_id,filename,mime_type,file_path,file_size,extracted_text,source_event_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      doc.id,doc.scope,doc.ownerId || null,doc.chatId || null,doc.filename,
      doc.mimeType,doc.filePath,doc.fileSize,doc.extractedText,
      doc.sourceEventId || null,now
    );
    return this.getDocument(doc.id, doc.scope, doc.ownerId || null, doc.chatId || null);
  }

  getDocument(id, scope, ownerId = null, chatId = null) {
    return this.db.prepare(`SELECT id,scope,filename,mime_type,file_size,extracted_text,created_at
      FROM documents WHERE id=? AND scope=? AND
      ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))`)
      .get(id,scope,ownerId,chatId) || null;
  }

  getDocumentFile(id, scope, ownerId = null, chatId = null) {
    return this.db.prepare(`SELECT id,scope,owner_id,chat_id,filename,mime_type,file_path,file_size,created_at
      FROM documents WHERE id=? AND scope=? AND
      ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))`)
      .get(id,scope,ownerId,chatId) || null;
  }

  listDocuments({ scope, ownerId = null, chatId = null, limit = 10 }) {
    return this.db.prepare(`SELECT id,filename,mime_type,file_size,created_at FROM documents
      WHERE scope=? AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
      ORDER BY created_at DESC LIMIT ?`).all(scope,ownerId,chatId,Math.max(1,Math.min(limit,50)));
  }

  searchDocuments({ scope, ownerId = null, chatId = null, query, limit = 5 }) {
    const rawQuery = String(query || '').trim();
    const terms = rawQuery.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((x) => x.length >= 2);
    if (!terms.length) return [];
    const rows = this.db.prepare(`SELECT id,filename,mime_type,extracted_text,created_at FROM documents
      WHERE scope=? AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
      ORDER BY created_at DESC LIMIT 100`).all(scope, ownerId, chatId);
    return rows.map((row) => {
      const filenameLower = String(row.filename || '').toLowerCase();
      const filenameScore = terms.reduce((n, t) => n + (filenameLower.includes(t) ? 3 : 0), 0);
      const snippetResult = searchDocumentSnippets(row.extracted_text, rawQuery, {
        maxSnippets: 3,
        snippetChars: 550,
      });
      const snippetScore = snippetResult.snippets.reduce((n, s) => n + s.score, 0);
      const totalScore = filenameScore + snippetScore;
      return {
        ...row,
        score: totalScore,
        snippets: snippetResult.snippets,
        matchedPages: snippetResult.snippets.map((s) => s.pageNumber),
        totalPages: snippetResult.totalPages,
        excerpt: snippetResult.excerpt || (filenameScore > 0 ? String(row.extracted_text || '').slice(0, 1800) : ''),
      };
    }).filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || b.created_at.localeCompare(a.created_at))
      .slice(0, Math.max(1, Math.min(limit, 20)))
      .map(({ extracted_text, ...row }) => row);
  }

  deleteDocument(id, scope, ownerId = null, chatId = null) {
    const existing = this.getDocumentFile(id, scope, ownerId, chatId);
    if (!existing) return null;
    const result = this.db.prepare(`DELETE FROM documents WHERE id=? AND scope=? AND
      ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))`)
      .run(id, scope, ownerId, chatId);
    return result.changes ? existing : null;
  }

  createUserTask(task) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO user_tasks
      (id,scope,owner_id,chat_id,title,description,status,priority,due_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?, 'open',?,?,?,?)`).run(
      task.id,task.scope,task.ownerId || null,task.chatId || null,
      task.title,task.description || null,task.priority || 'normal',
      task.dueAt || null,now,now
    );
    return this.getUserTask(task.id,task.scope,task.ownerId || null,task.chatId || null);
  }

  getUserTask(id, scope, ownerId = null, chatId = null) {
    return this.db.prepare(`SELECT * FROM user_tasks WHERE id=? AND scope=? AND
      ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))`)
      .get(id,scope,ownerId,chatId) || null;
  }

  listUserTasks({ scope, ownerId = null, chatId = null, status = null, limit = 20 }) {
    return this.db.prepare(`SELECT id,title,description,status,priority,due_at,created_at,updated_at
      FROM user_tasks WHERE scope=? AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
      AND (? IS NULL OR status=?)
      ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,due_at ASC,created_at DESC LIMIT ?`)
      .all(scope,ownerId,chatId,status,status,Math.max(1,Math.min(limit,50)));
  }

  updateUserTask({ id, scope, ownerId = null, chatId = null, fields }) {
    const allowed = ['title','description','status','priority','due_at'];
    const keys = Object.keys(fields).filter((key) => allowed.includes(key));
    if (!keys.length) return this.getUserTask(id,scope,ownerId,chatId);
    const assignments = keys.map((key) => `${key}=@${key}`).join(',');
    const result = this.db.prepare(`UPDATE user_tasks SET ${assignments},updated_at=@updated_at
      WHERE id=@id AND scope=@scope AND
      ((scope='personal' AND owner_id=@ownerId) OR (scope='group' AND chat_id=@chatId))`)
      .run({ ...fields,id,scope,ownerId,chatId,updated_at:new Date().toISOString() });
    return result.changes ? this.getUserTask(id,scope,ownerId,chatId) : null;
  }

  listReminders({ chatId, requesterId, status = 'pending', limit = 20 }) {
    return this.db.prepare(`SELECT id,message,due_at,status,delivery_uncertain,created_at
      FROM reminders WHERE chat_id=? AND requester_id=? AND (? IS NULL OR status=?)
      ORDER BY due_at LIMIT ?`).all(chatId,requesterId,status,status,Math.max(1,Math.min(limit,50)));
  }

  cancelReminder({ id, chatId, requesterId }) {
      const now = new Date().toISOString();
    
      const result = this.db.prepare(`
        UPDATE reminders
        SET status = 'cancelled',
            updated_at = ?
        WHERE id = ?
          AND chat_id = ?
          AND requester_id = ?
          AND status = 'pending'
      `).run(
        now,
        id,
        chatId,
        requesterId
      );
    
      return result.changes === 1;
    }

  logModelUsage({ taskId, modelId, tier, usage, latencyMs, outcome }) {
    this.db.prepare(`INSERT INTO model_usage(task_id,model_id,tier,input_tokens,output_tokens,latency_ms,outcome,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(taskId,modelId,tier,usage?.prompt_tokens ?? null,
      usage?.completion_tokens ?? null,latencyMs,outcome,new Date().toISOString());
  }

  consumeRateLimit(rateKey, { limit = 10, windowMs = 60000, now = Date.now() } = {}) {
    const cutoff = now - windowMs;
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM rate_limit_events WHERE created_at_ms<?').run(cutoff);
      const row = this.db.prepare(`SELECT COUNT(*) AS count, MIN(created_at_ms) AS oldest
        FROM rate_limit_events WHERE rate_key=? AND created_at_ms>=?`).get(rateKey,cutoff);
      if (row.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: Math.max(1, windowMs - (now - row.oldest))
        };
      }
      this.db.prepare('INSERT INTO rate_limit_events(rate_key,created_at_ms) VALUES(?,?)').run(rateKey,now);
      return { allowed: true, remaining: limit - row.count - 1, retryAfterMs: 0 };
    });
    return tx();
  }

  audit({ chatId = null, actorId = null, action, outcome, details = {} }) {
    this.db.prepare(`INSERT INTO audit_logs(chat_id,actor_id,action,outcome,details_json,created_at)
      VALUES(?,?,?,?,?,?)`).run(chatId,actorId,action,outcome,JSON.stringify(details),new Date().toISOString());
  }

  close() { this.db.close(); }
}

module.exports = { DatabaseStore, MIGRATIONS, cosineSimilarity };
