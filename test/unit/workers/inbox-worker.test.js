const test = require('node:test');
const assert = require('node:assert/strict');
const { InboxWorker } = require('../../../src/workers/inbox-worker');

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

test('worker reports isHealthy() and runs throttled periodic stale recovery inside tick()', async () => {
  const calls = [];
  const worker = new InboxWorker({
    db: {
      recoverStaleEvents: (ms) => { calls.push(['events', ms]); return 1; },
      recoverStaleApprovals: (ms) => { calls.push(['approvals', ms]); return 0; },
      recoverStaleToolExecutions: (ms) => { calls.push(['tools', ms]); return 0; },
      recoverStaleTaskResponses: (ms) => { calls.push(['responses', ms]); return 0; },
      claimNextEvent: () => null
    },
    handler: async () => {},
    logger: { warn: () => {}, error: () => {} },
    staleMs: 30000,
    staleSweepIntervalMs: 5000
  });

  assert.equal(worker.isHealthy(), true);
  await worker.tick();
  assert.deepEqual(calls, [
    ['events', 30000],
    ['approvals', 30000],
    ['tools', 30000],
    ['responses', 30000]
  ]);

  // Immediate second tick is throttled
  await worker.tick();
  assert.equal(calls.length, 4);

  // Elapsed sweep interval triggers recovery again
  worker.lastStaleSweepAt = Date.now() - 6000;
  await worker.tick();
  assert.equal(calls.length, 8);

  await worker.stop();
  assert.equal(worker.isHealthy(), false);
});
