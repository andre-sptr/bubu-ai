const { formatWhatsAppText } = require('./whatsapp-formatter');

const DETERMINISTIC_FAILURE_CODES = new Set(['ENOENT', 'EACCES', 'EISDIR']);
const DETERMINISTIC_FAILURE_STATUSES = new Set([400, 401, 403, 404, 413, 415, 422]);

function classifyDeliveryStatus(cause, sentTypes = []) {
  if (Array.isArray(sentTypes) && sentTypes.length > 0) {
    return 'uncertain';
  }
  const code = String(cause?.code || '').toUpperCase();
  const status = Number(cause?.status || cause?.statusCode || cause?.response?.status || 0);
  if (DETERMINISTIC_FAILURE_CODES.has(code) || DETERMINISTIC_FAILURE_STATUSES.has(status)) {
    return 'failed';
  }
  return 'uncertain';
}

class ResponseDeliveryError extends Error {
  constructor(message, { type, chatId, cause, sentTypes = [], deliveryStatus } = {}) {
    super(message, { cause });
    this.name = 'ResponseDeliveryError';
    this.type = type || 'unknown';
    this.chatId = chatId;
    this.sentTypes = sentTypes;
    this.deliveryStatus = deliveryStatus || classifyDeliveryStatus(cause, sentTypes);
    const status = Number(cause?.status || cause?.statusCode || cause?.response?.status || 0);
    if (status) this.status = status;
    if (cause?.code) this.code = cause.code;
  }
}

function messageIdOf(response) {
  return response?.key?.id ||
    response?.id ||
    response?.message?.id ||
    response?.messageId ||
    null;
}

class ResponseHandler {
  constructor({ waha, mediaService = null, config = null, logger = null } = {}) {
    if (!waha) throw new Error('ResponseHandler requires a WAHA client.');
    this.waha = waha;
    this.mediaService = mediaService;
    this.config = config;
    this.logger = logger || { warn: () => {}, error: () => {} };
  }

  async _deliver({ type, chatId, meta = {}, sendFn, errorMessage }) {
    try {
      const response = await sendFn();
      const receipt = {
        ok: true,
        type,
        chatId,
        ...meta,
        messageId: messageIdOf(response),
        response
      };
      this.logger.info?.({ type, chatId, ...meta, messageId: receipt.messageId }, 'WhatsApp response delivered');
      return receipt;
    } catch (cause) {
      const deliveryError = new ResponseDeliveryError(errorMessage, { type, chatId, cause });
      const logMsg = deliveryError.deliveryStatus === 'failed'
        ? 'WhatsApp response delivery failed'
        : 'WhatsApp response delivery uncertain';
      this.logger.warn?.({ type, chatId, deliveryStatus: deliveryError.deliveryStatus, error: cause.message }, logMsg);
      throw deliveryError;
    }
  }

  async sendText(text, chatId, options = {}) {
    if (!chatId) throw new Error('A target chatId is required for text delivery.');
    const outgoingText = options.format === false
      ? String(text ?? '')
      : formatWhatsAppText(text);
    const { format: _format, ...wahaOptions } = options;
    return this._deliver({
      type: 'text',
      chatId,
      sendFn: () => this.waha.sendText(outgoingText, chatId, wahaOptions),
      errorMessage: 'WhatsApp text delivery could not be confirmed.'
    });
  }

  async sendVoice(buffer, chatId, options = {}) {
    if (!chatId) throw new Error('A target chatId is required for voice delivery.');
    if (!buffer || !Buffer.from(buffer).length) throw new Error('Voice payload is empty.');
    return this._deliver({
      type: 'voice',
      chatId,
      sendFn: () => this.waha.sendVoice(buffer, chatId, options),
      errorMessage: 'WhatsApp voice delivery could not be confirmed.'
    });
  }

  async sendFile(filePath, chatId, options = {}) {
    if (!chatId || !filePath) throw new Error('A target chatId and filePath are required.');
    return this._deliver({
      type: 'file',
      chatId,
      meta: { filename: options.filename || null },
      sendFn: () => this.waha.sendFile(filePath, chatId, {
        ...options,
        caption: options.caption ? formatWhatsAppText(options.caption) : ''
      }),
      errorMessage: 'WhatsApp file delivery could not be confirmed.'
    });
  }

