require('dotenv').config();
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
  const waha = new WahaClient(config.waha);
  const sessionMonitor = new WahaSessionMonitor({ session: config.waha.session });
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
    handler: (payload) => processor.process(payload),
    logger,
    pollMs: config.inbox.pollMs,
    maxAttempts: config.inbox.maxAttempts,
    staleMs: config.inbox.staleMs,
    onDeadLetter: async ({ event, message, category }) => {
      const incoming = normalizeIncoming(event.payload || {});
      const chatId = normalizeJid(event.chat_id || incoming.chatId);
      if (!chatId) return;
      if (chatId !== config.ownerJid && !chatId.endsWith('@g.us')) return;
      if (chatId.endsWith('@g.us') && config.groupPolicy !== 'all') return;
      const mode = db.getChatOutputMode({
        chatId,
        requesterId: config.ownerJid,
        defaultMode: config.media.voiceReplyDefault ? 'both' : 'text'
      });
      logger.warn({ eventId: event.event_id, chatId, category }, 'Sending terminal processing notice');
      await responseHandler.sendAssistantResponse(message, chatId, mode);
    }
  }).start();
  const reminderWorker = new ReminderWorker({ db, waha, responseHandler, logger });
  reminderWorker.start();

  const app = buildApp({
    config,
    db,
    logger,
    worker,
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
    await app.close();
    await reminderWorker.stop();
    await worker.stop();
    waha.close?.();
    db.close();
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('Bubu startup failed:', error);
  process.exit(1);
});
