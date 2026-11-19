require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

function normalizeForCompare(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrInside(baseDir, candidatePath) {
  const rel = path.relative(normalizeForCompare(baseDir), normalizeForCompare(candidatePath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function verifySqliteIntegrity(dbPath) {
  const verifyDb = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 10000 });
  try {
    const rows = verifyDb.prepare('PRAGMA integrity_check').all();
    const ok = rows.length === 1 && String(rows[0]?.integrity_check || '').toLowerCase() === 'ok';
    if (!ok) {
      const details = rows.map((row) => row.integrity_check).filter(Boolean).join('; ') || 'unknown integrity error';
      throw new Error(`SQLite backup integrity_check failed: ${details}`);
    }
    return 'ok';
  } finally {
    verifyDb.close();
  }
}

function compareBackupEntriesDesc(a, b) {
  if (Math.abs(b.mtimeMs - a.mtimeMs) >= 1000) {
    return b.mtimeMs - a.mtimeMs;
  }
  if (a.name === b.name) return 0;
  return b.name > a.name ? 1 : -1;
}

function pruneOldBackups(backupDir, keepCount = 7) {
  const resolvedBackupDir = path.resolve(backupDir);
  if (!fs.existsSync(resolvedBackupDir)) {
    return { prunedDbCount: 0, prunedStorageCount: 0 };
  }

  const parsedKeep = Number(keepCount);
  const keep = Number.isFinite(parsedKeep) ? Math.floor(parsedKeep) : 7;
  if (keep < 1) {
    return { prunedDbCount: 0, prunedStorageCount: 0 };
  }

  const entries = fs.readdirSync(resolvedBackupDir, { withFileTypes: true });
  const dbBackups = [];
  const storageBackups = [];

  for (const entry of entries) {
    const fullPath = path.join(resolvedBackupDir, entry.name);
    if (entry.isFile() && /^bubu-.+\.sqlite$/.test(entry.name)) {
      const stat = fs.statSync(fullPath);
      dbBackups.push({ name: entry.name, fullPath, mtimeMs: stat.mtimeMs });
    } else if ((entry.isDirectory() || entry.isFile()) && /^storage-.+/.test(entry.name)) {
      const stat = fs.statSync(fullPath);
      storageBackups.push({ name: entry.name, fullPath, mtimeMs: stat.mtimeMs });
    }
  }

  dbBackups.sort(compareBackupEntriesDesc);
  storageBackups.sort(compareBackupEntriesDesc);

  let prunedDbCount = 0;
  for (const oldDb of dbBackups.slice(keep)) {
    fs.rmSync(oldDb.fullPath, { force: true });
    prunedDbCount++;
  }

  let prunedStorageCount = 0;
  for (const oldStorage of storageBackups.slice(keep)) {
    fs.rmSync(oldStorage.fullPath, { recursive: true, force: true });
    prunedStorageCount++;
  }

  return { prunedDbCount, prunedStorageCount };
}

function logBackupInfo(logger, message) {
  if (typeof logger?.info === 'function') {
    logger.info(message);
  } else if (typeof logger?.log === 'function') {
    logger.log(message);
  }
}

async function runBackup({ sourcePath, backupDir, storageDir, keepCount = 7, logger = console } = {}) {
  const resolvedSourcePath = path.resolve(sourcePath || process.env.DATABASE_PATH || './data/bubu.sqlite');
  if (!fs.existsSync(resolvedSourcePath) || !fs.statSync(resolvedSourcePath).isFile()) {
    throw new Error(`Database not found: ${resolvedSourcePath}`);
  }

  const resolvedBackupDir = path.resolve(backupDir || process.env.BACKUP_DIR || './backups');
  const resolvedStorageDir = storageDir === null
    ? null
    : path.resolve(storageDir || process.env.STORAGE_DIR || './storage');

  if (
    resolvedStorageDir &&
    (isSameOrInside(resolvedStorageDir, resolvedBackupDir) || isSameOrInside(resolvedBackupDir, resolvedStorageDir))
  ) {
    throw new Error(
      `Backup directory (${resolvedBackupDir}) and storage directory (${resolvedStorageDir}) must not overlap or nest inside each other.`
    );
  }

  fs.mkdirSync(resolvedBackupDir, { recursive: true, mode: 0o700 });

  let ms = Date.now();
  let stamp;
  let destination;
  let storageBackupTarget;
  while (true) {
    stamp = new Date(ms).toISOString().replace(/[:.]/g, '-');
    destination = path.join(resolvedBackupDir, `bubu-${stamp}.sqlite`);
    storageBackupTarget = path.join(resolvedBackupDir, `storage-${stamp}`);
    if (
      !fs.existsSync(destination) &&
      !fs.existsSync(`${destination}.tmp`) &&
      !fs.existsSync(storageBackupTarget)
    ) {
      break;
    }
    ms += 1;
  }

  const tmpDestination = `${destination}.tmp`;
  const db = new Database(resolvedSourcePath, { readonly: true, fileMustExist: true, timeout: 10000 });
  try {
    try {
      await db.backup(tmpDestination);
    } finally {
      db.close();
    }

    verifySqliteIntegrity(tmpDestination);
    try {
      fs.chmodSync(tmpDestination, 0o600);
    } catch {
      // Ignore chmod failures on platforms/filesystems without POSIX permissions
    }
    fs.renameSync(tmpDestination, destination);
  } catch (error) {
    fs.rmSync(tmpDestination, { force: true });
    throw error;
  }

  let storageBackup = null;
  if (resolvedStorageDir && fs.existsSync(resolvedStorageDir)) {
    fs.cpSync(resolvedStorageDir, storageBackupTarget, { recursive: true, errorOnExist: true });
    storageBackup = storageBackupTarget;
  }

  const { prunedDbCount, prunedStorageCount } = pruneOldBackups(resolvedBackupDir, keepCount);

  logBackupInfo(logger, `Database backup created: ${destination}`);
  if (storageBackup) {
    logBackupInfo(logger, `Document storage backup created: ${storageBackup}`);
  }

  return {
    destination,
    storageBackup,
    integrity: 'ok',
    prunedDbCount,
    prunedStorageCount
  };
}

async function main() {
  const envKeep = process.env.BACKUP_KEEP_COUNT ? Number(process.env.BACKUP_KEEP_COUNT) : 7;
  const keepCount = Number.isFinite(envKeep) && envKeep >= 1 ? Math.floor(envKeep) : 7;
  return runBackup({ keepCount });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  runBackup,
  pruneOldBackups,
  verifySqliteIntegrity
};
