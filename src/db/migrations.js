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
  {
    version: 10,
    sql: `
      DROP INDEX IF EXISTS idx_memory_events_source;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_events_source
        ON memory_events(scope,owner_id,chat_id,source_event_id)
        WHERE source_event_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_rate_limit_events_created_at
        ON rate_limit_events(created_at_ms);
    `
  }
];

module.exports = { MIGRATIONS };
