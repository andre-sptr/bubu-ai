const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InboxWorker } = require('../../../src/workers/inbox-worker');
const { cleanupStaleTempDirs } = require('../../../src/index');

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

test('worker supports bounded multi-slot concurrency across distinct chats and getStats()', async () => {
  const events = [
    { event_id: 'e1', chat_id: 'chat1@c.us', payload: { id: 1 }, attempts: 1 },
    { event_id: 'e2', chat_id: 'chat2@c.us', payload: { id: 2 }, attempts: 1 },
    { event_id: 'e3', chat_id: 'chat3@c.us', payload: { id: 3 }, attempts: 1 }
  ];
  const finished = [];
  let inFlight = 0;
  let maxObservedInFlight = 0;
  let activeSnapshot = 0;

  const worker = new InboxWorker({
    db: {
      claimNextEvent: () => events.shift() || null,
      finishEvent: (id) => { finished.push(id); },
      getQueueStats: () => ({ pendingCount: events.length, processingCount: inFlight, failedCount: 0, deadCount: 0, completedCount: finished.length, oldestPendingAt: null })
    },
    handler: async () => {
      inFlight += 1;
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
      activeSnapshot = Math.max(activeSnapshot, worker.activeCount);
      assert.equal(worker.running, true);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
    },
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    maxConcurrentJobs: 2
  });

  // First tick claims 2 of 3 events concurrently
  await worker.tick();
  assert.equal(maxObservedInFlight, 2);
  assert.equal(activeSnapshot, 2);
  assert.equal(worker.activeCount, 0);
  assert.equal(worker.running, false);
  assert.deepEqual(finished, ['e1', 'e2']);

  const stats = worker.getStats();
  assert.equal(stats.activeCount, 0);
  assert.equal(stats.maxConcurrentJobs, 2);
  assert.equal(stats.healthy, true);
  assert.equal(stats.queue.pendingCount, 1);

  // Second tick claims the remaining 3rd event
  await worker.tick();
  assert.deepEqual(finished, ['e1', 'e2', 'e3']);
  await worker.stop();
});

test('worker runs throttled periodic queue/history pruning in sweepStaleIfDue()', async () => {
  let pruneCalls = 0;
  const worker = new InboxWorker({
    db: {
      recoverStaleEvents: () => 0,
      pruneHistoryAndQueue: () => {
        pruneCalls += 1;
        return { deletedCompletedEvents: 1, deletedDeadEvents: 0, deletedModelUsage: 2, deletedAuditLogs: 0 };
      },
      claimNextEvent: () => null
    },
    handler: async () => {},
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    pruneIntervalMs: 10000
  });

  const t0 = 100000;
  worker.sweepStaleIfDue(t0);
  assert.equal(pruneCalls, 1);

  // Throttled before pruneIntervalMs elapses
  worker.sweepStaleIfDue(t0 + 5000);
  assert.equal(pruneCalls, 1);

  // Fires again after pruneIntervalMs
  worker.sweepStaleIfDue(t0 + 10000);
  assert.equal(pruneCalls, 2);
  await worker.stop();
});

test('cleanupStaleTempDirs removes stale bubu- temp dirs while preserving bubu-db- and recent dirs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-sweep-test-'));
  try {
    const staleDir = path.join(root, 'bubu-media-old');
    const dbDir = path.join(root, 'bubu-db-old');
    const freshDir = path.join(root, 'bubu-media-fresh');
    const otherDir = path.join(root, 'unrelated-old');
    fs.mkdirSync(staleDir);
    fs.mkdirSync(dbDir);
    fs.mkdirSync(freshDir);
    fs.mkdirSync(otherDir);

    const nowMs = Date.now();
    const oldTime = new Date(nowMs - 2 * 3600000);
    const freshTime = new Date(nowMs - 5 * 60000);
    fs.utimesSync(staleDir, oldTime, oldTime);
    fs.utimesSync(dbDir, oldTime, oldTime);
    fs.utimesSync(otherDir, oldTime, oldTime);
    fs.utimesSync(freshDir, freshTime, freshTime);

    const result = cleanupStaleTempDirs({ tmpRoot: root, prefix: 'bubu-', maxAgeMs: 3600000, nowMs });
    assert.equal(result.removed, 1);
    assert.equal(result.errors, 0);
    assert.equal(fs.existsSync(staleDir), false);
    assert.equal(fs.existsSync(dbDir), true);
    assert.equal(fs.existsSync(freshDir), true);
    assert.equal(fs.existsSync(otherDir), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
