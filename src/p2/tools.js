const { z } = require('zod');

function createP2MemoryTools({ db, memoryService }) {
  return [
    {
      name: 'remember_fact',
      description: "Save durable facts, preferences, goals or project context in the current workspace so Bubu can recall them in future conversations. In group scope, save only shared group information, not an individual member personal details.",
      scopes: ['personal','group'],
      schema: z.object({
        title: z.string().max(160).optional(),
        content: z.string().min(3).max(1500),
        memoryType: z.enum(['fact','preference','goal','project']).optional(),
        importance: z.number().int().min(1).max(5).optional(),
        projectId: z.string().uuid().optional()
      }).strict(),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' }, content: { type: 'string' },
          memoryType: { type: 'string', enum: ['fact','preference','goal','project'] },
          importance: { type: 'integer', minimum: 1, maximum: 5 },
          projectId: { type: 'string', description: 'Optional project UUID in this workspace' }
        }, required: ['content']
      },
      execute: async ({ title, content, memoryType, importance, projectId }, ctx) =>
        memoryService.remember({
          scope: ctx.scope,
          ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
          chatId: ctx.scope === 'group' ? ctx.chatId : null,
          title, content, memoryType: memoryType || 'fact',
          importance: importance || 3, projectId,
          source: 'agent_tool'
        })
    },
    {
      name: 'search_memory',
      description: 'Search long-term memories semantically in the current workspace. Use to recall previous facts, preferences, goals and project information.',
      scopes: ['personal','group'],
      schema: z.object({
        query: z.string().min(2).max(500),
        projectId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(15).optional()
      }).strict(),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          query: { type: 'string' },
          projectId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 15 }
        }, required: ['query']
      },
      execute: async ({ query, projectId, limit }, ctx) => ({
        memories: await memoryService.retrieve({
          scope: ctx.scope,
          ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
          chatId: ctx.scope === 'group' ? ctx.chatId : null,
          query, projectId, limit: limit || 8
        })
      })
    },
    {
      name: 'create_project',
      description: 'Create a named project in the current workspace to organize related memories and ongoing work.',
      scopes: ['personal','group'],
      schema: z.object({
        name: z.string().min(2).max(120),
        description: z.string().max(1500).optional()
      }).strict(),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { name: { type: 'string' }, description: { type: 'string' } },
        required: ['name']
      },
      execute: async ({ name, description }, ctx) => ({
        created: true,
        project: await memoryService.createProject({
          scope: ctx.scope,
          ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
          chatId: ctx.scope === 'group' ? ctx.chatId : null,
          name, description
        })
      })
    },
    {
      name: 'list_projects',
      description: 'List projects in the current workspace.',
      scopes: ['personal','group'],
      schema: z.object({
        status: z.enum(['active','paused','completed','archived']).nullable().optional(),
        limit: z.number().int().min(1).max(30).optional()
      }).strict(),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: ['string','null'], enum: ['active','paused','completed','archived',null] },
          limit: { type: 'integer', minimum: 1, maximum: 30 }
        }
      },
      execute: async ({ status, limit }, ctx) => ({
        projects: db.listProjects({
          scope: ctx.scope,
          ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
          chatId: ctx.scope === 'group' ? ctx.chatId : null,
          status: status === undefined ? 'active' : status,
          limit: limit || 20
        })
      })
    },
    {
      name: 'update_project',
      description: 'Update the name, description or status of a project in the current workspace.',
      scopes: ['personal','group'],
      schema: z.object({
        projectId: z.string().uuid(),
        name: z.string().min(2).max(120).optional(),
        description: z.string().max(1500).nullable().optional(),
        status: z.enum(['active','paused','completed','archived']).optional()
      }).strict().refine(value => Object.keys(value).some(key => key !== 'projectId')),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          projectId: { type: 'string' }, name: { type: 'string' },
          description: { type: ['string','null'] },
          status: { type: 'string', enum: ['active','paused','completed','archived'] }
        }, required: ['projectId']
      },
      execute: async ({ projectId, ...fields }, ctx) => {
        const project = db.updateProject({
          id: projectId,
          scope: ctx.scope,
          ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
          chatId: ctx.scope === 'group' ? ctx.chatId : null,
          fields
        });
        if (!project) throw new Error('Project tidak ditemukan pada workspace ini.');
        return { updated: true, project };
      }
    },
    {
      name: 'list_memory_events',
      description: 'List recent episodic memory events from the current workspace.',
      scopes: ['personal','group'],
      schema: z.object({ limit: z.number().int().min(1).max(30).optional() }).strict(),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 30 } }
      },
      execute: async ({ limit }, ctx) => ({
        events: db.listMemoryEvents({
          scope: ctx.scope,
          ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
          chatId: ctx.scope === 'group' ? ctx.chatId : null,
          limit: limit || 15
        })
      })
    }
  ];
}

module.exports = { createP2MemoryTools };
