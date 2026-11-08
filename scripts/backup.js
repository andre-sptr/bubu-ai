require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

async function main() {
  const sourcePath = path.resolve(process.env.DATABASE_PATH || './data/bubu.sqlite');
  if (!fs.existsSync(sourcePath)) throw new Error(`Database not found: ${sourcePath}`);
  const backupDir = path.resolve(process.env.BACKUP_DIR || './backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupDir, `bubu-${stamp}.sqlite`);
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try { await db.backup(destination); }
  finally { db.close(); }
  const storageDir = path.resolve(process.env.STORAGE_DIR || './storage');
  let storageBackup = null;
  if (fs.existsSync(storageDir)) {
    storageBackup = path.join(backupDir, `storage-${stamp}`);
    fs.cpSync(storageDir, storageBackup, { recursive: true, errorOnExist: true });
  }
  console.log(`Database backup created: ${destination}`);
  if (storageBackup) console.log(`Document storage backup created: ${storageBackup}`);
}
main().catch((error) => { console.error(error.message); process.exit(1); });
