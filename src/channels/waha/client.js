const { normalizeJid } = require('../../config/env');

class WahaClient {
  constructor({ baseUrl, session, apiKey, timeoutMs = 15000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.session = session;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async request(method, endpoint, data) {
    const axios = require('axios');
    const response = await axios({
      method, url: `${this.baseUrl}${endpoint}`, data,
      timeout: this.timeoutMs,
      headers: {
        ...(this.apiKey ? { 'X-Api-Key': this.apiKey } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {})
      }
    });
    return response.data;
  }

  sendSeen(chatId) {
    // Compatible with all WAHA engines. This marks unread messages in the chat
    // as read; messageIds targeting is engine-specific (NOWEB/GOWS).
    return this.request('POST', '/api/sendSeen', {
      session: this.session,
      chatId
    });
  }

  startTyping(chatId) {
    return this.request('POST', '/api/startTyping', {
      session: this.session,
      chatId
    });
  }

  stopTyping(chatId) {
    return this.request('POST', '/api/stopTyping', {
      session: this.session,
      chatId
    });
  }

  sendText(text, chatId, options = {}) {
    const body = { session: this.session, chatId, text };
    if (options.replyTo) body.reply_to = options.replyTo;
    if (options.mentions?.length) body.mentions = options.mentions;
    return this.request('POST', '/api/sendText', body);
  }

  sendVoice(buffer, chatId, { filename = 'bubu-voice.ogg', mimetype = 'audio/ogg; codecs=opus', convert = false } = {}) {
    return this.request('POST', '/api/sendVoice', {
      session: this.session,
      chatId,
      file: {
        filename,
        mimetype,
        data: Buffer.from(buffer).toString('base64')
      },
      convert
    });
  }

  sendImage(filePath, chatId, { filename, mimetype, caption = '' } = {}) {
    const fs = require('node:fs');
    const data = fs.readFileSync(filePath).toString('base64');
    return this.request('POST', '/api/sendImage', {
      session: this.session,
      chatId,
      caption,
      file: { filename, mimetype, data }
    });
  }

  sendFile(filePath, chatId, { filename, mimetype, caption = '' } = {}) {
    const fs = require('node:fs');
    const data = fs.readFileSync(filePath).toString('base64');
    return this.request('POST', '/api/sendFile', {
      session: this.session,
      chatId,
      caption,
      file: { filename, mimetype, data }
    });
  }

  sendVideo(filePath, chatId, { filename, mimetype = 'video/mp4', caption = '' } = {}) {
    const fs = require('node:fs');
    const data = fs.readFileSync(filePath).toString('base64');
    return this.request('POST', '/api/sendVideo', {
      session: this.session,
      chatId,
      caption,
      file: { filename, mimetype, data }
    });
  }

  async resolveLid(lid) {
    if (!String(lid).endsWith('@lid')) return lid;
    const data = await this.request('GET', `/api/${encodeURIComponent(this.session)}/lids/${encodeURIComponent(lid)}`);
    const candidate = data?.pn || data?.phone || data?.phoneNumber ||
      data?.jid || data?.id?._serialized || data?.id || data?.result?.pn ||
      data?.result?.jid || data?.result?.id || lid;
    return typeof candidate === 'string' ? candidate : candidate?._serialized || candidate?.user || lid;
  }

  async sessionStatus() {
    return this.request('GET', `/api/sessions/${encodeURIComponent(this.session)}`);
  }
}

function collectMentionIds(payload, info) {
  const candidates = [
    payload.mentionedIds,
    payload.mentionIds,
    payload.mentions,
    payload.contextInfo?.mentionedJid,
    payload.message?.extendedTextMessage?.contextInfo?.mentionedJid,
    payload.message?.imageMessage?.contextInfo?.mentionedJid,
    payload.message?.videoMessage?.contextInfo?.mentionedJid,
    payload.message?.documentMessage?.contextInfo?.mentionedJid,
    payload._data?.message?.extendedTextMessage?.contextInfo?.mentionedJid,
    payload._data?.message?.imageMessage?.contextInfo?.mentionedJid,
    payload._data?.message?.videoMessage?.contextInfo?.mentionedJid,
    payload._data?.message?.documentMessage?.contextInfo?.mentionedJid,
    info.MentionedJID,
    info.MentionedJIDs,
    info.MentionedJid,
    info.MentionedJids,
    info.ContextInfo?.MentionedJID,
    info.ContextInfo?.MentionedJIDs
  ];
  const ids = new Set();
  const add = (value) => {
    if (!value) return;
    if (typeof value === 'string') {
      ids.add(value.trim());
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    if (typeof value === 'object') {
      add(value.id);
      add(value.jid);
      add(value._serialized);
      add(value.user);
      add(value.phone);
      add(value.phoneNumber);
    }
  };
  for (const candidate of candidates) add(candidate);
  return [...ids].filter(Boolean);
}

function unwrapQuotedMessage(value) {
  let current = value && typeof value === 'object' ? value : null;
  for (let i = 0; i < 3 && current; i++) {
    const wrapped = current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.documentWithCaptionMessage?.message;
    if (!wrapped || typeof wrapped !== 'object') break;
    current = wrapped;
  }
  return current || {};
}

function extractQuoteContext({ payload, messageSources, currentChatId }) {
  const contexts = [];
  for (const source of messageSources) {
    if (!source || typeof source !== 'object') continue;
    contexts.push(
      source.extendedTextMessage?.contextInfo,
      source.imageMessage?.contextInfo,
      source.videoMessage?.contextInfo,
      source.audioMessage?.contextInfo,
      source.documentMessage?.contextInfo,
      source.messageContextInfo
    );
  }

  const contextInfo = contexts.find((item) =>
    item && typeof item === 'object' && item.quotedMessage
  ) || null;
  const replyTo = payload.replyTo && typeof payload.replyTo === 'object'
    ? payload.replyTo : null;
  const quotedRaw = contextInfo?.quotedMessage ||
    replyTo?._data?.Message ||
    replyTo?._data?.RawMessage ||
    replyTo?.quotedMessage ||
    null;

  if (!quotedRaw || typeof quotedRaw !== 'object') {
    return { present: false, rejected: false };
  }

  const explicitChatIds = [
    contextInfo?.remoteJid,
    contextInfo?.remoteJID,
    replyTo?.chatId,
    replyTo?.from,
    replyTo?.remoteJid,
    replyTo?._data?.Info?.Chat,
    replyTo?._data?.key?.remoteJid
  ].filter((value) => typeof value === 'string' && value.trim());

  const sameChat = explicitChatIds.every((id) =>
    normalizeJid(id) === normalizeJid(currentChatId)
  );
  if (!sameChat) {
    return { present: false, rejected: true, reason: 'cross_chat_reference' };
  }

  const quoted = unwrapQuotedMessage(quotedRaw);
  const types = [
    ['image', quoted.imageMessage],
    ['video', quoted.videoMessage],
    ['audio', quoted.audioMessage],
    ['document', quoted.documentMessage],
    ['text', quoted.extendedTextMessage],
    ['text', typeof quoted.conversation === 'string' ? { text: quoted.conversation } : null]
  ];
  const entry = types.find(([, value]) => value && typeof value === 'object');
  const type = entry?.[0] || 'unknown';
  const content = entry?.[1] || {};
  const quotedText = typeof content.text === 'string' ? content.text :
    typeof content.caption === 'string' ? content.caption :
    typeof content.title === 'string' ? content.title :
    typeof content.fileName === 'string' ? content.fileName :
    typeof content.filename === 'string' ? content.filename : '';

  return {
    present: true,
    rejected: false,
    source: 'embedded_webhook',
    sameChat: true,
    referenceIdPresent: Boolean(contextInfo?.stanzaID || contextInfo?.stanzaId || replyTo?.id),
    type,
    text: quotedText.trim().slice(0, 4000),
    mimeType: String(content.mimetype || content.mimeType || '').slice(0, 120),
    hasMedia: ['image', 'video', 'audio', 'document'].includes(type)
  };
}

function normalizeIncoming(body = {}) {
  const payload = body.payload || body.data || body;
  const data = payload._data || {};
  const info = data.Info || payload.Info || {};
  const message = data.Message || data.RawMessage || payload.message || payload._data?.message || {};
  const rawMessage = data.RawMessage || data.Message || payload.message || {};
  const messageSources = [data.Message, data.RawMessage, payload.message, payload._data?.message]
    .filter((item, index, all) => item && typeof item === 'object' && all.indexOf(item) === index);
  const chatId = payload.from || payload.chatId || payload.chat?.id || info.Chat || '';
  const senderId = payload.author || payload.participant || payload.sender?.id || info.Sender || chatId;

  const nativeMediaCandidates = [
    ['image', message.imageMessage || rawMessage.imageMessage],
    ['video', message.videoMessage || rawMessage.videoMessage],
    ['audio', message.audioMessage || rawMessage.audioMessage],
    ['document', message.documentMessage || rawMessage.documentMessage],
    ['document', message.documentWithCaptionMessage?.message?.documentMessage ||
      rawMessage.documentWithCaptionMessage?.message?.documentMessage]
  ];
  const nativeMediaEntry = nativeMediaCandidates.find(([, value]) =>
    value && typeof value === 'object'
  );
  const [nativeKind, nativeMedia] = nativeMediaEntry || [null, null];

  const existingMedia = payload.media || data.media || null;
  let media = null;
  if (existingMedia || nativeMedia) {
    const source = existingMedia || {};
    media = {
      ...source,
      url: source.url || source.URL || nativeMedia?.URL || nativeMedia?.url || '',
      filename: source.filename || source.fileName || nativeMedia?.fileName ||
        nativeMedia?.filename || nativeMedia?.title || '',
      mimetype: source.mimetype || source.mimeType || nativeMedia?.mimetype ||
        nativeMedia?.mimeType || '',
      mediaType: info.MediaType || nativeKind || source.mediaType || '',
      isPtt: nativeMedia?.PTT === true || source.isPtt === true,
      fileLength: source.fileLength ?? nativeMedia?.fileLength ?? null,
      durationSeconds: source.durationSeconds ?? nativeMedia?.seconds ?? null
    };
  }

  const bodyCandidates = [
    payload.body,
    payload.text,
    message.conversation,
    message.extendedTextMessage?.text,
    rawMessage.conversation,
    rawMessage.extendedTextMessage?.text
  ];
  const captionCandidates = [
    payload.caption,
    message.imageMessage?.caption,
    message.videoMessage?.caption,
    message.documentMessage?.caption,
    message.documentWithCaptionMessage?.message?.documentMessage?.caption,
    rawMessage.imageMessage?.caption,
    rawMessage.videoMessage?.caption,
    rawMessage.documentMessage?.caption,
    rawMessage.documentWithCaptionMessage?.message?.documentMessage?.caption
  ];
  const firstNonEmpty = (values) => values.find((value) =>
    typeof value === 'string' && value.trim()
  )?.trim() || '';
  const bodyText = firstNonEmpty(bodyCandidates);
  const captionText = firstNonEmpty(captionCandidates);
  const text = [...new Set([bodyText, captionText].filter(Boolean))].join('\n\n');
  const quote = extractQuoteContext({ payload, messageSources, currentChatId: chatId });

  const hasNativeMedia = Boolean(nativeMedia);
  const hasMedia = payload.hasMedia === true || Boolean(
    media && (media.url || media.mimetype || hasNativeMedia)
  ) || hasNativeMedia || ['image', 'video', 'audio', 'ptt', 'document'].includes(
    String(info.MediaType || '').toLowerCase()
  );

  const eventId = payload.id || payload.messageId || info.ID || data.ID || '';
  const fromMe = payload.fromMe === true || info.IsFromMe === true || body.me === true;
  const eventType = body.event || body.type || 'message';
  return {
    chatId: String(chatId),
    senderId: String(senderId),
    text: typeof text === 'string' ? text : '',
    bodyText,
    captionText,
    media,
    hasMedia,
    quote,
    mentions: collectMentionIds(payload, info),
    eventId: String(eventId),
    fromMe,
    eventType,
    raw: payload
  };
}

module.exports = { WahaClient, normalizeIncoming, extractQuoteContext, unwrapQuotedMessage };
