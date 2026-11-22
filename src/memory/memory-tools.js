const { z } = require('../utils/zod-loader');

function workspaceOf(ctx) {
  return {
    scope: ctx.scope,
    ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
    chatId: ctx.scope === 'group' ? ctx.chatId : null
  };
}

function createMemoryTools({ db, memoryService }) {
  return [
    {
      name: 'save_note',
      description: 'Save a note in the current workspace. Personal notes are private to the owner; group notes stay in that group.',
      scopes: ['personal', 'group'],
      group: 'memory',
      aliasOf: 'remember_fact',
      schema: z.object({ content: z.string().min(1).max(5000), kind: z.string().max(40).default('note') }).strict(),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { content: { type: 'string' }, kind: { type: 'string' } },
        required: ['content']
      },
      execute: async ({ content, kind }, ctx) => {
        const noteKind = String(kind || 'note').trim() || 'note';
        const ws = workspaceOf(ctx);
        if (memoryService) {
          return memoryService.remember({
            ...ws,
            content,
            title: null,
            kind: noteKind,
            memoryType: noteKind,
            source: 'save_note_tool'
          });
        }
        return {
          saved: true,
          noteId: db.saveMemory({
            ...ws,
            content,
            kind: noteKind
          })
        };
      }
    },
    {
      name: 'search_notes',
      description: 'Search notes only in the current workspace.',
      scopes: ['personal', 'group'],
      group: 'memory',
      aliasOf: 'search_memory',
      readOnly: true,
      schema: z.object({ query: z.string().min(1).max(300) }).strict(),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { query: { type: 'string' } }, required: ['query']
      },
      execute: async ({ query }, ctx) => {
        const ws = workspaceOf(ctx);
        return {
          notes: memoryService
            ? await memoryService.retrieve({ ...ws, query, limit: 8 })
            : db.searchMemories({ ...ws, query, limit: 8 })
        };
      }
    },
    {
      name: 'remember_fact',
      description: 'Save durable facts, preferences, goals or project context in the current workspace so Bubu can recall them in future conversations. Pass supersedeId when replacing an outdated memory. In group scope, save only shared group information, not an individual member personal details.',
      scopes: ['personal', 'group'],
      group: 'memory',
      schema: z.object({
        title: z.string().max(160).optional(),
        content: z.string().min(3).max(1500),
        memoryType: z.enum(['fact', 'preference', 'goal', 'project']).optional(),
        importance: z.number().int().min(1).max(5).optional(),
        projectId: z.string().uuid().optional(),
        supersedeId: z.number().int().positive().optional()
      }).strict(),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' }, content: { type: 'string' },
          memoryType: { type: 'string', enum: ['fact', 'preference', 'goal', 'project'] },
          importance: { type: 'integer', minimum: 1, maximum: 5 },
          projectId: { type: 'string', description: 'Optional project UUID in this workspace' },
          supersedeId: { type: 'integer', minimum: 1, description: 'Optional existing memory ID in this workspace to mark superseded' }
        }, required: ['content']
      },
      execute: async ({ title, content, memoryType, importance, projectId, supersedeId }, ctx) => {
        const ws = workspaceOf(ctx);
        const type = memoryType || 'fact';
        if (memoryService) {
          return memoryService.remember({
            ...ws,
            title,
            content,
            memoryType: type,
            importance: importance || 3,
            projectId,
            supersedeId: supersedeId ?? null,
            source: 'agent_tool'
          });
        }
        if (supersedeId != null) {
          const res = db.supersedeMemory({
            oldId: supersedeId,
            ...ws,
            newMemory: {
              title: title ?? null,
              content,
              memoryType: type,
              kind: type,
              importance: importance || 3,
              projectId: projectId ?? null,
              source: 'agent_tool'
            }
          });
          return { saved: true, memoryId: res.newId, supersededId: res.oldId, memoryType: type, embedded: false };
        }
        const id = db.saveMemory({
          ...ws,
          title: title ?? null,
          content,
          memoryType: type,
          kind: type,
          importance: importance || 3,
          projectId: projectId ?? null,
          source: 'agent_tool'
        });
        return { saved: true, memoryId: id, memoryType: type, embedded: false };
      }
    },
    {
      name: 'search_memory',
      description: 'Search long-term memories semantically in the current workspace. Use to recall previous facts, preferences, goals and project information.',
      scopes: ['personal', 'group'],
      group: 'memory',
      readOnly: true,
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
      execute: async ({ query, projectId, limit }, ctx) => {
        const ws = workspaceOf(ctx);
        return {
          memories: memoryService
            ? await memoryService.retrieve({ ...ws, query, projectId, limit: limit || 8 })
            : db.searchMemoriesSemantic({ ...ws, query, projectId, limit: limit || 8 })
        };
      }
    },
    {
      name: 'list_memories',
      description: 'List memories in the current workspace, optionally filtered by memoryType, projectId, or lifecycle status.',
      scopes: ['personal', 'group'],
      group: 'memory',
      readOnly: true,
      schema: z.object({
        memoryType: z.string().min(1).max(40).optional(),
        projectId: z.string().uuid().optional(),
        status: z.enum(['active', 'superseded', 'archived']).nullable().optional(),
        limit: z.number().int().min(1).max(50).optional()
      }).strict(),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          memoryType: { type: 'string' },
          projectId: { type: 'string' },
          status: { type: ['string', 'null'], enum: ['active', 'superseded', 'archived', null] },
          limit: { type: 'integer', minimum: 1, maximum: 50 }
        }
      },
      execute: async ({ memoryType, projectId, status, limit }, ctx) => ({
        memories: db.listMemories({
          ...workspaceOf(ctx),
          memoryType: memoryType ?? null,
          projectId: projectId ?? null,
          status: status === undefined ? 'active' : status,
          limit: limit || 20
        })
      })
    },
    {
      name: 'update_memory',
      description: 'Update the title, content, memoryType, importance, projectId or status of an existing memory in the current workspace.',
      scopes: ['personal', 'group'],
      group: 'memory',
      schema: z.object({
        memoryId: z.number().int().positive(),
        title: z.string().max(160).nullable().optional(),
        content: z.string().min(1).max(5000).optional(),
        memoryType: z.enum(['fact', 'preference', 'goal', 'project']).optional(),
        importance: z.number().int().min(1).max(5).optional(),
        projectId: z.string().uuid().nullable().optional(),
        status: z.enum(['active', 'superseded', 'archived']).optional()
      }).strict().refine((value) => Object.keys(value).some((key) => key !== 'memoryId'), {
        message: 'At least one field to update is required'
      }),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          memoryId: { type: 'integer', minimum: 1 },
          title: { type: ['string', 'null'] },
          content: { type: 'string' },
          memoryType: { type: 'string', enum: ['fact', 'preference', 'goal', 'project'] },
          importance: { type: 'integer', minimum: 1, maximum: 5 },
          projectId: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['active', 'superseded', 'archived'] }
        },
        required: ['memoryId']
      },
      execute: async ({ memoryId, title, content, memoryType, importance, projectId, status }, ctx) => {
        const ws = workspaceOf(ctx);
        const memory = memoryService
          ? await memoryService.update({
              id: memoryId,
              ...ws,
              title,
              content,
              memoryType,
              importance,
              projectId,
              status
            })
          : db.updateMemory({
              id: memoryId,
              ...ws,
              fields: {
                ...(title !== undefined ? { title } : {}),
                ...(content !== undefined ? { content } : {}),
                ...(memoryType !== undefined ? { memory_type: memoryType, kind: memoryType } : {}),
                ...(importance !== undefined ? { importance } : {}),
                ...(projectId !== undefined ? { project_id: projectId } : {}),
                ...(status !== undefined ? { status } : {})
              }
            });
        if (!memory) throw new Error('Memori tidak ditemukan pada workspace ini.');
        return { updated: true, memory };
      }
    },
    {
      name: 'forget_memory',
      description: 'Archive (soft-delete by default) or permanently delete a memory in the current workspace.',
      scopes: ['personal', 'group'],
      group: 'memory',
      schema: z.object({
        memoryId: z.number().int().positive(),
        hard: z.boolean().optional()
      }).strict(),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          memoryId: { type: 'integer', minimum: 1 },
          hard: { type: 'boolean', description: 'Permanently delete when true; default false (archive)' }
        },
        required: ['memoryId']
      },
      execute: async ({ memoryId, hard = false }, ctx) => {
        const ws = workspaceOf(ctx);
        const result = memoryService
          ? await memoryService.forget({ id: memoryId, ...ws, hard: Boolean(hard) })
          : db.deleteMemory({ id: memoryId, ...ws, hard: Boolean(hard) });
        return result;
      }
    },
    {
      name: 'consolidate_memories',
      description: 'Deduplicate active memories, archive stale low-importance memories, and backfill missing semantic embeddings for the current workspace.',
      scopes: ['personal', 'group'],
      group: 'memory',
      schema: z.object({
        backfillLimit: z.number().int().min(0).max(30).optional()
      }).strict(),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          backfillLimit: { type: 'integer', minimum: 0, maximum: 30 }
        }
      },
      execute: async ({ backfillLimit }, ctx) => {
        const ws = workspaceOf(ctx);
        const limit = backfillLimit === undefined ? 10 : backfillLimit;
        if (memoryService) {
          return memoryService.consolidateWorkspace({ ...ws, backfillLimit: limit });
        }
        const consolidated = db.consolidateWorkspaceMemories(ws);
        return { ...consolidated, backfilledCount: 0 };
      }
    },
    {
      name: 'create_project',
      description: 'Create a named project in the current workspace to organize related memories and ongoing work.',
      scopes: ['personal', 'group'],
      group: 'memory',
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
          ...workspaceOf(ctx),
          name, description
        })
      })
    },
    {
      name: 'list_projects',
      description: 'List projects in the current workspace.',
      scopes: ['personal', 'group'],
      group: 'memory',
      readOnly: true,
      schema: z.object({
        status: z.enum(['active', 'paused', 'completed', 'archived']).nullable().optional(),
        limit: z.number().int().min(1).max(30).optional()
      }).strict(),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: ['string', 'null'], enum: ['active', 'paused', 'completed', 'archived', null] },
          limit: { type: 'integer', minimum: 1, maximum: 30 }
        }
      },
      execute: async ({ status, limit }, ctx) => ({
        projects: db.listProjects({
          ...workspaceOf(ctx),
          status: status === undefined ? 'active' : status,
          limit: limit || 20
        })
      })
    },
    {
      name: 'update_project',
      description: 'Update the name, description or status of a project in the current workspace.',
      scopes: ['personal', 'group'],
      group: 'memory',
      schema: z.object({
        projectId: z.string().uuid(),
        name: z.string().min(2).max(120).optional(),
        description: z.string().max(1500).nullable().optional(),
        status: z.enum(['active', 'paused', 'completed', 'archived']).optional()
      }).strict().refine((value) => Object.keys(value).some((key) => key !== 'projectId')),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          projectId: { type: 'string' }, name: { type: 'string' },
          description: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['active', 'paused', 'completed', 'archived'] }
        }, required: ['projectId']
      },
      execute: async ({ projectId, ...fields }, ctx) => {
        const project = db.updateProject({
          id: projectId,
          ...workspaceOf(ctx),
          fields
        });
        if (!project) throw new Error('Project tidak ditemukan pada workspace ini.');
        return { updated: true, project };
      }
    },
    {
      name: 'list_memory_events',
      description: 'List recent episodic memory events from the current workspace.',
      scopes: ['personal', 'group'],
      group: 'memory',
      readOnly: true,
      schema: z.object({ limit: z.number().int().min(1).max(30).optional() }).strict(),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 30 } }
      },
      execute: async ({ limit }, ctx) => ({
        events: db.listMemoryEvents({
          ...workspaceOf(ctx),
          limit: limit || 15
        })
      })
    }
  ];
}

module.exports = { createMemoryTools };
