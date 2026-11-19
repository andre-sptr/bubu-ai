const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runBackup, pruneOldBackups, verifySqliteIntegrity } = require('../../../scripts/backup');
const {
  splitOversizedToken,
  wrapTextToWidth,
  buildPdf14Buffer
} = require('../../../src/documents/generators/pdf-generator');

test('runBackup backs up WAL SQLite DB and storage dir, verifies integrity, and rotates old backups', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-backup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const sourcePath = path.join(root, 'data', 'bubu.sqlite');
  const storageDir = path.join(root, 'storage');
  const backupDir = path.join(root, 'backups');

  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(path.join(storageDir, 'generated'), { recursive: true });
  fs.writeFileSync(path.join(storageDir, 'generated', 'note.txt'), 'important-doc');

  const srcDb = new Database(sourcePath);
  srcDb.pragma('journal_mode = WAL');
  srcDb.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES (\'alpha\');');

  try {
    // Run 3 backups while source DB remains open in WAL mode, keeping only 2
    const r1 = await runBackup({ sourcePath, backupDir, storageDir, keepCount: 2, logger: { info: () => {} } });
    assert.equal(r1.integrity, 'ok');
    assert.ok(fs.existsSync(r1.destination));
    assert.ok(r1.storageBackup && fs.existsSync(path.join(r1.storageBackup, 'generated', 'note.txt')));
    assert.equal(r1.prunedDbCount, 0);
    assert.equal(r1.prunedStorageCount, 0);

    srcDb.exec("INSERT INTO items (name) VALUES ('beta');");
    const r2 = await runBackup({ sourcePath, backupDir, storageDir, keepCount: 2, logger: { info: () => {} } });
    assert.equal(r2.integrity, 'ok');
    assert.equal(r2.prunedDbCount, 0);

    srcDb.exec("INSERT INTO items (name) VALUES ('gamma');");
    const r3 = await runBackup({ sourcePath, backupDir, storageDir, keepCount: 2, logger: { info: () => {} } });
    assert.equal(r3.integrity, 'ok');
    assert.equal(r3.prunedDbCount, 1);
    assert.equal(r3.prunedStorageCount, 1);

    const remaining = fs.readdirSync(backupDir);
    assert.equal(remaining.filter((n) => /^bubu-.+\.sqlite$/.test(n)).length, 2);
    assert.equal(remaining.filter((n) => /^storage-.+/.test(n)).length, 2);
    assert.equal(remaining.some((n) => n.endsWith('.tmp')), false);
    assert.equal(fs.existsSync(r1.destination), false);
    assert.equal(fs.existsSync(r2.destination), true);
    assert.equal(fs.existsSync(r3.destination), true);

    // Verify latest backup contains all 3 committed WAL rows
    const checkDb = new Database(r3.destination, { readonly: true });
    try {
      const count = checkDb.prepare('SELECT COUNT(*) AS cnt FROM items').get().cnt;
      assert.equal(count, 3);
    } finally {
      checkDb.close();
    }
  } finally {
    srcDb.close();
  }
});

test('runBackup rejects missing source DB and overlapping backupDir/storageDir paths', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-backup-guards-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const sourcePath = path.join(root, 'bubu.sqlite');
  const db = new Database(sourcePath);
  db.exec('CREATE TABLE t (x INTEGER);');
  db.close();

  await assert.rejects(
    () => runBackup({ sourcePath: path.join(root, 'missing.sqlite'), backupDir: path.join(root, 'backups'), storageDir: path.join(root, 'storage') }),
    /Database not found/
  );

  const storageDir = path.join(root, 'storage');
  fs.mkdirSync(storageDir, { recursive: true });

  // Equal
  await assert.rejects(
    () => runBackup({ sourcePath, backupDir: storageDir, storageDir }),
    /must not overlap/
  );
  // backupDir nested inside storageDir
  await assert.rejects(
    () => runBackup({ sourcePath, backupDir: path.join(storageDir, 'backups'), storageDir }),
    /must not overlap/
  );
  // storageDir nested inside backupDir
  await assert.rejects(
    () => runBackup({ sourcePath, backupDir: root, storageDir }),
    /must not overlap/
  );
});

