require('dotenv').config();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pino = require('pino');
const { loadConfig, normalizeJid } = require('./config/env');
const { DatabaseStore } = require('./db/database');
const { SumopodProvider } = require('./providers/sumopod');
const { ModelRouter } = require('./agent/model-router');
const { registerAllTools } = require('./agent/tool-registry');
const { ApprovalManager } = require('./agent/approval-manager');
const { AgentRuntime } = require('./agent/runtime');
const { WahaClient } = require('./channels/waha/client');
const { WahaSessionMonitor } = require('./channels/waha/session-monitor');
const { normalizeIncoming } = require('./channels/waha/normalizer');
const { ResponseHandler } = require('./channels/response-handler');
const { MessageProcessor } = require('./agent/message-processor');
const { InboxWorker } = require('./workers/inbox-worker');
const { ReminderWorker } = require('./workers/reminder-worker');
const { buildApp } = require('./app');
const { DocumentService } = require('./documents/document-service');
const { WebSearchService, WebFetchService } = require('./web/web-service');
const { MemoryService } = require('./memory/memory-service');
const { MediaIntelligenceService } = require('./media/media-service');
const { cleanupOrphanStorageFiles } = require('./utils/storage-cleanup');

function cleanupStaleTempDirs({
  tmpRoot = os.tmpdir(),
  prefix = 'bubu-',
  maxAgeMs = 3600000,
  nowMs = Date.now(),
  logger
} = {}) {
  let removed = 0;
  let skipped = 0;
  let errors = 0;
  try {
    if (!tmpRoot || !fs.existsSync(tmpRoot)) {
      return { removed, skipped, errors };
    }
    const safePrefix = String(prefix || 'bubu-');
    const safeMaxAge = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) >= 0 ? Number(maxAgeMs) : 3600000;
    const entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(safePrefix)) continue;
      if (entry.name.startsWith('bubu-db-')) {
        skipped += 1;
        continue;
      }
      const fullPath = path.join(tmpRoot, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (nowMs - stat.mtimeMs < safeMaxAge) {
          skipped += 1;
          continue;
        }
        fs.rmSync(fullPath, { recursive: true, force: true });
        removed += 1;
      } catch (err) {
        errors += 1;
        logger?.warn?.({ dir: fullPath, error: err?.message }, 'Failed to clean up stale temp directory');
      }
    }
    if (removed > 0) {
      logger?.info?.({ removed, skipped, tmpRoot }, 'Cleaned up stale temporary directories');
    }
  } catch (err) {
    errors += 1;
    logger?.warn?.({ tmpRoot, error: err?.message }, 'Temp directory sweep failed');
  }
  return { removed, skipped, errors };
}

function createDeadLetterNotifier({ config, db, waha, responseHandler, logger }) {
  return async ({ event, message, category }) => {
    const incoming = normalizeIncoming(event?.payload || {});
    let chatId = normalizeJid(event?.chat_id || incoming.chatId);
    if (!chatId) return;
    if (chatId.endsWith('@lid') && typeof waha?.resolveLid === 'function') {
      try {
        const resolved = normalizeJid(await waha.resolveLid(chatId));
        if (resolved) chatId = resolved;
      } catch (err) {
        logger?.warn?.({ eventId: event?.event_id, chatId, error: err?.message }, 'Unable to resolve dead-letter chat LID');
      }
    }
    if (chatId !== config.ownerJid && !chatId.endsWith('@g.us')) return;
    if (chatId.endsWith('@g.us') && config.groupPolicy !== 'all') return;
    const mode = db.getChatOutputMode({
      chatId,
      requesterId: config.ownerJid,
      defaultMode: config.media?.voiceReplyDefault ? 'both' : 'text'
    });
    logger?.warn?.({ eventId: event?.event_id, chatId, category }, 'Sending terminal processing notice');
    await responseHandler.sendAssistantResponse(message, chatId, mode);
  };
}

