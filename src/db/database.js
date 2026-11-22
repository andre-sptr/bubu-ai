const fs = require('node:fs');
const path = require('node:path');
const { MIGRATIONS } = require('./migrations');
const { cosineSimilarity, encodeEmbeddingBlob } = require('../utils/vector');
const { inboxRepository } = require('./repositories/inbox.repository');
const { chatRepository } = require('./repositories/chat.repository');
const { memoryRepository } = require('./repositories/memory.repository');
const { agentTaskRepository } = require('./repositories/agent-task.repository');
const { productivityRepository } = require('./repositories/productivity.repository');
const { documentRepository } = require('./repositories/document.repository');
const { telemetryRepository } = require('./repositories/telemetry.repository');
const { pollRepository } = require('./repositories/poll.repository');

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
        if (migration.version === 11) {
          const columns = (table) => new Set(
            this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
          );
          const memoryColumns = columns('memories');
          if (!memoryColumns.has('status')) {
            this.db.exec("ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','archived'))");
          }
          if (!memoryColumns.has('superseded_by')) {
            this.db.exec('ALTER TABLE memories ADD COLUMN superseded_by INTEGER');
          }
        }
        if (migration.version === 12) {
          const inboxColumns = new Set(
            this.db.prepare('PRAGMA table_info(inbox_events)').all().map((c) => c.name)
          );
          if (!inboxColumns.has('priority')) {
            this.db.exec('ALTER TABLE inbox_events ADD COLUMN priority INTEGER NOT NULL DEFAULT 5');
          }
        }
        if (migration.version === 13) {
          const tableExists = (tableName) => Boolean(
            this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName)
          );
          if (tableExists('messages')) {
            const msgColumns = new Set(
              this.db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name)
            );
            if (!msgColumns.has('wa_message_id')) {
              this.db.exec('ALTER TABLE messages ADD COLUMN wa_message_id TEXT');
            }
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(chat_id, wa_message_id) WHERE wa_message_id IS NOT NULL');
          }
          if (tableExists('model_usage')) {
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_model_usage_created ON model_usage(created_at)');
          }
          if (tableExists('audit_logs')) {
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at)');
          }
        }
        if (migration.version === 14) {
          const tableExists = (tableName) => Boolean(
            this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName)
          );
          if (tableExists('memories')) {
            const memCols = new Set(
              this.db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name)
            );
            if (!memCols.has('embedding_blob')) {
              this.db.exec('ALTER TABLE memories ADD COLUMN embedding_blob BLOB');
            }
            const legacyRows = this.db.prepare(
              'SELECT id, embedding_json FROM memories WHERE embedding_json IS NOT NULL AND embedding_blob IS NULL'
            ).all();
            if (legacyRows.length > 0) {
              const updateBlob = this.db.prepare(
                'UPDATE memories SET embedding_blob=?, embedding_json=NULL WHERE id=?'
              );
              for (const row of legacyRows) {
                try {
                  const vec = JSON.parse(row.embedding_json);
                  const blob = encodeEmbeddingBlob(vec);
                  if (blob) updateBlob.run(blob, row.id);
                } catch {
                  // Preserve malformed rows without crashing migration.
                }
              }
            }
          }
          if (tableExists('inbox_events')) {
            const inboxCols = new Set(
              this.db.prepare('PRAGMA table_info(inbox_events)').all().map((c) => c.name)
            );
            if (inboxCols.has('priority')) {
              this.db.exec('DROP INDEX IF EXISTS idx_inbox_priority_ready');
              this.db.exec(`
                CREATE INDEX IF NOT EXISTS idx_inbox_priority_ready
                  ON inbox_events(status, priority ASC, created_at ASC, available_at);
              `);
            }
          }
          if (tableExists('documents')) {
            this.db.exec(`
              CREATE TABLE IF NOT EXISTS document_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                scope TEXT NOT NULL CHECK(scope IN ('personal','group')),
                owner_id TEXT,
                chat_id TEXT,
                chunk_index INTEGER NOT NULL,
                page_number INTEGER NOT NULL DEFAULT 1,
                content TEXT NOT NULL,
                embedding_blob BLOB,
                created_at TEXT NOT NULL
              );
              CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_chunks_doc_idx
                ON document_chunks(document_id, chunk_index);
              CREATE INDEX IF NOT EXISTS idx_doc_chunks_scope
                ON document_chunks(scope, owner_id, chat_id, document_id);
            `);
          }
          if (tableExists('tasks')) {
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at)');
          }
          if (tableExists('approvals')) {
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_approvals_status_updated ON approvals(status, updated_at)');
          }
          if (tableExists('tool_executions')) {
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_tool_executions_status_updated ON tool_executions(status, updated_at)');
          }
          if (tableExists('memory_extraction_runs')) {
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_memory_extraction_created ON memory_extraction_runs(created_at)');
          }
        }
        if (migration.version === 15) {
          const tableExists = (tableName) => Boolean(
            this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName)
          );
          if (tableExists('reminders')) {
            const remCols = new Set(
              this.db.prepare('PRAGMA table_info(reminders)').all().map((c) => c.name)
            );
            if (!remCols.has('recurrence')) {
              this.db.exec('ALTER TABLE reminders ADD COLUMN recurrence TEXT');
            }
          }
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS app_settings (
              key TEXT PRIMARY KEY,
              value_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS group_passive_messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              chat_id TEXT NOT NULL,
              sender_id TEXT,
              message_id TEXT,
              content TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_group_passive_chat_id
              ON group_passive_messages(chat_id, id DESC);
            CREATE INDEX IF NOT EXISTS idx_group_passive_created
              ON group_passive_messages(created_at);
            CREATE TABLE IF NOT EXISTS polls (
              poll_message_id TEXT PRIMARY KEY,
              chat_id TEXT NOT NULL,
              scope TEXT NOT NULL CHECK(scope IN ('personal','group')),
              question TEXT NOT NULL,
              options_json TEXT NOT NULL,
              multiple_answers INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_polls_chat
              ON polls(chat_id, created_at DESC);
            CREATE TABLE IF NOT EXISTS poll_votes (
              poll_message_id TEXT NOT NULL,
              voter_id TEXT NOT NULL,
              selected_options_json TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY(poll_message_id, voter_id)
            );
            CREATE INDEX IF NOT EXISTS idx_poll_votes_poll
              ON poll_votes(poll_message_id, updated_at DESC);
          `);
        }

        this.db.exec(migration.sql);
        this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
          .run(migration.version, new Date().toISOString());
      });
      tx();
      applied.add(migration.version);
    }
  }

  close() {
    try {
      if (this.db?.open && !this.db.readonly) {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
      }
    } catch {
      // Ignore checkpoint failures during shutdown/read-only close.
    }
    this.db.close();
  }
}

Object.assign(
  DatabaseStore.prototype,
  inboxRepository,
  chatRepository,
  memoryRepository,
  agentTaskRepository,
  productivityRepository,
  documentRepository,
  telemetryRepository,
  pollRepository
);

module.exports = { DatabaseStore, MIGRATIONS, cosineSimilarity };
