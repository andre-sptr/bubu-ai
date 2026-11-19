const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildApp } = require('../../../src/app');
const { WahaSessionMonitor } = require('../../../src/channels/waha/session-monitor');
const { version } = require('../../../package.json');

function makeApp({
  webhookToken = 'secret-token',
  webhookHmacSecret = '',
  dbReady = true,
  worker = null,
  sessionMonitor = null,
  isShuttingDown = null
} = {}) {
  const seen = new Set();
  const enqueued = [];
  const logs = [];
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
    config: {
      waha: {
        webhookToken,
        webhookHeader: 'x-webhook-token',
        webhookHmacSecret
      }
    },
    db,
    worker,
    sessionMonitor,
    isShuttingDown,
    logger: {
      level: 'silent',
      info: (...args) => logs.push({ level: 'info', args }),
      warn: (...args) => logs.push({ level: 'warn', args }),
      error: (...args) => logs.push({ level: 'error', args }),
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      child: function () { return this; }
    }
  });
  return { app, enqueued, logs };
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

test('POST /webhook validates token in onRequest before JSON parsing and handles array headers', async (t) => {
  const { app } = makeApp({ webhookToken: 'top-secret' });
  t.after(() => app.close());

  const malformedUnauth = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'x-webhook-token': 'wrong-token'
    },
    payload: '{not-valid-json'
  });
  assert.equal(malformedUnauth.statusCode, 401);
  assert.deepEqual(malformedUnauth.json(), { accepted: false });

  const multiHeader = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'x-webhook-token': ['top-secret', 'other']
    },
    payload: { event: 'message', payload: { id: 'evt-arr', from: '6281@c.us', body: 'Halo' } }
  });
  assert.equal(multiHeader.statusCode, 401);

  const singleArrayHeader = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'x-webhook-token': ['top-secret']
    },
    payload: { event: 'message', payload: { id: 'evt-arr-ok', from: '6281@c.us', body: 'Halo' } }
  });
  assert.equal(singleArrayHeader.statusCode, 200);
});

test('POST /webhook verifies optional HMAC-SHA512 signature over raw body bytes', async (t) => {
  const hmacSecret = 'super-hmac-secret';
  const { app, enqueued } = makeApp({ webhookToken: '', webhookHmacSecret: hmacSecret });
  t.after(() => app.close());

  const rawPayload = '{"event":"message","payload":{"id":"hmac-1","from":"6281@c.us","body":"Halo"}}';
  const validHex = crypto.createHmac('sha512', hmacSecret).update(rawPayload, 'utf8').digest('hex');

  const missingSig = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: { 'content-type': 'application/json' },
    payload: rawPayload
  });
  assert.equal(missingSig.statusCode, 401);

  const badSig = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'x-webhook-hmac': '0'.repeat(128)
    },
    payload: rawPayload
  });
  assert.equal(badSig.statusCode, 401);

  const wrongAlg = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'x-webhook-hmac': validHex,
      'x-webhook-hmac-algorithm': 'sha256'
    },
    payload: rawPayload
  });
  assert.equal(wrongAlg.statusCode, 401);

  const validRaw = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'x-webhook-hmac': validHex,
      'x-webhook-hmac-algorithm': 'sha512'
    },
    payload: rawPayload
  });
  assert.equal(validRaw.statusCode, 200);
  assert.deepEqual(validRaw.json(), { accepted: true, duplicate: false });

  const rawPayload2 = '{"event":"message","payload":{"id":"hmac-2","from":"6281@c.us","body":"Halo 2"}}';
  const validPrefixed = `sha512=${crypto.createHmac('sha512', hmacSecret).update(rawPayload2, 'utf8').digest('hex').toUpperCase()}`;
  const validPrefixRes = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'x-webhook-hmac': validPrefixed
    },
    payload: rawPayload2
  });
  assert.equal(validPrefixRes.statusCode, 200);
  assert.equal(enqueued.length, 2);
});

test('POST /webhook handles session.status events and filters non-message webhook events', async (t) => {
  const monitor = new WahaSessionMonitor({ session: 'default' });
  const { app, enqueued, logs } = makeApp({ webhookToken: 'top-secret', sessionMonitor: monitor });
  t.after(() => app.close());

  const statusRes = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: { 'x-webhook-token': 'top-secret' },
    payload: {
      event: 'session.status',
      session: 'default',
      payload: { name: 'default', status: 'WORKING' }
    }
  });
  assert.equal(statusRes.statusCode, 200);
  assert.deepEqual(statusRes.json(), { accepted: true, event: 'session.status', status: 'WORKING' });
  assert.equal(monitor.status, 'WORKING');
  assert.equal(monitor.isHealthy(), true);
  assert.equal(enqueued.length, 0);
  assert.ok(logs.some((entry) => entry.level === 'info'));

  for (const eventType of ['message.ack', 'message.edited', 'message.reaction', 'message.any', 'group.v2.participants']) {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'x-webhook-token': 'top-secret' },
      payload: {
        event: eventType,
        payload: { id: `evt-${eventType}`, from: '6281@c.us', body: 'Ignored' }
      }
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { accepted: true, ignored: true, eventType });
  }
  assert.equal(enqueued.length, 0);

  const implicitRes = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: { 'x-webhook-token': 'top-secret' },
    payload: { payload: { id: 'evt-implicit', from: '6281@c.us', body: 'Legacy payload' } }
  });
  assert.equal(implicitRes.statusCode, 200);
  assert.deepEqual(implicitRes.json(), { accepted: true, duplicate: false });
  assert.equal(enqueued.length, 1);
});

test('GET /ready reports detailed checks when worker, sessionMonitor, or isShuttingDown are supplied', async (t) => {
  const monitor = new WahaSessionMonitor({ session: 'default', status: 'WORKING' });
  let workerHealthy = true;
  let draining = false;
  const fixture = makeApp({
    worker: { isHealthy: () => workerHealthy },
    sessionMonitor: monitor,
    isShuttingDown: () => draining
  });
  t.after(() => fixture.app.close());

  const ok = await fixture.app.inject({ method: 'GET', url: '/ready' });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), {
    ready: true,
    checks: { sqlite: true, worker: true, waha: true, draining: false }
  });

  monitor.update({ status: 'SCAN_QR_CODE' });
  const wahaDown = await fixture.app.inject({ method: 'GET', url: '/ready' });
  assert.equal(wahaDown.statusCode, 503);
  assert.deepEqual(wahaDown.json(), {
    ready: false,
    checks: { sqlite: true, worker: true, waha: false, draining: false }
  });

  monitor.update({ status: 'WORKING' });
  workerHealthy = false;
  const workerDown = await fixture.app.inject({ method: 'GET', url: '/ready' });
  assert.equal(workerDown.statusCode, 503);
  assert.deepEqual(workerDown.json(), {
    ready: false,
    checks: { sqlite: true, worker: false, waha: true, draining: false }
  });

  workerHealthy = true;
  draining = true;
  const shutting = await fixture.app.inject({ method: 'GET', url: '/ready' });
  assert.equal(shutting.statusCode, 503);
  assert.deepEqual(shutting.json(), {
    ready: false,
    checks: { sqlite: true, worker: true, waha: true, draining: true }
  });
});