async function main() {
  const config = loadConfig();
  const logger = pino({
    level: config.logLevel,
    redact: [
      'err.config.headers',
      'err.response.config.headers',
      'err.config.data',
      '*.headers.authorization',
      '*.headers["x-api-key"]',
      '*.apiKey',
      '*.webhookToken',
      '*.webhookHmacSecret'
    ]
  });
  const db = new DatabaseStore(config.databasePath);
  db.recoverStaleApprovals();
  db.recoverStaleToolExecutions();
  db.recoverStaleTaskResponses();
  cleanupStaleTempDirs({ logger });
  cleanupOrphanStorageFiles({ db, storageDir: config.storageDir, logger });
  const waha = new WahaClient(config.waha);
  const sessionMonitor = new WahaSessionMonitor({ session: config.waha.session, botJid: config.botJid });
  const syncResult = await sessionMonitor.syncFromWaha(waha, { logger });
  if (syncResult?.ok) {
    logger.info({
      wahaSession: syncResult.snapshot.session,
      wahaStatus: syncResult.snapshot.status,
      botJid: syncResult.snapshot.botJid || config.botJid || null,
      botLid: syncResult.snapshot.botLid || null
    }, 'WAHA session synchronized at startup');
  }
  const provider = new SumopodProvider(config.sumopod);
  const router = new ModelRouter(config.sumopod.models);
  router.assertReady();
  const memoryService = new MemoryService({ db, provider, router, logger });
  const documentService = new DocumentService({
    db,
    wahaConfig: config.waha,
    storageDir: config.storageDir,
    maxFileBytes: config.documents.maxFileBytes,
    maxExtractChars: config.documents.maxExtractChars,
    ocrEnabled: config.documents.ocrEnabled,
    maxPdfOcrPages: config.documents.maxPdfOcrPages,
    pdfRenderDpi: config.documents.pdfRenderDpi,
    pdftoppmBin: config.documents.pdftoppmBin,
    ghostscriptBin: config.documents.ghostscriptBin,
    tesseractBin: config.media.tesseractBin,
    ffmpegBin: config.media.ffmpegBin,
    memoryService,
    logger
  });
  const mediaService = new MediaIntelligenceService({
    wahaConfig: config.waha,
    storageDir: config.storageDir,
    maxFileBytes: config.media.maxFileBytes,
    visionEnabled: config.media.visionEnabled,
    maxVisionBytes: config.media.maxVisionBytes,
    maxVisionDimension: config.media.maxVisionDimension,
    maxAudioSeconds: config.media.maxAudioSeconds,
    maxVideoSeconds: config.media.maxVideoSeconds,
    maxVideoFrames: config.media.maxVideoFrames,
    tesseractBin: config.media.tesseractBin,
    ffmpegBin: config.media.ffmpegBin,
    ffprobeBin: config.media.ffprobeBin,
    whisperBin: config.media.whisperBin,
    whisperModelPath: config.media.whisperModelPath,
    whisperLanguage: config.media.whisperLanguage,
    whisperVadModelPath: config.media.whisperVadModelPath,
    piperBin: config.media.piperBin,
    piperModelPath: config.media.piperModelPath,
    logger
  });
  const responseHandler = new ResponseHandler({ waha, mediaService, config, logger });
  const approvalManager = new ApprovalManager({
    db, waha, responseHandler, ownerJid: config.ownerJid,
    ttlMinutes: config.agent.approvalTtlMinutes
  });
  const webSearch = config.search.tavilyApiKey
    ? new WebSearchService({ apiKey: config.search.tavilyApiKey, maxResults: config.search.maxResults })
    : null;
  const webFetch = new WebFetchService();
  const tools = registerAllTools({
    db,
    approvalManager,
    waha,
    responseHandler,
    sessionMonitor,
    memoryService,
    documentService,
    webSearch,
    webFetch
  });
  const agent = new AgentRuntime({ provider, router, tools, db, config, logger });
  const processor = new MessageProcessor({
    config, db, waha, responseHandler, sessionMonitor, agent, approvalManager, provider, router,
    documentService, memoryService, mediaService, logger
  });

  let shuttingDown = false;
  const worker = new InboxWorker({
    db,
    handler: (payload, meta) => processor.process(payload, meta),
    logger,
    pollMs: config.inbox.pollMs,
    maxAttempts: config.inbox.maxAttempts,
    staleMs: config.inbox.staleMs,
    maxConcurrentJobs: config.agent.maxConcurrentJobs,
    storageDir: config.storageDir,
    onDeadLetter: createDeadLetterNotifier({ config, db, waha, responseHandler, logger })
  }).start();
  processor.worker = worker;
  const reminderWorker = new ReminderWorker({
    db,
    waha,
    responseHandler,
    logger,
    timezone: config.appTimezone,
    briefingEnabled: config.briefing?.enabled,
    briefingHour: config.briefing?.hour,
    ownerJid: config.ownerJid
  });
  reminderWorker.start();

  const sessionSyncTimer = setInterval(() => {
    if (shuttingDown) return;
    sessionMonitor.syncFromWaha(waha, { logger }).catch((err) => {
      logger.warn({ error: err?.message }, 'Periodic WAHA session sync failed');
    });
  }, 5 * 60 * 1000);
  sessionSyncTimer.unref?.();

  const app = buildApp({
    config,
    db,
    logger,
    worker,
    reminderWorker,
    sessionMonitor,
    isShuttingDown: () => shuttingDown
  });
  await app.listen({ host: config.host, port: config.port });
  logger.info({
    host: config.host,
    port: config.port,
    database: config.databasePath,
    groupPolicy: config.groupPolicy
  }, 'Bubu v2 started');

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down Bubu v2');
    clearInterval(sessionSyncTimer);
    const forceExitTimer = setTimeout(() => {
      logger.error({ signal }, 'Forced exit after shutdown timeout');
      process.exit(1);
    }, 12000);
    forceExitTimer.unref?.();
    try {
      await app.close();
      await reminderWorker.stop();
      await worker.stop();
      provider.close?.();
      waha.close?.();
      db.close();
    } finally {
      clearTimeout(forceExitTimer);
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason instanceof Error ? reason : new Error(String(reason)) }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal?.({ err }, 'Uncaught exception; shutting down');
    shutdown('uncaughtException').catch(() => process.exit(1));
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Bubu startup failed:', error);
    process.exit(1);
  });
}

module.exports = { main, cleanupStaleTempDirs, cleanupOrphanStorageFiles, createDeadLetterNotifier };
