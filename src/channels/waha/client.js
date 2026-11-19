const fs = require('node:fs');
const axios = require('axios');
const { normalizeIncoming, extractQuoteContext, unwrapQuotedMessage } = require('./normalizer');

class WahaClient {
  constructor({ baseUrl, session, apiKey, timeoutMs = 15000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.session = session;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async request(method, endpoint, data) {
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
    const data = fs.readFileSync(filePath).toString('base64');
    return this.request('POST', '/api/sendImage', {
      session: this.session,
      chatId,
      caption,
      file: { filename, mimetype, data }
    });
  }

  sendFile(filePath, chatId, { filename, mimetype, caption = '' } = {}) {
    const data = fs.readFileSync(filePath).toString('base64');
    return this.request('POST', '/api/sendFile', {
      session: this.session,
      chatId,
      caption,
      file: { filename, mimetype, data }
    });
  }

  sendVideo(filePath, chatId, { filename, mimetype = 'video/mp4', caption = '' } = {}) {
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

module.exports = { WahaClient, normalizeIncoming, extractQuoteContext, unwrapQuotedMessage };
