const { z } = require('../utils/zod-loader');

function createSystemTools({ db, config = null, worker = null, sessionMonitor = null } = {}) {
  const schema = z.object({
    windowHours: z.number().int().min(1).max(720).optional()
  }).strict();

  return [
    {
      name: 'get_bubu_usage_summary',
      description: 'Read safe operational usage and runtime summary for Bubu AI: Sumopod token usage, estimated USD/IDR cost, latency by tier and model over a rolling time window (1-720h), active configured models, queue depth, and WhatsApp session health. Never exposes API keys or secrets.',
      group: 'system',
      scopes: ['personal'],
      readOnly: true,
      schema,
      parameters: {
        type: 'object',
        properties: {
          windowHours: {
            type: 'integer',
            minimum: 1,
            maximum: 720,
            description: 'Rolling time window in hours (default 24, min 1, max 720).'
          }
        },
        additionalProperties: false
      },
      async execute(args = {}, ctx = {}) {
        if (ctx?.scope && ctx.scope !== 'personal') {
          throw new Error('Ringkasan penggunaan sistem Bubu hanya tersedia pada chat pribadi owner.');
        }
        const rawHours = Number(args?.windowHours);
        const windowHours = Number.isFinite(rawHours)
          ? Math.min(720, Math.max(1, Math.trunc(rawHours)))
          : 24;

        const telemetry = typeof db?.getTelemetrySummary === 'function'
          ? db.getTelemetrySummary({ windowHours })
          : null;
        const workerStats = typeof worker?.getStats === 'function'
          ? worker.getStats()
          : null;
        const queueStats = workerStats?.queue || (
          typeof db?.getQueueStats === 'function' ? db.getQueueStats() : null
        );
        const sessionSnapshot = typeof sessionMonitor?.snapshot === 'function'
          ? sessionMonitor.snapshot()
          : null;

        const rawModels = config?.sumopod?.models || {};
        const activeModels = {};
        for (const tier of ['fast', 'balanced', 'reasoning', 'coding', 'summary', 'vision']) {
          const modelId = rawModels[tier]?.id;
          if (modelId) {
            activeModels[tier] = String(modelId);
          }
        }

        return {
          windowHours,
          telemetry,
          activeModels,
          queue: workerStats
            ? {
                activeCount: workerStats.activeCount,
                maxConcurrentJobs: workerStats.maxConcurrentJobs,
                healthy: workerStats.healthy,
                ...(queueStats || {})
              }
            : queueStats,
          session: sessionSnapshot
            ? {
                session: sessionSnapshot.session,
                status: sessionSnapshot.status,
                healthy: sessionSnapshot.healthy,
                degraded: sessionSnapshot.degraded
              }
            : null
        };
      }
    }
  ];
}

module.exports = { createSystemTools };