  async sendImage(filePath, chatId, options = {}) {
    if (!chatId || !filePath) throw new Error('A target chatId and filePath are required.');
    return this._deliver({
      type: 'image',
      chatId,
      meta: { filename: options.filename || null },
      sendFn: () => this.waha.sendImage(filePath, chatId, {
        ...options,
        caption: options.caption ? formatWhatsAppText(options.caption) : ''
      }),
      errorMessage: 'WhatsApp image delivery could not be confirmed.'
    });
  }

  async sendVideo(filePath, chatId, options = {}) {
    if (!chatId || !filePath) throw new Error('A target chatId and filePath are required.');
    if (typeof this.waha.sendVideo !== 'function') {
      throw new Error('The configured WAHA client does not support video delivery.');
    }
    return this._deliver({
      type: 'video',
      chatId,
      meta: { filename: options.filename || null },
      sendFn: () => this.waha.sendVideo(filePath, chatId, {
        ...options,
        caption: options.caption ? formatWhatsAppText(options.caption) : ''
      }),
      errorMessage: 'WhatsApp video delivery could not be confirmed.'
    });
  }

  async sendReaction(chatId, messageId, reaction = '') {
    if (!chatId || !messageId) {
      throw new Error('A target chatId and messageId are required for reaction delivery.');
    }
    if (typeof this.waha.sendReaction !== 'function') {
      throw new Error('The configured WAHA client does not support reaction delivery.');
    }
    const normalizedReaction = String(reaction ?? '').trim();
    return this._deliver({
      type: 'reaction',
      chatId,
      meta: { targetMessageId: messageId, reaction: normalizedReaction },
      sendFn: () => this.waha.sendReaction(chatId, messageId, normalizedReaction),
      errorMessage: 'WhatsApp reaction delivery could not be confirmed.'
    });
  }

  async sendPoll(chatId, { name, options, multipleAnswers = false, replyTo } = {}) {
    if (!chatId) throw new Error('A target chatId is required for poll delivery.');
    if (typeof this.waha.sendPoll !== 'function') {
      throw new Error('The configured WAHA client does not support poll delivery.');
    }
    const formattedName = formatWhatsAppText(name) || String(name ?? '').trim();
    if (!formattedName) throw new Error('A poll name is required.');
    const formattedOptions = Array.isArray(options)
      ? options.map((opt) => formatWhatsAppText(opt) || String(opt ?? '').trim()).filter(Boolean)
      : [];
    if (formattedOptions.length < 2) {
      throw new Error('A poll requires at least 2 non-empty options.');
    }
    const payload = {
      name: formattedName,
      options: formattedOptions,
      multipleAnswers: Boolean(multipleAnswers),
      ...(replyTo ? { replyTo } : {})
    };
    return this._deliver({
      type: 'poll',
      chatId,
      meta: { name: formattedName, options: formattedOptions },
      sendFn: () => this.waha.sendPoll(chatId, payload),
      errorMessage: 'WhatsApp poll delivery could not be confirmed.'
    });
  }

