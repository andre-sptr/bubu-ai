const test = require('node:test');
const assert = require('node:assert/strict');
const { InboxWorker } = require('../../src/workers/inbox-worker');

test('worker claims, handles, and completes an event', async () => {
  let completed = false;
  let handled = false;
  const db = {
    recoverStaleEvents: () => 0,
    claimNextEvent: () => ({ event_id: 'e1', payload: { text: 'hi' }, attempts: 1 }),
    finishEvent: () => { completed = true; },
    failEvent: () => assert.fail('should not fail')
  };
  const worker = new InboxWorker({ db, handler: async (payload) => { handled = payload.text === 'hi'; }, logger: { error: () => {} } });
  await worker.tick();
  assert.equal(handled, true);
  assert.equal(completed, true);
  await worker.stop();
});

test('worker schedules retry after handler failure', async () => {
  let failure = null;
  const db = {
    recoverStaleEvents: () => 0,
    claimNextEvent: () => ({ event_id: 'e2', payload: {}, attempts: 2 }),
    finishEvent: () => assert.fail('should not complete'),
    failEvent: (...args) => { failure = args; }
  };
  const worker = new InboxWorker({ db, handler: async () => { throw new Error('temporary'); }, logger: { error: () => {} } });
  await worker.tick();
  assert.equal(failure[0], 'e2');
  assert.equal(failure[1], 'internal: temporary');
  assert.equal(failure[2], 2);
  await worker.stop();
});


test('worker retries transient errors with bounded attempt policy', async () => {
  let failure = null;
  const worker = new InboxWorker({
    db: {
      claimNextEvent: () => ({ event_id: 'transient-1', chat_id: 'user@c.us', payload: {}, attempts: 2 }),
      failEvent: (...args) => { failure = args; }
    },
    handler: async () => { throw new Error('Model request timed out'); },
    logger: { warn: () => {}, error: () => {} },
    maxAttempts: 5
  });
  await worker.tick();
  assert.deepEqual(failure, ['transient-1', 'timeout: Model request timed out', 2, 5]);
  await worker.stop();
});

test('worker sends permanent errors directly to dead letter and notifies user', async () => {
  let failure = null;
  let notice = null;
  const worker = new InboxWorker({
    db: {
      claimNextEvent: () => ({ event_id: 'auth-1', chat_id: 'user@c.us', payload: {}, attempts: 1 }),
      failEvent: (...args) => { failure = args; }
    },
    handler: async () => { throw Object.assign(new Error('Unauthorized'), { response: { status: 401 } }); },
    onDeadLetter: async (value) => { notice = value; },
    logger: { warn: () => {}, error: () => {} }
  });
  await worker.tick();
  assert.equal(failure[2], 5);
  assert.equal(notice.category, 'authentication');
  assert.match(notice.message, /autentikasi/);
  await worker.stop();
});

test('worker never retries or sends a second notice for uncertain WAHA delivery', async () => {
  let failure = null;
  let notified = false;
  const worker = new InboxWorker({
    db: {
      claimNextEvent: () => ({ event_id: 'uncertain-1', chat_id: 'user@c.us', payload: {}, attempts: 1 }),
      failEvent: (...args) => { failure = args; }
    },
    handler: async () => {
      throw Object.assign(new Error('WAHA timed out'), {
        name: 'ResponseDeliveryError',
        deliveryStatus: 'uncertain'
      });
    },
    onDeadLetter: async () => { notified = true; },
    logger: { warn: () => {}, error: () => {} }
  });
  await worker.tick();
  assert.equal(failure[2], 5);
  assert.equal(notified, false);
  await worker.stop();
});

test('worker notifies after retryable error reaches max attempts', async () => {
  let notice = null;
  let failure = null;
  const worker = new InboxWorker({
    db: {
      claimNextEvent: () => ({ event_id: 'exhausted-1', chat_id: 'user@c.us', payload: {}, attempts: 5 }),
      failEvent: (...args) => { failure = args; }
    },
    handler: async () => { throw new Error('Model request timed out'); },
    onDeadLetter: async (value) => { notice = value; },
    logger: { warn: () => {}, error: () => {} },
    maxAttempts: 5
  });
  await worker.tick();
  assert.equal(failure[2], 5);
  assert.equal(notice.category, 'timeout');
  await worker.stop();
});


test('worker uses configured stale-event recovery window', () => {
  let recoveredWith = null;
  const worker = new InboxWorker({
    db: {
      recoverStaleEvents: (staleMs) => { recoveredWith = staleMs; return 0; }
    },
    handler: async () => {},
    logger: { warn: () => {} },
    staleMs: 45000
  });
  worker.start();
  assert.equal(recoveredWith, 45000);
  return worker.stop();
});
