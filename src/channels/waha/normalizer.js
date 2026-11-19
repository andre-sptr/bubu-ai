const { normalizeJid } = require('../../config/env');

function extractIdString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    if (typeof value._serialized === 'string' && value._serialized.trim()) return value._serialized.trim();
    if (typeof value.id === 'string' && value.id.trim()) return value.id.trim();
    if (value.id && typeof value.id === 'object') {
      const nested = extractIdString(value.id);
      if (nested) return nested;
    }
    if (typeof value.jid === 'string' && value.jid.trim()) return value.jid.trim();
    if (typeof value.remoteJid === 'string' && value.remoteJid.trim()) return value.remoteJid.trim();
    if (typeof value.user === 'string' && value.user.trim()) {
      const server = typeof value.server === 'string' && value.server.trim() ? value.server.trim() : '';
      return server ? `${value.user.trim()}@${server}` : value.user.trim();
    }
  }
  return '';
}

function firstNonEmpty(values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}

function unwrapQuotedMessage(value) {
  let current = value && typeof value === 'object' ? value : null;
  for (let i = 0; i < 5 && current; i++) {
    const wrapped = current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current.documentWithCaptionMessage?.message;
    if (!wrapped || typeof wrapped !== 'object') break;
    current = wrapped;
  }
  return current || {};
}

