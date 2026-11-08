const { z } = require('zod');

class ToolRegistry {
  constructor() { this.tools = new Map(); }

  register(tool) {
    if (!tool?.name || !tool.schema || typeof tool.execute !== 'function' || !Array.isArray(tool.scopes)) {
      throw new Error('Tool requires name, schema, execute, and scopes');
    }
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, Object.freeze({ risk: 'low', requiresApproval: false, ...tool }));
  }

  get(name) { return this.tools.get(name); }

  list(scope) {
    return [...this.tools.values()].filter((tool) => tool.scopes.includes(scope));
  }

  definitions(scope) {
    return this.list(scope).map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    }));
  }
}

function createCoreTools({ db, approvalManager, waha, config, memoryService }) {
  const registry = new ToolRegistry();

  registry.register({
    name: 'save_note',
    description: 'Save a note in the current workspace. Personal notes are private to the owner; group notes stay in that group.',
    scopes: ['personal', 'group'],
    schema: z.object({ content: z.string().min(1).max(5000), kind: z.string().max(40).default('note') }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { content: { type: 'string' }, kind: { type: 'string' } },
      required: ['content']
    },
    execute: async ({ content, kind }, ctx) => memoryService
      ? memoryService.remember({
          scope: ctx.scope,
          ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
          chatId: ctx.scope === 'group' ? ctx.chatId : null,
          content, title: null, memoryType: 'fact', source: 'save_note_tool'
        })
      : ({
          saved: true,
          noteId: db.saveMemory({
            scope: ctx.scope,
            ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
            chatId: ctx.scope === 'group' ? ctx.chatId : null,
            content, kind
          })
        })
  });

  registry.register({
    name: 'search_notes',
    description: 'Search notes only in the current workspace.',
    scopes: ['personal', 'group'],
    schema: z.object({ query: z.string().min(1).max(300) }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { query: { type: 'string' } }, required: ['query']
    },
    execute: async ({ query }, ctx) => ({
      notes: memoryService
        ? await memoryService.retrieve({
            scope: ctx.scope,
            ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
            chatId: ctx.scope === 'group' ? ctx.chatId : null,
            query, limit: 8
          })
        : db.searchMemories({
            scope: ctx.scope,
            ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
            chatId: ctx.scope === 'group' ? ctx.chatId : null,
            query, limit: 8
          })
    })
  });

  registry.register({
    name: 'create_reminder',
    description: 'Create a one-time reminder for the owner. dueAt must be ISO-8601 with timezone.',
    scopes: ['personal'],
    schema: z.object({
      message: z.string().min(1).max(500),
      dueAt: z.string().datetime({ offset: true })
    }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        message: { type: 'string' },
        dueAt: { type: 'string', description: 'ISO-8601 timestamp with timezone' }
      },
      required: ['message', 'dueAt']
    },
    execute: async ({ message, dueAt }, ctx) => {
      const dueTime = Date.parse(dueAt);
      if (!Number.isFinite(dueTime) || dueTime <= Date.now() || dueTime > Date.now() + 365 * 86400000) {
        throw new Error('Reminder time must be in the future and within one year');
      }
      return {
        created: true,
        reminderId: db.createReminder({
          chatId: ctx.chatId, requesterId: ctx.requesterId, message,
          dueAt: new Date(dueTime).toISOString()
        })
      };
    }
  });

  registry.register({
    name: 'send_whatsapp_message',
    description: 'Request owner confirmation to send a WhatsApp text to a known contact or group. Never claim sent before approval and send result.',
    scopes: ['personal'],
    risk: 'external',
    requiresApproval: true,
    schema: z.object({
      targetId: z.string().min(5).max(100),
      message: z.string().min(1).max(4000)
    }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { targetId: { type: 'string' }, message: { type: 'string' } },
      required: ['targetId', 'message']
    },
    execute: async (args, ctx) => approvalManager.create({
      taskId: ctx.taskId, chatId: ctx.chatId, requesterId: ctx.requesterId,
      toolName: 'send_whatsapp_message', args
    })
  });

  return registry;
}

module.exports = { ToolRegistry, createCoreTools };
