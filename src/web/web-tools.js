const { z } = require('../utils/zod-loader');

function createWebTools({ webSearch, webFetch }) {
  const tools = [];

  if (webSearch) {
    tools.push({
      name: 'web_search',
      description: 'Search current public web information. Return concise source titles, URLs, snippets and dates. Use for fresh facts and research.',
      scopes: ['personal', 'group'],
      group: 'web',
      readOnly: true,
      schema: z.object({
        query: z.string().min(3).max(400),
        maxResults: z.number().int().min(1).max(10).optional(),
        timeRange: z.enum(['day', 'week', 'month', 'year']).optional()
      }).strict(),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          query: { type: 'string' },
          maxResults: { type: 'integer', minimum: 1, maximum: 10 },
          timeRange: { type: 'string', enum: ['day', 'week', 'month', 'year'] }
        }, required: ['query']
      },
      execute: async (args) => ({ results: await webSearch.search(args) })
    });
  }

  if (webFetch) {
    tools.push({
      name: 'web_fetch',
      description: 'Fetch and extract readable text from a public HTTP/HTTPS web page. Do not fetch private networks or local services.',
      scopes: ['personal', 'group'],
      group: 'web',
      readOnly: true,
      schema: z.object({ url: z.string().url().max(2000) }).strict(),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { url: { type: 'string', format: 'uri' } }, required: ['url']
      },
      execute: async (args) => webFetch.fetch(args)
    });
  }

  return tools;
}

module.exports = { createWebTools };
