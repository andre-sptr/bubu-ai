const { formatWhatsAppText } = require('./whatsapp-formatter');

class ResponseDeliveryError extends Error {
  constructor(message, { type, chatId, cause, sentTypes = [] } = {}) {
    super(message, { cause });
    this.name = 'ResponseDeliveryError';
    this.type = type || 'unknown';
    this.chatId = chatId;
    this.sentTypes = sentTypes;
    // WAHA may have accepted a request before a network timeout was observed.
    this.deliveryStatus = 'uncertain';
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

  async sendText(text, chatId, options = {}) {
    if (!chatId) throw new Error('A target chatId is required for text delivery.');
    const outgoingText = options.format === false
      ? String(text ?? '')
      : formatWhatsAppText(text);
    const { format: _format, ...wahaOptions } = options;
    try {
      const response = await this.waha.sendText(outgoingText, chatId, wahaOptions);
      const receipt = {
        ok: true,
        type: 'text',
        chatId,
        messageId: messageIdOf(response),
        response
      };
      this.logger.info?.({ type: receipt.type, chatId, messageId: receipt.messageId }, 'WhatsApp response delivered');
      return receipt;
    } catch (cause) {
      this.logger.warn?.({ type: 'text', chatId, error: cause.message }, 'WhatsApp response delivery uncertain');
      throw new ResponseDeliveryError('WhatsApp text delivery could not be confirmed.', {
        type: 'text', chatId, cause
      });
    }
  }

  async sendVoice(buffer, chatId, options = {}) {
    if (!chatId) throw new Error('A target chatId is required for voice delivery.');
    if (!buffer || !Buffer.from(buffer).length) throw new Error('Voice payload is empty.');
    try {
      const response = await this.waha.sendVoice(buffer, chatId, options);
      const receipt = {
        ok: true,
        type: 'voice',
        chatId,
        messageId: messageIdOf(response),
        response
      };
      this.logger.info?.({ type: receipt.type, chatId, messageId: receipt.messageId }, 'WhatsApp response delivered');
      return receipt;
    } catch (cause) {
      this.logger.warn?.({ type: 'voice', chatId, error: cause.message }, 'WhatsApp response delivery uncertain');
      throw new ResponseDeliveryError('WhatsApp voice delivery could not be confirmed.', {
        type: 'voice', chatId, cause
      });
    }
  }

  async sendFile(filePath, chatId, options = {}) {
    if (!chatId || !filePath) throw new Error('A target chatId and filePath are required.');
    try {
      const response = await this.waha.sendFile(filePath, chatId, {
        ...options,
        caption: options.caption ? formatWhatsAppText(options.caption) : ''
      });
      const receipt = {
        ok: true,
        type: 'file',
        chatId,
        filename: options.filename || null,
        messageId: messageIdOf(response),
        response
      };
      this.logger.info?.({ type: receipt.type, chatId, filename: receipt.filename, messageId: receipt.messageId }, 'WhatsApp response delivered');
      return receipt;
    } catch (cause) {
      this.logger.warn?.({ type: 'file', chatId, error: cause.message }, 'WhatsApp response delivery uncertain');
      throw new ResponseDeliveryError('WhatsApp file delivery could not be confirmed.', {
        type: 'file', chatId, cause
      });
    }
  }

  async sendImage(filePath, chatId, options = {}) {
    if (!chatId || !filePath) throw new Error('A target chatId and filePath are required.');
    try {
      const response = await this.waha.sendImage(filePath, chatId, {
        ...options,
        caption: options.caption ? formatWhatsAppText(options.caption) : ''
      });
      const receipt = {
        ok: true,
        type: 'image',
        chatId,
        filename: options.filename || null,
        messageId: messageIdOf(response),
        response
      };
      this.logger.info?.({ type: receipt.type, chatId, filename: receipt.filename, messageId: receipt.messageId }, 'WhatsApp response delivered');
      return receipt;
    } catch (cause) {
      this.logger.warn?.({ type: 'image', chatId, error: cause.message }, 'WhatsApp response delivery uncertain');
      throw new ResponseDeliveryError('WhatsApp image delivery could not be confirmed.', {
        type: 'image', chatId, cause
      });
    }
  }

  async sendVideo(filePath, chatId, options = {}) {
    if (!chatId || !filePath) throw new Error('A target chatId and filePath are required.');
    if (typeof this.waha.sendVideo !== 'function') {
      throw new Error('The configured WAHA client does not support video delivery.');
    }
    try {
      const response = await this.waha.sendVideo(filePath, chatId, {
        ...options,
        caption: options.caption ? formatWhatsAppText(options.caption) : ''
      });
      const receipt = {
        ok: true,
        type: 'video',
        chatId,
        filename: options.filename || null,
        messageId: messageIdOf(response),
        response
      };
      this.logger.info?.({ type: receipt.type, chatId, filename: receipt.filename, messageId: receipt.messageId }, 'WhatsApp response delivered');
      return receipt;
    } catch (cause) {
      this.logger.warn?.({ type: 'video', chatId, error: cause.message }, 'WhatsApp response delivery uncertain');
      throw new ResponseDeliveryError('WhatsApp video delivery could not be confirmed.', {
        type: 'video', chatId, cause
      });
    }
  }

  async sendAssistantResponse(text, chatId, mode = 'text') {
    const normalizedMode = ['text', 'voice', 'both'].includes(mode) ? mode : 'text';
    if (normalizedMode === 'text') {
      const receipt = await this.sendText(text, chatId);
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
        { type: 'voice_generation', chatId, cause }
      );
    }

    if (normalizedMode === 'voice') {
      const receipt = await this.sendVoice(audio, chatId);
      return { ok: true, mode: normalizedMode, deliveries: [receipt] };
    }

    const textReceipt = await this.sendText(text, chatId);
    try {
      const voiceReceipt = await this.sendVoice(audio, chatId);
      return { ok: true, mode: normalizedMode, deliveries: [textReceipt, voiceReceipt] };
    } catch (cause) {
      throw new ResponseDeliveryError(
        'Text was delivered, but voice delivery could not be confirmed.',
        { type: 'text_and_voice', chatId, cause, sentTypes: ['text'] }
      );
    }
  }

  async send({ type, chatId, text, buffer, filePath, options = {}, mode = 'text' }) {
    switch (type) {
      case 'text':
        return this.sendAssistantResponse(text, chatId, mode);
      case 'voice':
        return this.sendVoice(buffer, chatId, options);
      case 'file':
        return this.sendFile(filePath, chatId, options);
      case 'image':
        return this.sendImage(filePath, chatId, options);
      case 'video':
        return this.sendVideo(filePath, chatId, options);
      default:
        throw new Error(`Unsupported response type: ${type}`);
    }
  }
}

module.exports = { ResponseHandler, ResponseDeliveryError, messageIdOf };
