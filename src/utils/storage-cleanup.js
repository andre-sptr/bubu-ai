const fs = require('node:fs');
const path = require('node:path');

function removeEmptySubdir(dirPath, rootBoundary) {
  try {
    if (path.resolve(dirPath) === path.resolve(rootBoundary)) return;
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath);
    if (entries.length === 0) {
      fs.rmdirSync(dirPath);
    }
  } catch {
    // Best-effort cleanup of empty directories.
  }
}

function sweepStaleFilesInDir({ dirPath, nowMs, maxAgeMs, shouldKeepFile, removeEmptyDirs = true, boundaryDir = dirPath }) {
  let removed = 0;
  let skipped = 0;
  let errors = 0;

  if (!fs.existsSync(dirPath)) return { removed, skipped, errors };
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return { removed, skipped, errors: errors + 1 };
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const sub = sweepStaleFilesInDir({
        dirPath: fullPath,
        nowMs,
        maxAgeMs,
        shouldKeepFile,
        removeEmptyDirs,
        boundaryDir
      });
      removed += sub.removed;
      skipped += sub.skipped;
      errors += sub.errors;
      if (removeEmptyDirs) {
        removeEmptySubdir(fullPath, boundaryDir);
      }
      continue;
    }
    if (!entry.isFile()) continue;

    try {
      const stat = fs.statSync(fullPath);
      if (nowMs - stat.mtimeMs < maxAgeMs) {
        skipped += 1;
        continue;
      }
      if (shouldKeepFile && shouldKeepFile(path.resolve(fullPath))) {
        skipped += 1;
        continue;
      }
      fs.rmSync(fullPath, { force: true });
      removed += 1;
    } catch {
      errors += 1;
    }
  }

  return { removed, skipped, errors };
}

function cleanupOrphanStorageFiles({
  db = null,
  storageDir,
  maxAgeMs = 24 * 3600000,
  nowMs = Date.now(),
  logger = null
} = {}) {
  let removedInbound = 0;
  let removedOrphans = 0;
  let skipped = 0;
  let errors = 0;

  if (!storageDir || !fs.existsSync(storageDir)) {
    return { removedInbound, removedOrphans, skipped, errors };
  }

  const safeMaxAge = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) >= 0 ? Number(maxAgeMs) : 24 * 3600000;
  const resolvedRoot = path.resolve(storageDir);
  const inboundDir = path.join(resolvedRoot, 'inbound');

  if (fs.existsSync(inboundDir)) {
    const inboundRes = sweepStaleFilesInDir({
      dirPath: inboundDir,
      nowMs,
      maxAgeMs: safeMaxAge,
      shouldKeepFile: null,
      removeEmptyDirs: true,
      boundaryDir: inboundDir
    });
    removedInbound += inboundRes.removed;
    skipped += inboundRes.skipped;
    errors += inboundRes.errors;
  }

  let activePaths = null;
  if (typeof db?.listDocumentFilePaths === 'function') {
    try {
      const rawPaths = db.listDocumentFilePaths() || [];
      activePaths = new Set(rawPaths.map((p) => path.resolve(String(p || ''))).filter(Boolean));
    } catch (err) {
      errors += 1;
      logger?.warn?.({ error: err?.message }, 'Unable to query active document paths for storage orphan cleanup');
      activePaths = null;
    }
  }

  if (activePaths) {
    let topEntries = [];
    try {
      topEntries = fs.readdirSync(resolvedRoot, { withFileTypes: true });
    } catch (err) {
      errors += 1;
      logger?.warn?.({ storageDir: resolvedRoot, error: err?.message }, 'Storage cleanup directory read failed');
    }

    for (const entry of topEntries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'inbound') continue;
      if (entry.name !== 'generated' && !/^[0-9a-f]{2}$/i.test(entry.name)) continue;

      const targetDir = path.join(resolvedRoot, entry.name);
      const isGenerated = entry.name === 'generated';
      const sweepRes = sweepStaleFilesInDir({
        dirPath: targetDir,
        nowMs,
        maxAgeMs: safeMaxAge,
        shouldKeepFile: (resolvedFile) => activePaths.has(resolvedFile),
        removeEmptyDirs: !isGenerated,
        boundaryDir: resolvedRoot
      });
      removedOrphans += sweepRes.removed;
      skipped += sweepRes.skipped;
      errors += sweepRes.errors;
      if (!isGenerated) {
        removeEmptySubdir(targetDir, resolvedRoot);
      }
    }
  }

  if (removedInbound > 0 || removedOrphans > 0) {
    logger?.info?.({ removedInbound, removedOrphans, skipped, storageDir: resolvedRoot }, 'Cleaned up stale/orphan storage files');
  }

  return { removedInbound, removedOrphans, skipped, errors };
}

module.exports = { cleanupOrphanStorageFiles };
