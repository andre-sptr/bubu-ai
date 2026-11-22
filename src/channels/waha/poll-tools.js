const { z } = require('../../utils/zod-loader');

/**
 * Create Stage 3 read-only poll result inspection tools.
 * Kept separate from `createWahaTools()` so the 14-tool Phase 4 contract array remains invariant.
 */
function createPollTools({ db = null } = {}) {
  return [
    {
      name: 'get_poll_results',
      description: 'Inspect recorded votes and tally for a WhatsApp poll in the current workspace (defaults to latest poll in the chat).',
      scopes: ['personal', 'group'],
      group: 'waha',
      readOnly: true,
      risk: 'low',
      schema: z.object({
        pollMessageId: z.string().min(1).max(200).optional()
      }).strict(),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pollMessageId: {
            type: 'string',
            description: 'Optional WhatsApp poll message ID; omits to inspect the most recent poll'
          }
        }
      },
      execute: async ({ pollMessageId } = {}, ctx) => {
        if (!db || typeof db.getPollResults !== 'function') {
          return { found: false, reason: 'poll_store_unavailable' };
        }
        return db.getPollResults({
          pollMessageId: pollMessageId || null,
          chatId: ctx?.chatId || null,
          scope: ctx?.scope || 'group'
        });
      }
    }
  ];
}

module.exports = { createPollTools };
