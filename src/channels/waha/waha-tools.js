const { z } = require('../../utils/zod-loader');
const { normalizeJid } = require('../../config/env');
const { ResponseHandler } = require('../response-handler');

const MAX_GROUP_PARTICIPANTS = 30;
const DEGRADED_STATUSES = new Set(['FAILED', 'STOPPED', 'SCAN_QR_CODE']);

function preSendError(message) {
  return Object.assign(new Error(message), { deliveryStatus: 'failed' });
}

function assertSameChatMessageId(messageId, expectedChatId) {
  const raw = String(messageId || '').trim();
  if (!raw) throw preSendError('Target messageId is required to send a reaction.');
  const serializedMatch = raw.match(/^(?:true|false)_([^_]+@(?:c\.us|s\.whatsapp\.net|g\.us|lid))_[^_]+$/i);
  if (serializedMatch) {
    const messageChatId = normalizeJid(serializedMatch[1]);
    if (expectedChatId && messageChatId !== normalizeJid(expectedChatId)) {
      throw preSendError('Cannot react to a message from a different WhatsApp chat.');
    }
  }
  return raw;
}

function extractParticipantsList(participantsRaw, info) {
  const rawList = Array.isArray(participantsRaw)
    ? participantsRaw
    : Array.isArray(participantsRaw?.participants)
      ? participantsRaw.participants
      : Array.isArray(participantsRaw?.data)
        ? participantsRaw.data
        : Array.isArray(info?.participants)
          ? info.participants
          : Array.isArray(info?.Participants)
            ? info.Participants
            : [];

  return rawList
    .map((entry) => {
      if (!entry) return null;
      if (typeof entry === 'string') {
        return { id: entry, isAdmin: false, isSuperAdmin: false };
      }
      const id = entry.id?._serialized || entry.id || entry.jid || entry.JID || entry.phone || entry.user || null;
      if (!id) return null;
      const role = String(entry.admin || entry.role || '').toLowerCase();
      const isSuperAdmin = Boolean(entry.isSuperAdmin || entry.IsSuperAdmin || role === 'superadmin');
      const isAdmin = Boolean(isSuperAdmin || entry.isAdmin || entry.IsAdmin || role === 'admin');
      return { id: String(id), isAdmin, isSuperAdmin };
    })
    .filter(Boolean);
}

/**
 * Create Phase 4 native WhatsApp / WAHA tools.
 * All outbound sends go exclusively through ResponseHandler.
 */
