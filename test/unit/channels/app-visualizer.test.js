const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { buildApp } = require('../../../src/app');
const { PipelineEventBus } = require('../../../src/telemetry/pipeline-events');
const { WahaSessionMonitor } = require('../../../src/channels/waha/session-monitor');

function makeVisualizerApp({ accessToken = '', maxSseClients = 5 } = {}) {
  const seen = new Set();
  const pipelineEvents = new PipelineEventBus({ salt: 'test-salt' });
  const sessionMonitor = new WahaSessionMonitor({
    session: 'Bubu',
    status: 'WORKING',
    botJid: '628999888777@c.us',
    botLid: '123456789@lid'
  });

  const db = {
    db: { prepare: () => ({ get: () => ({ 1: 1 }) }) },
    enqueueEvent: (item) => {
      if (seen.has(item.eventId)) return false;
      seen.add(item.eventId);
      return true;
    },
    getQueueStats: () => ({
      pendingCount: 0,
      processingCount: 0,
      failedCount: 0,
      deadCount: 0,
      completedCount: 3,
      oldestPendingAt: null
    }),
    getTelemetrySummary: () => ({
      windowHours: 24,
      totalCalls: 4,
      successCalls: 4,
      failedCalls: 0,
      totalInputTokens: 2000,
      totalOutputTokens: 500,
      avgLatencyMs: 420,
      estimatedCostUsd: 0.05,
      estimatedCostIdr: 825,
      byTier: { balanced: { calls: 4, successCalls: 4, inputTokens: 2000, outputTokens: 500, avgLatencyMs: 420 } }
    })
  };

  const app = buildApp({
    config: {
      waha: { webhookToken: 'hook-secret', webhookHeader: 'x-webhook-token', session: 'Bubu' },
      visualizer: { enabled: true, accessToken, maxSseClients }
    },
    db,
    sessionMonitor,
    pipelineEvents,
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

  return { app, pipelineEvents };
}

test('GET /api/visualizer/snapshot returns sanitized telemetry without botJids or billing estimates', async (t) => {
  const { app } = makeVisualizerApp();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/visualizer/snapshot' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.service.name, 'bubu-v2');
  assert.equal(body.waha.session, 'Bubu');
  assert.equal(body.waha.status, 'WORKING');
  assert.equal(body.waha.botJid, undefined);
  assert.equal(body.waha.botLid, undefined);
  assert.equal(body.telemetry24h.totalCalls, 4);
  assert.equal(body.telemetry24h.estimatedCostUsd, undefined);
  assert.equal(JSON.stringify(body).includes('628999888777'), false);
});

test('POST /webhook emits sanitized ingress stage event to PipelineEventBus', async (t) => {
  const { app, pipelineEvents } = makeVisualizerApp();
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: { 'x-webhook-token': 'hook-secret' },
    payload: {
      event: 'message',
      payload: { id: 'evt-vis-1', from: '628123456789@c.us', body: 'Rahasia isi pesan pribadi' }
    }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { accepted: true, duplicate: false });

  const snap = pipelineEvents.getSnapshotData();
  assert.equal(snap.activeRuns.length, 1);
  assert.equal(snap.recentEvents[0].stage, 'ingress');
  assert.equal(snap.recentEvents[0].meta.inputKind, 'text');
  assert.equal(JSON.stringify(snap).includes('Rahasia isi pesan pribadi'), false);
  assert.equal(JSON.stringify(snap).includes('628123456789'), false);
});

test('visualizer routes enforce optional accessToken when configured', async (t) => {
  const { app } = makeVisualizerApp({ accessToken: 'vis-secret-token' });
  t.after(() => app.close());

  const denied = await app.inject({ method: 'GET', url: '/api/visualizer/snapshot' });
  assert.equal(denied.statusCode, 401);

  const allowedHeader = await app.inject({
    method: 'GET',
    url: '/api/visualizer/snapshot',
    headers: { 'x-visualizer-token': 'vis-secret-token' }
  });
  assert.equal(allowedHeader.statusCode, 200);

  const allowedQuery = await app.inject({
    method: 'GET',
    url: '/api/visualizer/snapshot?token=vis-secret-token'
  });
  assert.equal(allowedQuery.statusCode, 200);
});

test('GET /api/visualizer/stream serves SSE headers, initial snapshot, and live stage events', async (t) => {
  const { app, pipelineEvents } = makeVisualizerApp({ maxSseClients: 2 });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(() => app.close());

  const receivedChunks = [];
  const sseState = await new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/api/visualizer/stream`, (res) => {
      res.setEncoding('utf8');
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'], /text\/event-stream/);
      assert.equal(res.headers['x-accel-buffering'], 'no');

      res.on('data', (chunk) => {
        receivedChunks.push(chunk);
        const joined = receivedChunks.join('');
        if (joined.includes('event: snapshot') && !joined.includes('event: stage')) {
          pipelineEvents.emitStage({
            runId: 'live-sse-1',
            stage: 'llm',
            phase: 'started',
            label: 'Menguji stream SSE',
            chatId: '628123000@c.us',
            scope: 'personal',
            meta: { modelTier: 'balanced', modelId: 'claude-sonnet-5-5' }
          });
        }
        if (joined.includes('event: stage') && joined.includes('live-sse-1')) {
          req.destroy();
          resolve(joined);
        }
      });
    });
    req.on('error', reject);
  });

  assert.match(sseState, /event: snapshot/);
  assert.match(sseState, /event: stage/);
  assert.match(sseState, /claude-sonnet-5-5/);
  assert.equal(sseState.includes('628123000'), false);
});
