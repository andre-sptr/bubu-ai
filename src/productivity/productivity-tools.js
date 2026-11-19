const crypto = require('node:crypto');
const { z } = require('../utils/zod-loader');

function createProductivityTools({ db, approvalManager }) {
  const tools = [];

  tools.push({
    name: 'create_task',
    description: 'Create a task in the current workspace. Use ISO-8601 with timezone for optional dueAt.',
    scopes: ['personal', 'group'],
    schema: z.object({
      title: z.string().min(1).max(180),
      description: z.string().max(2000).optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      dueAt: z.string().datetime({ offset: true }).optional()
    }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string' }, description: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        dueAt: { type: 'string', description: 'Optional ISO-8601 timestamp with timezone' }
      }, required: ['title']
    },
    execute: async (args, ctx) => {
      const id = crypto.randomUUID();
      const dueTime = args.dueAt ? Date.parse(args.dueAt) : null;
      if (dueTime && (!Number.isFinite(dueTime) || dueTime < Date.now())) throw new Error('Due date must be in the future.');
      const task = db.createUserTask({
        id,
        scope: ctx.scope,
        ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
        chatId: ctx.scope === 'group' ? ctx.chatId : null,
        title: args.title,
        description: args.description,
        priority: args.priority,
        dueAt: dueTime ? new Date(dueTime).toISOString() : null
      });
      return { created: true, task };
    }
  });

  tools.push({
    name: 'list_tasks',
    description: 'List tasks from the current personal or group workspace. Optionally filter by status.',
    scopes: ['personal', 'group'],
    schema: z.object({
      status: z.enum(['open', 'in_progress', 'blocked', 'completed', 'cancelled']).optional(),
      limit: z.number().int().min(1).max(30).optional()
    }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { status: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'completed', 'cancelled'] }, limit: { type: 'integer', minimum: 1, maximum: 30 } }
    },
    execute: async ({ status, limit }, ctx) => ({
      tasks: db.listUserTasks({
        scope: ctx.scope,
        ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
        chatId: ctx.scope === 'group' ? ctx.chatId : null,
        status: status || null,
        limit: limit || 20
      })
    })
  });

  tools.push({
    name: 'update_task',
    description: 'Update a task in the current workspace by task ID. Only fields supplied are changed.',
    scopes: ['personal', 'group'],
    schema: z.object({
      taskId: z.string().uuid(),
      title: z.string().min(1).max(180).optional(),
      description: z.string().max(2000).optional(),
      status: z.enum(['open', 'in_progress', 'blocked', 'completed', 'cancelled']).optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      dueAt: z.string().datetime({ offset: true }).nullable().optional()
    }).strict().refine((v) => Object.keys(v).some((k) => k !== 'taskId'), 'At least one field to update is required'),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        taskId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'completed', 'cancelled'] },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        dueAt: { type: ['string', 'null'] }
      }, required: ['taskId']
    },
    execute: async ({ taskId, dueAt, ...fields }, ctx) => {
      const mapped = { ...fields };
      if (dueAt !== undefined) {
        if (dueAt === null) {
          mapped.due_at = null;
        } else {
          const dueTime = Date.parse(dueAt);
          if (!Number.isFinite(dueTime) || dueTime < Date.now()) {
            throw new Error('Due date must be in the future.');
          }
          mapped.due_at = new Date(dueTime).toISOString();
        }
      }
      const task = db.updateUserTask({
        id: taskId,
        scope: ctx.scope,
        ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
        chatId: ctx.scope === 'group' ? ctx.chatId : null,
        fields: mapped
      });
      if (!task) throw new Error('Task not found in this workspace.');
      return { updated: true, task };
    }
  });

  tools.push({
    name: 'complete_task',
    description: 'Mark a task as completed in the current workspace.',
    scopes: ['personal', 'group'],
    schema: z.object({ taskId: z.string().uuid() }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { taskId: { type: 'string' } }, required: ['taskId']
    },
    execute: async ({ taskId }, ctx) => {
      const task = db.updateUserTask({
        id: taskId,
        scope: ctx.scope,
        ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
        chatId: ctx.scope === 'group' ? ctx.chatId : null,
        fields: { status: 'completed' }
      });
      if (!task) throw new Error('Task not found in this workspace.');
      return { completed: true, task };
    }
  });

  tools.push({
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

  tools.push({
    name: 'list_reminders',
    description: 'List the owner’s reminders in the current private chat.',
    scopes: ['personal'],
    schema: z.object({
      status: z.enum(['pending', 'sent', 'failed', 'cancelled']).optional(),
      limit: z.number().int().min(1).max(30).optional()
    }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { status: { type: 'string', enum: ['pending', 'sent', 'failed', 'cancelled'] }, limit: { type: 'integer', minimum: 1, maximum: 30 } }
    },
    execute: async ({ status, limit }, ctx) => ({
      reminders: db.listReminders({
        chatId: ctx.chatId, requesterId: ctx.requesterId, status: status || 'pending', limit: limit || 20
      })
    })
  });

  tools.push({
    name: 'cancel_reminder',
    description: 'Cancel a pending reminder owned by the current user in the current private chat.',
    scopes: ['personal'],
    schema: z.object({ reminderId: z.number().int().positive() }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { reminderId: { type: 'integer', minimum: 1 } }, required: ['reminderId']
    },
    execute: async ({ reminderId }, ctx) => ({
      cancelled: db.cancelReminder({ id: reminderId, chatId: ctx.chatId, requesterId: ctx.requesterId })
    })
  });

  tools.push({
    name: 'send_whatsapp_message',
    description: 'Request owner confirmation to send a WhatsApp text to a known contact or group. Never claim sent before approval and send result.',
    scopes: ['personal'],
    risk: 'external',
    requiresApproval: true,
    schema: z.object({
      targetId: z.string().min(5).max(100),
      message: z.string().min(1).max(4000),
      replyTo: z.string().min(1).max(200).optional()
    }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        targetId: { type: 'string' },
        message: { type: 'string' },
        replyTo: { type: 'string', description: 'Optional WhatsApp message ID to reply to' }
      },
      required: ['targetId', 'message']
    },
    execute: async (args, ctx) => approvalManager.create({
      taskId: ctx.taskId, chatId: ctx.chatId, requesterId: ctx.requesterId,
      toolName: 'send_whatsapp_message', args
    })
  });

  return tools;
}

module.exports = { createProductivityTools };