function createWahaTools({ waha, responseHandler = null, sessionMonitor = null } = {}) {
  const delivery = responseHandler || (waha ? new ResponseHandler({ waha }) : null);
  const tools = [];

  tools.push({
    name: 'react_to_message',
    description: 'Send an emoji reaction to the current incoming message (or an explicit messageId in the same chat).',
    scopes: ['personal', 'group'],
    risk: 'external',
    schema: z.object({
      emoji: z.string().min(1).max(32).refine((v) => v.trim().length > 0, 'Emoji must not be empty'),
      messageId: z.string().min(1).max(200).optional()
    }).strict(),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        emoji: { type: 'string', description: 'Single emoji reaction such as 👍 or ❤️' },
        messageId: { type: 'string', description: 'Optional target message ID in the current chat; defaults to the incoming message' }
      },
      required: ['emoji']
    },
    execute: async ({ emoji, messageId }, ctx) => {
      if (!ctx?.chatId) throw preSendError('Target chatId is required.');
      if (!delivery || typeof delivery.sendReaction !== 'function') {
        throw preSendError('WAHA reaction delivery is unavailable.');
      }
      const targetMessageId = assertSameChatMessageId(messageId || ctx.incomingMessageId, ctx.chatId);
      const cleanEmoji = emoji.trim();
      const receipt = await delivery.sendReaction(ctx.chatId, targetMessageId, cleanEmoji);
      return {
        ok: true,
        sent: true,
        deliveryStatus: 'sent',
        chatId: ctx.chatId,
        targetMessageId,
        emoji: cleanEmoji,
        messageId: receipt?.messageId || null
      };
    }
  });

  tools.push({
    name: 'send_poll',
    description: 'Send a native WhatsApp poll with 2-12 unique options to the current chat.',
    scopes: ['personal', 'group'],
    risk: 'external',
    schema: z.object({
      question: z.string().min(1).max(255).optional(),
      name: z.string().min(1).max(255).optional(),
      options: z.array(z.string().min(1).max(100)).min(2).max(12),
      multipleAnswers: z.boolean().optional(),
      replyToCurrent: z.boolean().optional()
    }).strict()
      .refine((v) => Boolean(String(v.question ?? v.name ?? '').trim()), 'Poll question is required')
      .refine((v) => {
        if (!Array.isArray(v.options) || v.options.length < 2 || v.options.length > 12) return false;
        const cleaned = v.options.map((o) => o.trim()).filter(Boolean);
        if (cleaned.length !== v.options.length) return false;
        return new Set(cleaned.map((o) => o.toLowerCase())).size === cleaned.length;
      }, 'Poll options must contain 2-12 unique non-empty items'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: { type: 'string', description: 'Poll question' },
        options: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 12,
          description: '2 to 12 unique poll choices'
        },
        multipleAnswers: { type: 'boolean', description: 'Allow selecting multiple answers (default false)' },
        replyToCurrent: { type: 'boolean', description: 'Quote the current incoming message when sending the poll' }
      },
      required: ['question', 'options']
    },
    execute: async ({ question, name, options, multipleAnswers = false, replyToCurrent = false }, ctx) => {
      if (!ctx?.chatId) throw preSendError('Target chatId is required.');
      if (!delivery || typeof delivery.sendPoll !== 'function') {
        throw preSendError('WAHA poll delivery is unavailable.');
      }
      const pollQuestion = String(question ?? name ?? '').trim();
      if (!pollQuestion) throw preSendError('Poll question is required.');
      const cleanedOptions = options.map((opt) => opt.trim());
      const replyTo = replyToCurrent && ctx.incomingMessageId ? ctx.incomingMessageId : undefined;
      const receipt = await delivery.sendPoll(ctx.chatId, {
        name: pollQuestion,
        options: cleanedOptions,
        multipleAnswers: Boolean(multipleAnswers),
        ...(replyTo ? { replyTo } : {})
      });
      return {
        ok: true,
        sent: true,
        deliveryStatus: 'sent',
        chatId: ctx.chatId,
        question: receipt?.name || pollQuestion,
        options: receipt?.options || cleanedOptions,
        multipleAnswers: Boolean(multipleAnswers),
        messageId: receipt?.messageId || null
      };
    }
  });

  tools.push({
    name: 'send_location',
    description: 'Send a native WhatsApp map location pin to the current chat.',
    scopes: ['personal', 'group'],
    risk: 'external',
    schema: z.object({
      latitude: z.number().min(-90).max(90).refine(
        (n) => Number.isFinite(n) && n >= -90 && n <= 90,
        'Latitude must be between -90 and 90'
      ),
      longitude: z.number().min(-180).max(180).refine(
        (n) => Number.isFinite(n) && n >= -180 && n <= 180,
        'Longitude must be between -180 and 180'
      ),
      title: z.string().max(200).optional(),
      replyToCurrent: z.boolean().optional()
    }).strict(),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        title: { type: 'string', description: 'Optional place name or label' },
        replyToCurrent: { type: 'boolean', description: 'Quote the current incoming message when sending the location' }
      },
      required: ['latitude', 'longitude']
    },
    execute: async ({ latitude, longitude, title = '', replyToCurrent = false }, ctx) => {
      if (!ctx?.chatId) throw preSendError('Target chatId is required.');
      if (!delivery || typeof delivery.sendLocation !== 'function') {
        throw preSendError('WAHA location delivery is unavailable.');
      }
      const cleanTitle = title ? title.trim() : '';
      const replyTo = replyToCurrent && ctx.incomingMessageId ? ctx.incomingMessageId : undefined;
      const receipt = await delivery.sendLocation(ctx.chatId, {
        latitude,
        longitude,
        title: cleanTitle,
        ...(replyTo ? { replyTo } : {})
      });
      return {
        ok: true,
        sent: true,
        deliveryStatus: 'sent',
        chatId: ctx.chatId,
        latitude,
        longitude,
        title: receipt?.title ?? cleanTitle,
        messageId: receipt?.messageId || null
      };
    }
  });

  tools.push({
    name: 'send_contact_card',
    description: 'Send a WhatsApp contact vCard to the current chat.',
    scopes: ['personal', 'group'],
    risk: 'external',
    schema: z.object({
      fullName: z.string().min(1).max(120).refine((v) => v.trim().length > 0, 'fullName is required'),
      phoneNumber: z.string().min(6).max(32).refine((v) => {
        const digits = v.replace(/\D/g, '');
        return digits.length >= 6 && digits.length <= 20;
      }, 'phoneNumber must contain 6-20 digits'),
      organization: z.string().max(120).optional(),
      replyToCurrent: z.boolean().optional()
    }).strict(),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fullName: { type: 'string' },
        phoneNumber: { type: 'string' },
        organization: { type: 'string' },
        replyToCurrent: { type: 'boolean', description: 'Quote the current incoming message when sending the contact card' }
      },
      required: ['fullName', 'phoneNumber']
    },
    execute: async ({ fullName, phoneNumber, organization, replyToCurrent = false }, ctx) => {
      if (!ctx?.chatId) throw preSendError('Target chatId is required.');
      if (!delivery || typeof delivery.sendContactVcard !== 'function') {
        throw preSendError('WAHA contact vCard delivery is unavailable.');
      }
      const contact = {
        fullName: fullName.trim(),
        phoneNumber: phoneNumber.trim(),
        ...(organization?.trim() ? { organization: organization.trim() } : {})
      };
      const replyTo = replyToCurrent && ctx.incomingMessageId ? ctx.incomingMessageId : undefined;
      const receipt = await delivery.sendContactVcard(
        ctx.chatId,
        [contact],
        replyTo ? { replyTo } : {}
      );
      return {
        ok: true,
        sent: true,
        deliveryStatus: 'sent',
        chatId: ctx.chatId,
        contact,
        messageId: receipt?.messageId || null
      };
    }
  });

  tools.push({
    name: 'get_group_info',
    description: 'Read metadata and a bounded participant summary for the current WhatsApp group.',
    scopes: ['group'],
    risk: 'low',
    schema: z.object({}).strict(),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {}
    },
    execute: async (_args, ctx) => {
      if (ctx?.scope !== 'group' || !String(ctx?.chatId || '').endsWith('@g.us')) {
        throw new Error('get_group_info hanya tersedia pada workspace grup (@g.us).');
      }
      if (!waha || typeof waha.getGroupInfo !== 'function') {
        throw new Error('WAHA getGroupInfo tidak tersedia.');
      }
      const info = await waha.getGroupInfo(ctx.chatId);
      let participantsRaw = null;
      if (typeof waha.getGroupParticipants === 'function') {
        try {
          participantsRaw = await waha.getGroupParticipants(ctx.chatId);
        } catch {
          participantsRaw = null;
        }
      }
      const participants = extractParticipantsList(participantsRaw, info);
      const participantCount = participants.length || Number(info?.size || info?.ParticipantCount || 0);
      return {
        groupId: info?.id?._serialized || info?.id || info?.JID || ctx.chatId,
        subject: info?.subject || info?.name || info?.Name || null,
        description: String(info?.description || info?.desc || info?.Topic || '').slice(0, 1000),
        participantCount,
        adminCount: participants.filter((p) => p.isAdmin).length,
        participants: participants.slice(0, MAX_GROUP_PARTICIPANTS),
        truncated: participants.length > MAX_GROUP_PARTICIPANTS
      };
    }
  });

  tools.push({
    name: 'check_whatsapp_number',
    description: 'Verify whether a phone number is registered on WhatsApp (personal DM only).',
    scopes: ['personal'],
    risk: 'low',
    schema: z.object({
      phoneNumber: z.string().min(6).max(32).refine((v) => {
        const digits = v.replace(/@.*$/, '').replace(/\D/g, '');
        return digits.length >= 6 && digits.length <= 16;
      }, 'phoneNumber must contain 6-16 digits')
    }).strict(),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        phoneNumber: { type: 'string', description: 'Phone number with country code, e.g. 628123456789' }
      },
      required: ['phoneNumber']
    },
    execute: async ({ phoneNumber }, ctx) => {
      if (ctx?.scope !== 'personal') {
        throw new Error('check_whatsapp_number hanya tersedia pada workspace personal.');
      }
      if (!waha || typeof waha.checkNumberStatus !== 'function') {
        throw new Error('WAHA checkNumberStatus tidak tersedia.');
      }
      const digits = phoneNumber.replace(/@.*$/, '').replace(/\D/g, '');
      const result = await waha.checkNumberStatus(digits);
      return {
        phoneNumber: digits,
        numberExists: Boolean(result?.numberExists ?? result?.exists ?? result?.isRegistered),
        chatId: result?.chatId || result?.jid || null
      };
    }
  });

  tools.push({
    name: 'get_waha_session_status',
    description: 'Read live WAHA session status combined with the cached session monitor snapshot (personal DM only).',
    scopes: ['personal'],
    risk: 'low',
    schema: z.object({}).strict(),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {}
    },
    execute: async (_args, ctx) => {
      if (ctx?.scope !== 'personal') {
        throw new Error('get_waha_session_status hanya tersedia pada workspace personal.');
      }
      const cached = typeof sessionMonitor?.snapshot === 'function' ? sessionMonitor.snapshot() : null;
      let live = null;
      let liveError = null;
      if (waha && typeof waha.sessionStatus === 'function') {
        try {
          live = await waha.sessionStatus();
        } catch (err) {
          liveError = err?.message || 'Unable to query WAHA session status';
        }
      }
      const liveStatus = live?.status ? String(live.status).trim().toUpperCase() : null;
      const effectiveStatus = liveStatus || cached?.status || 'UNKNOWN';
      const degraded = DEGRADED_STATUSES.has(effectiveStatus);
      return {
        session: live?.name || live?.session || cached?.session || waha?.session || null,
        status: effectiveStatus,
        healthy: !degraded && !liveError,
        degraded,
        me: live?.me ? { id: live.me.id || null, pushName: live.me.pushName || null } : null,
        live,
        ...(liveError ? { liveError } : {}),
        cached
      };
    }
  });

  return tools;
}

module.exports = { createWahaTools };