function collectMentionIds(payload = {}, info = {}, messageSources = []) {
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
  for (const source of messageSources) {
    if (!source || typeof source !== 'object') continue;
    const unwrapped = unwrapQuotedMessage(source);
    candidates.push(
      unwrapped.extendedTextMessage?.contextInfo?.mentionedJid,
      unwrapped.imageMessage?.contextInfo?.mentionedJid,
      unwrapped.videoMessage?.contextInfo?.mentionedJid,
      unwrapped.documentMessage?.contextInfo?.mentionedJid,
      unwrapped.audioMessage?.contextInfo?.mentionedJid
    );
  }
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

function extractQuoteContext({ payload, messageSources, currentChatId }) {
  const contexts = [];
  if (payload?.contextInfo && typeof payload.contextInfo === 'object') {
    contexts.push(payload.contextInfo);
  }
  for (const rawSource of messageSources) {
    if (!rawSource || typeof rawSource !== 'object') continue;
    for (const source of [rawSource, unwrapQuotedMessage(rawSource)]) {
      contexts.push(
        source.extendedTextMessage?.contextInfo,
        source.imageMessage?.contextInfo,
        source.videoMessage?.contextInfo,
        source.audioMessage?.contextInfo,
        source.documentMessage?.contextInfo,
        source.documentWithCaptionMessage?.message?.documentMessage?.contextInfo,
        source.messageContextInfo,
        source.contextInfo
      );
    }
  }

  const contextInfo = contexts.find((item) =>
    item && typeof item === 'object' && item.quotedMessage
  ) || contexts.find((item) =>
    item && typeof item === 'object' && (item.stanzaID || item.stanzaId)
  ) || null;
  const replyTo = payload.replyTo && typeof payload.replyTo === 'object'
    ? payload.replyTo : null;
  const quotedRaw = contextInfo?.quotedMessage ||
    replyTo?._data?.Message ||
    replyTo?._data?.RawMessage ||
    replyTo?.quotedMessage ||
    null;

  const replyToBody = firstNonEmpty([
    replyTo?.body,
    replyTo?.text,
    replyTo?.caption
  ]);
  const hasReplyToPayload = Boolean(
    replyTo && (
      replyToBody ||
      replyTo.hasMedia === true ||
      (replyTo.media && typeof replyTo.media === 'object')
    )
  );

  if ((!quotedRaw || typeof quotedRaw !== 'object') && !hasReplyToPayload) {
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
  ].map(extractIdString).filter(Boolean);

  const sameChat = explicitChatIds.every((id) =>
    normalizeJid(id) === normalizeJid(currentChatId)
  );
  if (!sameChat) {
    return { present: false, rejected: true, reason: 'cross_chat_reference' };
  }

  let type = 'unknown';
  let quotedText = '';
  let mimeType = '';
  let hasMedia = false;

  if (quotedRaw && typeof quotedRaw === 'object') {
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
    type = entry?.[0] || 'unknown';
    const content = entry?.[1] || {};
    quotedText = firstNonEmpty([
      content.text,
      content.caption,
      content.title,
      content.fileName,
      content.filename,
      replyToBody
    ]);
    mimeType = String(content.mimetype || content.mimeType || '').slice(0, 120);
    hasMedia = ['image', 'video', 'audio', 'document'].includes(type);
  } else {
    const replyMedia = replyTo?.media && typeof replyTo.media === 'object' ? replyTo.media : null;
    mimeType = String(replyMedia?.mimetype || replyMedia?.mimeType || replyTo?.mimetype || '').slice(0, 120);
    hasMedia = Boolean(replyTo?.hasMedia === true || replyMedia);
    const mediaTypeHint = String(replyMedia?.mediaType || replyTo?.type || '').toLowerCase();
    if (hasMedia) {
      if (['image', 'video', 'audio', 'document'].includes(mediaTypeHint)) {
        type = mediaTypeHint;
      } else if (mimeType.startsWith('image/')) {
        type = 'image';
      } else if (mimeType.startsWith('video/')) {
        type = 'video';
      } else if (mimeType.startsWith('audio/')) {
        type = 'audio';
      } else {
        type = 'document';
      }
      quotedText = replyToBody || String(replyMedia?.filename || replyMedia?.fileName || '').trim();
    } else {
      type = 'text';
      quotedText = replyToBody;
    }
  }

  const quotedMessageId = extractIdString(
    contextInfo?.stanzaID || contextInfo?.stanzaId || replyTo?.id || ''
  );
  const quotedParticipant = extractIdString(
    contextInfo?.participant || contextInfo?.Participant || replyTo?.participant || replyTo?.author || ''
  );

  return {
    present: true,
    rejected: false,
    source: 'embedded_webhook',
    sameChat: true,
    referenceIdPresent: Boolean(quotedMessageId),
    quotedMessageId,
    quotedParticipant,
    type,
    text: quotedText.trim().slice(0, 4000),
    mimeType,
    hasMedia
  };
}

function normalizeBotLid(value) {
  const raw = extractIdString(value).toLowerCase();
  if (!raw) return '';
  if (raw.includes('@')) {
    const normalized = normalizeJid(raw);
    return normalized.endsWith('@lid') ? normalized : '';
  }
  const bare = raw.split(':')[0].trim();
  return bare && !/\s/.test(bare) ? `${bare}@lid` : '';
}

function normalizeIncoming(body = {}) {
  const payload = body.payload || body.data || body;
  const data = payload._data || {};
  const info = data.Info || payload.Info || {};
  const rawMessageSources = [data.Message, data.RawMessage, payload.message, payload._data?.message]
    .filter((item, index, all) => item && typeof item === 'object' && all.indexOf(item) === index);
  const message = unwrapQuotedMessage(data.Message || data.RawMessage || payload.message || payload._data?.message || {});
  const rawMessage = unwrapQuotedMessage(data.RawMessage || data.Message || payload.message || {});
  const messageSources = [...rawMessageSources];
  for (const source of [message, rawMessage]) {
    if (source && typeof source === 'object' && !messageSources.includes(source)) {
      messageSources.push(source);
    }
  }

  const chatId = extractIdString(payload.from) ||
    extractIdString(payload.chatId) ||
    extractIdString(payload.chat?.id) ||
    extractIdString(payload.chat) ||
    extractIdString(info.Chat) || '';
  const senderId = extractIdString(payload.author) ||
    extractIdString(payload.participant) ||
    extractIdString(payload.sender?.id) ||
    extractIdString(payload.sender) ||
    extractIdString(info.Sender) ||
    chatId;

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
      isPtt: nativeMedia?.PTT === true || nativeMedia?.ptt === true ||
        source.isPtt === true || source.ptt === true ||
        String(info.MediaType || '').toLowerCase() === 'ptt',
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

  const eventId = extractIdString(payload.id) ||
    extractIdString(payload.messageId) ||
    extractIdString(info.ID) ||
    extractIdString(data.ID) || '';
  const fromMe = payload.fromMe === true || info.IsFromMe === true || body.me === true;
  const eventType = body.event || body.type || 'message';
  const rawBotId = extractIdString(
    body?.me?.id ?? body?.me?._serialized ?? payload?.me?.id ?? payload?.me?._serialized
  );
  const botId = rawBotId ? normalizeJid(rawBotId) : '';
  const botLid = normalizeBotLid(body?.me?.lid ?? payload?.me?.lid ?? '');
  return {
    chatId,
    senderId,
    text: typeof text === 'string' ? text : '',
    bodyText,
    captionText,
    media,
    hasMedia,
    quote,
    mentions: collectMentionIds(payload, info, messageSources),
    eventId,
    fromMe,
    eventType,
    botId,
    botLid,
    raw: payload
  };
}

function normalizeSessionStatus(body = {}) {
  const payload = (body && typeof body.payload === 'object' && body.payload)
    || (body && typeof body.data === 'object' && body.data)
    || body
    || {};
  const rawStatus = payload.status || body?.status || '';
  const status = String(rawStatus).trim().toUpperCase() || 'UNKNOWN';
  const session = extractIdString(payload.name || payload.session || body?.session || 'default') || 'default';
  const meId = extractIdString(body?.me?.id || body?.me || payload?.me?.id || payload?.me || '');
  const timestamp = body?.timestamp ?? payload?.timestamp ?? null;
  return {
    eventType: String(body?.event || body?.type || 'session.status'),
    session,
    status,
    meId: meId ? normalizeJid(meId) : '',
    timestamp
  };
}

function normalizePollVote(body) {
  if (!body || typeof body !== 'object') return null;
  const event = String(body.event || body.type || '').trim().toLowerCase();
  if (event && event !== 'poll.vote') return null;

  const payload = (body.payload && typeof body.payload === 'object' ? body.payload : null) ||
    (body.data && typeof body.data === 'object' ? body.data : null) ||
    body;
  if (!payload || typeof payload !== 'object') return null;

  const pollMessageId = extractIdString(payload.pollMessageId) ||
    extractIdString(payload.poll?.id) ||
    extractIdString(payload.poll?.messageId) ||
    (typeof payload.poll === 'string' ? payload.poll.trim() : '') ||
    extractIdString(payload.pollKey?.id) ||
    extractIdString(payload.vote?.pollId) ||
    extractIdString(payload.vote?.parentMessageId) ||
    extractIdString(payload._data?.pollCreationMessageKey?.id);

  if (!pollMessageId) return null;

  const session = extractIdString(body.session) ||
    extractIdString(payload.session) ||
    extractIdString(body.name) ||
    extractIdString(payload.name) ||
    'default';

  const rawVoterId = extractIdString(payload.voterId) ||
    extractIdString(payload.voter) ||
    extractIdString(payload.vote?.from) ||
    extractIdString(payload.vote?.voter) ||
    extractIdString(payload.vote?.participant) ||
    extractIdString(payload.vote?.author) ||
    extractIdString(payload.vote?.sender) ||
    extractIdString(payload.author) ||
    extractIdString(payload.participant) ||
    extractIdString(payload.from) ||
    extractIdString(payload._data?.Info?.Sender);
  const voterId = rawVoterId ? normalizeJid(rawVoterId) : '';

  const rawOptions = payload.vote?.selectedOptions ??
    payload.selectedOptions ??
    payload.vote?.options ??
    payload.options ??
    [];
  const selectedOptions = Array.isArray(rawOptions)
    ? rawOptions
      .map((opt) => {
        if (typeof opt === 'string') return opt.trim();
        if (opt && typeof opt === 'object') {
          return String(opt.name ?? opt.optionName ?? opt.text ?? opt.title ?? opt.value ?? '').trim();
        }
        return '';
      })
      .filter(Boolean)
    : [];

  return {
    session,
    pollMessageId,
    voterId,
    selectedOptions
  };
}

module.exports = {
  collectMentionIds,
  unwrapQuotedMessage,
  extractQuoteContext,
  normalizeIncoming,
  normalizeSessionStatus,
  normalizePollVote
};
