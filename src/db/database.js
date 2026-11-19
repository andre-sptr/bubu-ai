const fs = require('node:fs');
const path = require('node:path');
const { MIGRATIONS } = require('./migrations');
const { cosineSimilarity } = require('../utils/vector');
const { inboxRepository } = require('./repositories/inbox.repository');
const { chatRepository } = require('./repositories/chat.repository');
const { memoryRepository } = require('./repositories/memory.repository');
const { agentTaskRepository } = require('./repositories/agent-task.repository');
const { productivityRepository } = require('./repositories/productivity.repository');
const { documentRepository } = require('./repositories/document.repository');
const { telemetryRepository } = require('./repositories/telemetry.repository');

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

        this.db.exec(migration.sql);
        this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
          .run(migration.version, new Date().toISOString());
      });
      tx();
      applied.add(migration.version);
    }
  }

  close() { this.db.close(); }
}

Object.assign(
  DatabaseStore.prototype,
  inboxRepository,
  chatRepository,
  memoryRepository,
  agentTaskRepository,
  productivityRepository,
  documentRepository,
  telemetryRepository
);

module.exports = { DatabaseStore, MIGRATIONS, cosineSimilarity };