test('pruneOldBackups preserves non-backup files and verifySqliteIntegrity fails on corrupt files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-backup-prune-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, 'bubu-2026-01-01T00-00-00-000Z.sqlite'), '1');
  fs.writeFileSync(path.join(root, 'bubu-2026-01-02T00-00-00-000Z.sqlite'), '2');
  fs.writeFileSync(path.join(root, 'bubu-2026-01-03T00-00-00-000Z.sqlite'), '3');
  fs.writeFileSync(path.join(root, 'bubu-2026-01-04T00-00-00-000Z.sqlite.tmp'), 'tmp');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'keep');
  fs.mkdirSync(path.join(root, 'storage-2026-01-01T00-00-00-000Z'));
  fs.mkdirSync(path.join(root, 'storage-2026-01-02T00-00-00-000Z'));
  fs.mkdirSync(path.join(root, 'storage-2026-01-03T00-00-00-000Z'));

  const pruned = pruneOldBackups(root, 2);
  assert.deepEqual(pruned, { prunedDbCount: 1, prunedStorageCount: 1 });
  assert.equal(fs.existsSync(path.join(root, 'bubu-2026-01-01T00-00-00-000Z.sqlite')), false);
  assert.equal(fs.existsSync(path.join(root, 'bubu-2026-01-02T00-00-00-000Z.sqlite')), true);
  assert.equal(fs.existsSync(path.join(root, 'bubu-2026-01-03T00-00-00-000Z.sqlite')), true);
  assert.equal(fs.existsSync(path.join(root, 'bubu-2026-01-04T00-00-00-000Z.sqlite.tmp')), true);
  assert.equal(fs.existsSync(path.join(root, 'notes.txt')), true);
  assert.equal(fs.existsSync(path.join(root, 'storage-2026-01-01T00-00-00-000Z')), false);

  const corruptFile = path.join(root, 'corrupt.sqlite');
  fs.writeFileSync(corruptFile, 'not-a-valid-sqlite-database');
  assert.throws(() => verifySqliteIntegrity(corruptFile));
});

test('splitOversizedToken and wrapTextToWidth never exceed maxChars on long URLs and tokens', () => {
  const longUrl = 'https://subdomain.example.com/api/v2/documents/1234567890abcdef/download?token=verylongtokenwithoutspaces1234567890';
  const chunks = splitOversizedToken(longUrl, 24);
  assert.ok(chunks.length >= 4);
  assert.equal(chunks.join(''), longUrl);
  for (const chunk of chunks) {
    assert.ok(chunk.length >= 1 && chunk.length <= 24, `Chunk exceeded 24 chars: ${chunk}`);
  }

  const solidToken = 'X'.repeat(55);
  const solidChunks = splitOversizedToken(solidToken, 16);
  assert.equal(solidChunks.join(''), solidToken);
  assert.ok(solidChunks.every((c) => c.length <= 16));

  const mixed = `Lihat tautan ${longUrl} dan kode ${'A'.repeat(40)} segera.`;
  const wrapped = wrapTextToWidth(mixed, 25);
  assert.ok(wrapped.length >= 6);
  for (const line of wrapped) {
    assert.ok(line.length <= 25, `Wrapped line exceeded 25 chars: "${line}"`);
  }
});

test('buildPdf14Buffer wraps multi-line Markdown table cells with dynamic row height and valid PDF structure', () => {
  const longUrl = 'https://docs.example.com/reports/2026/quarter-4/financial-audit-summary-final';
  const longDesc = 'Implementasi sinkronisasi antrean multi-slot dengan validasi integritas backup otomatis setiap malam';
  const rows = [];
  for (let i = 1; i <= 18; i++) {
    rows.push(`| Item-${i} | ${i === 1 ? longDesc : `Deskripsi panjang baris ${i} untuk memastikan pagination tabel berjalan rapi`} | ${i === 2 ? longUrl : `Status-${i}`} |`);
  }

  const pdfBuffer = buildPdf14Buffer({
    title: `Laporan Audit ${'A'.repeat(80)}`,
    subtitle: 'Uji Pembungkusan Token Panjang & Tabel Multi-Baris',
    content: [
      '# Ringkasan',
      `Tautan referensi: ${longUrl}`,
      '',
      '| Kode | Keterangan Detail | Tautan / Status |',
      '|---|---|---|',
      ...rows
    ].join('\n')
  });

  const pdfText = pdfBuffer.toString('latin1');
  assert.equal(pdfBuffer.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.ok(pdfText.includes('%%EOF'));
  // Dynamic row height > 20pt rendered for wrapped cells (e.g. 30, 41, or 52)
  assert.match(pdfText, /0\.5 w\n50 [\d.]+ 495\.28 (?:30|41|52) re S/);
  // Long description wrapped rather than truncated after first ~28 chars
  assert.match(pdfText, /validasi integritas/);
  assert.match(pdfText, /financial-audit-/);
  // Spilled cleanly across multiple pages
  assert.match(pdfText, /Halaman 1 dari [2-9]/);
});
