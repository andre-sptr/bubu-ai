const crypto = require('node:crypto');
const Fastify = require('fastify');
const helmet = require('@fastify/helmet');
const { version } = require('../package.json');
const { normalizeJid } = require('./config/env');
const { normalizeIncoming, normalizeSessionStatus, normalizePollVote } = require('./channels/waha/normalizer');
const { eventKey } = require('./agent/message-processor');

const OWNER_PRIORITY_COMMANDS = new Set(['/approve', '/deny', '/approvals', '/polls', '/status', '/queue']);

function classifyEventPriority(message, ownerJid = '', ownerLid = '') {
  const chatId = normalizeJid(message?.chatId || '');
  const senderId = normalizeJid(message?.senderId || chatId);
  const normalizedOwner = normalizeJid(ownerJid || '');
  const normalizedOwnerLid = normalizeJid(ownerLid || '');
  const isGroup = chatId.endsWith('@g.us');
  const isOwner = Boolean(
    (normalizedOwner && senderId === normalizedOwner) ||
    (normalizedOwnerLid && senderId === normalizedOwnerLid)
  );
  const text = String(message?.text || message?.bodyText || '').trim();
  const cmd = text.startsWith('/') ? text.split(/\s+/, 1)[0].toLowerCase() : '';

  if (isOwner && OWNER_PRIORITY_COMMANDS.has(cmd)) return 1;
  if (isGroup) return 5;
  return 2;
}

function extractHeaderString(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.length === 1 && typeof value[0] === 'string' ? value[0] : '';
  }
  return '';
}

function timingSafeEqualSha256(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || !supplied || !expected) {
    return false;
  }
  const suppliedDigest = crypto.createHash('sha256').update(supplied, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(suppliedDigest, expectedDigest);
}

function verifyHmacSha512({ rawBody, secret, signatureHeader, algorithmHeader }) {
  if (!secret) return true;
  if (!Buffer.isBuffer(rawBody)) return false;
  if (algorithmHeader !== undefined) {
    const algorithm = extractHeaderString(algorithmHeader).trim().toLowerCase();
    if (algorithm !== 'sha512') return false;
  }
  const rawSignature = extractHeaderString(signatureHeader).trim();
  if (!rawSignature) return false;
  const hexSignature = rawSignature.toLowerCase().startsWith('sha512=')
    ? rawSignature.slice(7).trim().toLowerCase()
    : rawSignature.toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(hexSignature)) return false;
  const expectedHex = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hexSignature, 'hex'), Buffer.from(expectedHex, 'hex'));
}

