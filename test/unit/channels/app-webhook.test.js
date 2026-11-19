const test = require('node:test');
const assert = require('node:assert/strict');
const { buildApp } = require('../../../src/app');
const { version } = require('../../../package.json');

function makeApp({ webhookToken = 'secret-token', dbReady = true } = {}) {
  const seen = new Set();
  const enqueued = [];
  const db = {
    db: {
      prepare: () => ({
        get: () => {
          if (!dbReady) throw new Error('db down');
          return { 1: 1 };
        }
      })
    },
    enqueueEvent: (item) => {
      if (seen.has(item.eventId)) return false;
      seen.add(item.eventId);
      enqueued.push(item);
      return true;
    }
  };
  const app = buildApp({
    config: { waha: { webhookToken, webhookHeader: 'x-webhook-token' } },
    db,
    logger: {
      level: 'silent',
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      child: function () { return this; }
    }
  });
  return { app, enqueued };
}

test('GET /health reports package.json version and service metadata', async (t) => {
  const { app } = makeApp();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'bubu-v2');
  assert.equal(body.version, version);
});

test('GET /ready reflects SQLite connectivity', async (t) => {
  const readyFixture = makeApp({ dbReady: true });
  t.after(() => readyFixture.app.close());
  const okRes = await readyFixture.app.inject({ method: 'GET', url: '/ready' });
  assert.equal(okRes.statusCode, 200);
  assert.deepEqual(okRes.json(), { ready: true });

  const downFixture = makeApp({ dbReady: false });
  t.after(() => downFixture.app.close());
  const errRes = await downFixture.app.inject({ method: 'GET', url: '/ready' });
  assert.equal(errRes.statusCode, 503);
  assert.deepEqual(errRes.json(), { ready: false });
});

test('POST /webhook enforces webhook token and deduplicates inbound events', async (t) => {
  const { app, enqueued } = makeApp({ webhookToken: 'top-secret' });
  t.after(() => app.close());

  const unauth = await app.inject({
    method: 'POST',
    url: '/webhook',
    payload: { event: 'message', payload: { id: 'evt-1', from: '6281@c.us', body: 'Halo' } }
  });
  assert.equal(unauth.statusCode, 401);
  assert.deepEqual(unauth.json(), { accepted: false });

  const first = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: { 'x-webhook-token': 'top-secret' },
    payload: { event: 'message', payload: { id: 'evt-1', from: '6281@c.us', body: 'Halo' } }
  });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { accepted: true, duplicate: false });

  const second = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: { 'x-webhook-token': 'top-secret' },
    payload: { event: 'message', payload: { id: 'evt-1', from: '6281@c.us', body: 'Halo' } }
  });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json(), { accepted: true, duplicate: true });
  assert.equal(enqueued.length, 1);

  const ignored = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: { 'x-webhook-token': 'top-secret' },
    payload: { event: 'message', payload: { id: 'evt-2', from: 'status@broadcast', body: 'Story' } }
  });
  assert.equal(ignored.statusCode, 200);
  assert.deepEqual(ignored.json(), { accepted: true, ignored: true });
});
