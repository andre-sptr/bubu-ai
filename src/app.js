const Fastify = require('fastify');
const helmet = require('@fastify/helmet');

function buildApp({ config, db, logger }) {
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
    version: '2.0.0',
    database: 'sqlite',
    provider: 'sumopod'
  }));

  app.get('/ready', async (_request, reply) => {
    try {
      db.db.prepare('SELECT 1').get();
      return { ready: true };
    } catch {
      reply.code(503);
      return { ready: false };
    }
  });

  app.post('/webhook', async (request, reply) => {
    if (config.waha.webhookToken) {
      const supplied = request.headers[config.waha.webhookHeader];
      if (supplied !== config.waha.webhookToken) {
        reply.code(401);
        return { accepted: false };
      }
    }

    const { normalizeIncoming } = require('./channels/waha/client');
    const { eventKey } = require('./agent/message-processor');
    const message = normalizeIncoming(request.body || {});

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
      payload: request.body
    });

    reply.code(200);
    return { accepted: true, duplicate: !inserted };
  });

  return app;
}

module.exports = { buildApp };
