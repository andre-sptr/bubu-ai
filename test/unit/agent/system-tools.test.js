const test = require('node:test');
const assert = require('node:assert/strict');
const { createSystemTools } = require('../../../src/agent/system-tools');

test('get_bubu_usage_summary enforces personal scope and returns safe runtime telemetry without secrets', async () => {
  let capturedWindowHours = null;
  const [tool] = createSystemTools({
    db: {
      getTelemetrySummary({ windowHours }) {
        capturedWindowHours = windowHours;
        return {
          windowHours,
          totalCalls: 24,
          successCalls: 23,
          failedCalls: 1,
          totalInputTokens: 12000,
          totalOutputTokens: 3400,
          avgLatencyMs: 2150,
          estimatedCostUsd: 0.0125,
          estimatedCostIdr: 210,
          byTier: { fast: { calls: 18 } },
          costByTier: { fast: 0.008 },
          byModel: { 'deepseek-flash': { calls: 18 } }
        };
      }
    },
    config: {
      sumopod: {
        apiKey: 'sk-super-secret-must-never-leak',
        models: {
          fast: { id: 'deepseek-flash' },
          balanced: { id: 'deepseek-v4-pro' },
          reasoning: { id: 'deepseek-v4-pro' },
          coding: { id: 'deepseek-v4-pro' },
          summary: { id: 'deepseek-v4-pro' },
          vision: { id: 'deepseek-flash' }
        }
      }
    },
    worker: {
      getStats() {
        return {
          activeCount: 1,
          maxConcurrentJobs: 2,
          healthy: true,
          queue: { pendingCount: 0, processingCount: 1, failedCount: 0, deadCount: 0, completedCount: 50 }
        };
      }
    },
    sessionMonitor: {
      snapshot() {
        return {
          session: 'Bubu',
          status: 'WORKING',
          healthy: true,
          degraded: false,
          botJid: '6280000000000@c.us',
          botLid: '12345@lid'
        };
      }
    }
  });

  assert.equal(tool.name, 'get_bubu_usage_summary');
  assert.equal(tool.group, 'system');
  assert.deepEqual(tool.scopes, ['personal']);
  assert.equal(tool.readOnly, true);

  await assert.rejects(
    () => tool.execute({}, { scope: 'group' }),
    /pribadi/i
  );

  const clampedMax = await tool.execute({ windowHours: 5000 }, { scope: 'personal' });
  assert.equal(capturedWindowHours, 720);
  assert.equal(clampedMax.windowHours, 720);
  assert.equal(clampedMax.telemetry.totalCalls, 24);
  assert.equal(clampedMax.activeModels.fast, 'deepseek-flash');
  assert.equal(clampedMax.activeModels.vision, 'deepseek-flash');
  assert.equal(clampedMax.queue.pendingCount, 0);
  assert.equal(clampedMax.queue.activeCount, 1);
  assert.equal(clampedMax.session.status, 'WORKING');
  assert.equal(JSON.stringify(clampedMax).includes('sk-super-secret'), false);
  assert.equal(JSON.stringify(clampedMax).includes('6280000000000@c.us'), false);
});

test('get_bubu_usage_summary falls back to db.getQueueStats and default 24h window when worker is absent', async () => {
  const [tool] = createSystemTools({
    db: {
      getTelemetrySummary({ windowHours }) {
        return { windowHours, totalCalls: 0 };
      },
      getQueueStats() {
        return { pendingCount: 2, deadCount: 0 };
      }
    }
  });

  const result = await tool.execute({}, { scope: 'personal' });
  assert.equal(result.windowHours, 24);
  assert.deepEqual(result.queue, { pendingCount: 2, deadCount: 0 });
  assert.deepEqual(result.activeModels, {});
  assert.equal(result.session, null);
});