  async sendLocation(chatId, { latitude, longitude, title = '', replyTo } = {}) {
    if (!chatId) throw new Error('A target chatId is required for location delivery.');
    if (typeof this.waha.sendLocation !== 'function') {
      throw new Error('The configured WAHA client does not support location delivery.');
    }
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new Error('Valid latitude and longitude are required for location delivery.');
    }
    const formattedTitle = title ? formatWhatsAppText(title) : '';
    const payload = {
      latitude: lat,
      longitude: lon,
      title: formattedTitle,
      ...(replyTo ? { replyTo } : {})
    };
    return this._deliver({
      type: 'location',
      chatId,
      meta: { latitude: lat, longitude: lon, title: formattedTitle },
      sendFn: () => this.waha.sendLocation(chatId, payload),
      errorMessage: 'WhatsApp location delivery could not be confirmed.'
    });
  }

  async sendContactVcard(chatId, contacts, options = {}) {
    if (!chatId) throw new Error('A target chatId is required for contact delivery.');
    if (typeof this.waha.sendContactVcard !== 'function') {
      throw new Error('The configured WAHA client does not support contact vCard delivery.');
    }
    const contactList = Array.isArray(contacts) ? contacts.filter(Boolean) : (contacts ? [contacts] : []);
    if (contactList.length === 0) {
      throw new Error('At least one contact is required for contact vCard delivery.');
    }
    const sendOptions = options?.replyTo ? { replyTo: options.replyTo } : {};
    return this._deliver({
      type: 'contact',
      chatId,
      meta: { count: contactList.length },
      sendFn: () => this.waha.sendContactVcard(chatId, contactList, sendOptions),
      errorMessage: 'WhatsApp contact delivery could not be confirmed.'
    });
  }

  async sendAssistantResponse(text, chatId, mode = 'text', options = {}) {
    const normalizedMode = ['text', 'voice', 'both'].includes(mode) ? mode : 'text';
    const textOptions = {};
    const voiceOptions = {};
    if (options?.replyTo) {
      textOptions.replyTo = options.replyTo;
      voiceOptions.replyTo = options.replyTo;
    }
    if (Array.isArray(options?.mentions) && options.mentions.length > 0) {
      textOptions.mentions = options.mentions;
      voiceOptions.mentions = options.mentions;
    }
    if (options?.format === false) {
      textOptions.format = false;
    }
    const hasTextOptions = Object.keys(textOptions).length > 0;
    const hasVoiceOptions = Object.keys(voiceOptions).length > 0;

    if (normalizedMode === 'text') {
      const receipt = hasTextOptions
        ? await this.sendText(text, chatId, textOptions)
        : await this.sendText(text, chatId);
      return { ok: true, mode: normalizedMode, deliveries: [receipt] };
    }

    if (!this.mediaService || typeof this.mediaService.createVoiceReply !== 'function' ||
        (this.config?.media && (!this.config.media.enabled || !this.config.media.piperModelPath))) {
      throw new Error('Voice response is enabled but the media/TTS service is unavailable or not configured.');
    }

    let audio;
    try {
      audio = await this.mediaService.createVoiceReply(String(text ?? ''));
    } catch (cause) {
      throw new ResponseDeliveryError(
        `Voice generation failed; no text fallback was sent: ${cause.message}`,
        { type: 'voice_generation', chatId, cause, deliveryStatus: 'failed' }
      );
    }

    if (normalizedMode === 'voice') {
      const receipt = hasVoiceOptions
        ? await this.sendVoice(audio, chatId, voiceOptions)
        : await this.sendVoice(audio, chatId);
      return { ok: true, mode: normalizedMode, deliveries: [receipt] };
    }

    const textReceipt = hasTextOptions
      ? await this.sendText(text, chatId, textOptions)
      : await this.sendText(text, chatId);
    try {
      const voiceReceipt = hasVoiceOptions
        ? await this.sendVoice(audio, chatId, voiceOptions)
        : await this.sendVoice(audio, chatId);
      return { ok: true, mode: normalizedMode, deliveries: [textReceipt, voiceReceipt] };
    } catch (cause) {
      throw new ResponseDeliveryError(
        'Text was delivered, but voice delivery could not be confirmed.',
        { type: 'text_and_voice', chatId, cause, sentTypes: ['text'] }
      );
    }
  }

  async send({
    type,
    chatId,
    text,
    buffer,
    filePath,
    messageId,
    reaction,
    name,
    poll,
    multipleAnswers,
    latitude,
    longitude,
    title,
    contacts,
    replyTo,
    options = {},
    mode = 'text'
  }) {
    switch (type) {
      case 'text':
        return this.sendAssistantResponse(text, chatId, mode, Array.isArray(options) ? {} : options);
      case 'voice':
        return this.sendVoice(buffer, chatId, options);
      case 'file':
        return this.sendFile(filePath, chatId, options);
      case 'image':
        return this.sendImage(filePath, chatId, options);
      case 'video':
        return this.sendVideo(filePath, chatId, options);
      case 'reaction':
        return this.sendReaction(
          chatId,
          messageId ?? options?.messageId,
          reaction ?? options?.reaction
        );
      case 'poll': {
        const pollSpec = poll && typeof poll === 'object'
          ? { ...poll, ...(replyTo ? { replyTo } : {}) }
          : Array.isArray(options)
            ? { name, options, multipleAnswers, replyTo }
            : { name, ...(options || {}), ...(replyTo ? { replyTo } : {}) };
        return this.sendPoll(chatId, pollSpec);
      }
      case 'location': {
        const locSpec = latitude !== undefined || longitude !== undefined
          ? { latitude, longitude, title, replyTo: replyTo ?? options?.replyTo }
          : (options || {});
        return this.sendLocation(chatId, locSpec);
      }
      case 'contact':
        return this.sendContactVcard(
          chatId,
          contacts ?? options?.contacts,
          replyTo ? { replyTo } : (Array.isArray(options) ? {} : options)
        );
      default:
        throw new Error(`Unsupported response type: ${type}`);
    }
  }
}

module.exports = { ResponseHandler, ResponseDeliveryError, messageIdOf, classifyDeliveryStatus };
