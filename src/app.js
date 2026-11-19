const crypto = require('node:crypto');
const Fastify = require('fastify');
const helmet = require('@fastify/helmet');
const { version } = require('../package.json');
const { normalizeIncoming, normalizeSessionStatus } = require('./channels/waha/normalizer');
const { eventKey } = require('./agent/message-processor');

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

function buildApp({ config, db, logger, worker = null, sessionMonitor = null, isShuttingDown = null }) {
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

  const hasExtendedChecks = worker !== null || sessionMonitor !== null || isShuttingDown !== null;

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
    const wahaHealthy = sessionMonitor && typeof sessionMonitor.isDegraded === 'function'
      ? !sessionMonitor.isDegraded()
      : true;
    const ready = sqliteOk && !draining && workerHealthy && wahaHealthy;
    if (!ready) reply.code(503);
    return {
      ready,
      checks: {
        sqlite: sqliteOk,
        worker: workerHealthy,
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
        reply.code(200);
        return { accepted: true, event: 'session.status', status: statusEvent.status };
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
      const inserted = db.enqueueEvent({
        eventId: id,
        chatId: message.chatId,
        senderId: message.senderId || message.chatId,
        payload: rawBody
      });

      reply.code(200);
      return { accepted: true, duplicate: !inserted };
    });
  });

  return app;
}

module.exports = { buildApp };