function buildApp({ config, db, logger, worker = null, reminderWorker = null, sessionMonitor = null, isShuttingDown = null, pipelineEvents = null }) {
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: 15000,
    trustProxy: false
  });

  app.register(helmet, { contentSecurityPolicy: false });

  app.get('/health', async () => ({
    ok: true,
    service: 'bubu-v2',
    version,
    database: 'sqlite',
    provider: 'sumopod'
  }));

  const hasExtendedChecks = worker !== null || reminderWorker !== null || sessionMonitor !== null || isShuttingDown !== null;

  app.get('/ready', async (_request, reply) => {
    let sqliteOk = false;
    try {
      db.db.prepare('SELECT 1').get();
      sqliteOk = true;
    } catch {
      sqliteOk = false;
    }

    if (!hasExtendedChecks) {
      if (!sqliteOk) {
        reply.code(503);
        return { ready: false };
      }
      return { ready: true };
    }

    const draining = typeof isShuttingDown === 'function'
      ? Boolean(isShuttingDown())
      : Boolean(isShuttingDown);
    const workerHealthy = worker && typeof worker.isHealthy === 'function'
      ? worker.isHealthy() !== false
      : true;
    const reminderHealthy = reminderWorker && typeof reminderWorker.isHealthy === 'function'
      ? reminderWorker.isHealthy() !== false
      : true;
    const wahaHealthy = sessionMonitor && typeof sessionMonitor.isDegraded === 'function'
      ? !sessionMonitor.isDegraded()
      : true;
    const ready = sqliteOk && !draining && workerHealthy && reminderHealthy && wahaHealthy;
    if (!ready) reply.code(503);
    return {
      ready,
      checks: {
        sqlite: sqliteOk,
        worker: workerHealthy,
        ...(reminderWorker !== null ? { reminderWorker: reminderHealthy } : {}),
        waha: wahaHealthy,
        draining
      }
    };
  });

  app.register(async function webhookRoutes(scope) {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
      request.rawBody = body;
      if (!body || body.length === 0) {
        const err = new Error('Body cannot be empty when content-type is set to application/json');
        err.statusCode = 400;
        return done(err);
      }
      try {
        return done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        err.statusCode = 400;
        return done(err);
      }
    });

    scope.post('/webhook', {
      onRequest: async (request, reply) => {
        const webhookToken = config?.waha?.webhookToken;
        if (!webhookToken) return;
        const headerName = String(config?.waha?.webhookHeader || 'x-webhook-token').toLowerCase();
        const supplied = extractHeaderString(request.headers?.[headerName]);
        if (!timingSafeEqualSha256(supplied, webhookToken)) {
          reply.code(401).send({ accepted: false });
          return reply;
        }
      }
    }, async (request, reply) => {
      const hmacSecret = config?.waha?.webhookHmacSecret;
      if (hmacSecret) {
        const validHmac = verifyHmacSha512({
          rawBody: request.rawBody,
          secret: hmacSecret,
          signatureHeader: request.headers?.['x-webhook-hmac'],
          algorithmHeader: request.headers?.['x-webhook-hmac-algorithm']
        });
        if (!validHmac) {
          reply.code(401);
          return { accepted: false };
        }
      }

      const rawBody = request.body || {};
      if (sessionMonitor && rawBody.me && typeof rawBody.me === 'object') {
        try {
          sessionMonitor.updateBotIdentity?.(rawBody.me);
        } catch (err) {
          logger?.warn?.({ error: err?.message }, 'Failed to update WAHA bot identity from webhook');
        }
      }
      const explicitEvent = rawBody.event !== undefined && rawBody.event !== null
        ? String(rawBody.event).trim()
        : '';

      if (explicitEvent === 'session.status') {
        const statusEvent = normalizeSessionStatus(rawBody);
        const updateResult = sessionMonitor?.update?.({
          session: statusEvent.session,
          status: statusEvent.status
        });
        if (!updateResult || updateResult.changed) {
          logger?.info?.({
            event: 'session.status',
            session: statusEvent.session,
            previousStatus: updateResult?.previousStatus || null,
            status: statusEvent.status,
            degraded: updateResult?.degraded ?? null
          }, 'WAHA session status updated');
        }
        pipelineEvents?.emitHealth?.({
          waha: typeof sessionMonitor?.snapshot === 'function'
            ? (() => {
                const snap = sessionMonitor.snapshot();
                return { session: snap.session, status: snap.status, healthy: snap.healthy };
              })()
            : { session: statusEvent.session, status: statusEvent.status, healthy: statusEvent.status === 'WORKING' }
        });
        reply.code(200);
        return { accepted: true, event: 'session.status', status: statusEvent.status };
      }

      if (explicitEvent === 'poll.vote') {
        const vote = normalizePollVote(rawBody);
        if (!vote || !vote.pollMessageId || !vote.voterId) {
          reply.code(200);
          return { accepted: true, ignored: true, eventType: 'poll.vote' };
        }
        let recorded = false;
        try {
          recorded = Boolean(db.recordPollVote?.(vote));
        } catch (err) {
          logger?.warn?.({ error: err?.message, pollMessageId: vote.pollMessageId }, 'Failed to persist poll vote');
        }
        reply.code(200);
        return {
          accepted: true,
          event: 'poll.vote',
          recorded,
          pollMessageId: vote.pollMessageId
        };
      }

      if (explicitEvent && explicitEvent !== 'message') {
        reply.code(200);
        return { accepted: true, ignored: true, eventType: explicitEvent };
      }

      const message = normalizeIncoming(rawBody);

      if (!message.chatId || message.fromMe ||
          message.chatId.endsWith('@broadcast') ||
          message.chatId.endsWith('@newsletter')) {
        reply.code(200);
        return { accepted: true, ignored: true };
      }

      const id = eventKey(message);
      const ownerLid = typeof sessionMonitor?.getOwnerLid === 'function' ? sessionMonitor.getOwnerLid() : '';
      const priority = classifyEventPriority(message, config?.ownerJid || '', ownerLid);
      const inserted = db.enqueueEvent({
        eventId: id,
        chatId: message.chatId,
        senderId: message.senderId || message.chatId,
        payload: rawBody,
        priority
      });
      if (inserted) {
        pipelineEvents?.emitStage?.({
          runId: id.slice(0, 12),
          stage: 'ingress',
          phase: 'completed',
          label: 'Pesan WhatsApp diterima & diverifikasi webhook',
          chatId: message.chatId,
          scope: message.chatId.endsWith('@g.us') ? 'group' : 'personal',
          meta: {
            priority,
            inputKind: message.hasMedia
              ? (message.media?.isPtt ? 'voice_note' : 'media')
              : (message.quote?.present ? 'quote' : 'text'),
            charCount: String(message.text || '').length,
            isGroup: message.chatId.endsWith('@g.us')
          }
        });
      }

      reply.code(200);
      return { accepted: true, duplicate: !inserted };
    });
  });

  if (config?.visualizer?.enabled !== false) {
    const sseClients = new Set();
    const maxSseClients = Math.max(1, Number(config?.visualizer?.maxSseClients || 30));
    const accessToken = String(config?.visualizer?.accessToken || '').trim();

    const isVisualizerAuthorized = (request) => {
      if (!accessToken) return true;
      const headerToken = extractHeaderString(request.headers?.['x-visualizer-token']).trim();
      const authHeader = extractHeaderString(request.headers?.authorization).trim();
      const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : '';
      const queryToken = typeof request.query?.token === 'string' ? request.query.token.trim() : '';
      const supplied = headerToken || bearerToken || queryToken;
      return timingSafeEqualSha256(supplied, accessToken);
    };

    const buildSnapshotPayload = () => {
      let wahaInfo = {
        session: config?.waha?.session || 'default',
        status: 'UNKNOWN',
        healthy: true
      };
      if (typeof sessionMonitor?.snapshot === 'function') {
        const snap = sessionMonitor.snapshot();
        wahaInfo = {
          session: snap.session,
          status: snap.status,
          healthy: Boolean(snap.healthy)
        };
      }

      let workerInfo = {
        activeCount: 0,
        maxConcurrentJobs: 1,
        healthy: true,
        queue: null
      };
      if (typeof worker?.getStats === 'function') {
        workerInfo = worker.getStats();
      } else if (typeof db?.getQueueStats === 'function') {
        try {
          workerInfo.queue = db.getQueueStats();
        } catch {
          workerInfo.queue = null;
        }
      }

      let telemetry24h = {
        windowHours: 24,
        totalCalls: 0,
        successCalls: 0,
        failedCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        avgLatencyMs: 0,
        byTier: {}
      };
      if (typeof db?.getTelemetrySummary === 'function') {
        try {
          const summary = db.getTelemetrySummary({ windowHours: 24 });
          if (summary && typeof summary === 'object') {
            telemetry24h = {
              windowHours: summary.windowHours ?? 24,
              totalCalls: Number(summary.totalCalls || 0),
              successCalls: Number(summary.successCalls || 0),
              failedCalls: Number(summary.failedCalls || 0),
              totalInputTokens: Number(summary.totalInputTokens || 0),
              totalOutputTokens: Number(summary.totalOutputTokens || 0),
              avgLatencyMs: Number(summary.avgLatencyMs || 0),
              byTier: summary.byTier || {}
            };
          }
        } catch {
          // Keep safe zero defaults if telemetry summary query fails.
        }
      }

      const busData = typeof pipelineEvents?.getSnapshotData === 'function'
        ? pipelineEvents.getSnapshotData()
        : { activeRuns: [], recentRuns: [], recentEvents: [] };

      return {
        service: {
          name: 'bubu-v2',
          version,
          uptimeSec: Math.floor(process.uptime())
        },
        waha: wahaInfo,
        worker: workerInfo,
        telemetry24h,
        ...busData
      };
    };

    app.get('/api/visualizer/snapshot', async (request, reply) => {
      if (!isVisualizerAuthorized(request)) {
        reply.code(401);
        return { error: 'Unauthorized' };
      }
      reply.header('Cache-Control', 'no-store');
      return buildSnapshotPayload();
    });

    app.get('/api/visualizer/stream', async (request, reply) => {
      if (!isVisualizerAuthorized(request)) {
        reply.code(401);
        return { error: 'Unauthorized' };
      }
      if (sseClients.size >= maxSseClients) {
        reply.code(503);
        return { error: 'Too many visualizer stream connections' };
      }

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      const writeSse = (eventName, payload, id = null) => {
        if (res.writableEnded || res.destroyed) return;
        let chunk = '';
        if (id !== null && id !== undefined) chunk += `id: ${id}\n`;
        chunk += `event: ${eventName}\n`;
        chunk += `data: ${JSON.stringify(payload)}\n\n`;
        res.write(chunk);
      };

      writeSse('snapshot', buildSnapshotPayload());

      const onStage = (ev) => writeSse('stage', ev, ev?.seq);
      const onHealth = (ev) => writeSse('health', ev);
      pipelineEvents?.on?.('stage', onStage);
      pipelineEvents?.on?.('health', onHealth);

      const heartbeat = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) {
          res.write(`: heartbeat ${Date.now()}\n\n`);
        }
      }, 20000);
      heartbeat.unref?.();

      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        pipelineEvents?.off?.('stage', onStage);
        pipelineEvents?.off?.('health', onHealth);
        sseClients.delete(cleanup);
        if (!res.writableEnded) {
          try {
            res.end();
          } catch {
            // Ignore socket end errors during teardown.
          }
        }
      };

      sseClients.add(cleanup);
      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);
    });

    app.addHook('onClose', async () => {
      for (const closeClient of [...sseClients]) {
        closeClient();
      }
    });
  }

  return app;
}

module.exports = { buildApp, classifyEventPriority };
