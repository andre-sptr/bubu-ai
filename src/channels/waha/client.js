const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const axios = require('axios');
const { normalizeJid } = require('../../config/env');
const { normalizeIncoming, extractQuoteContext, unwrapQuotedMessage } = require('./normalizer');

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT']);

function isTransientWahaError(err) {
  const status = Number(err?.response?.status || err?.status || err?.statusCode || 0);
  if (RETRYABLE_STATUSES.has(status)) return true;
  const code = String(err?.code || '').toUpperCase();
  return RETRYABLE_CODES.has(code);
}

function sanitizeWahaError(err, endpoint = '', apiKey = '') {
  const status = Number(err?.response?.status || err?.status || err?.statusCode || 0) || undefined;
  const code = err?.code ? String(err.code) : undefined;
  const responseMessage = typeof err?.response?.data?.message === 'string'
    ? err.response.data.message
    : typeof err?.response?.data?.error === 'string'
      ? err.response.data.error
      : '';
  let message = String(err?.message || 'WAHA request failed');
  if (responseMessage && !message.includes(responseMessage)) {
    message = `${message}: ${responseMessage}`;
  }
  if (apiKey) {
    message = message.split(apiKey).join('[REDACTED]');
  }
  const sanitized = new Error(message);
  sanitized.name = 'WahaRequestError';
  if (status) {
    sanitized.status = status;
    sanitized.response = { status };
  }
  if (code) sanitized.code = code;
  if (endpoint) sanitized.endpoint = endpoint;
  return sanitized;
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function buildMediaPayload({ session, chatId, filename, mimetype, data, caption = '', replyTo, mentions }) {
  const body = {
    session,
    chatId,
    caption,
    file: { filename, mimetype, data }
  };
  if (replyTo) body.reply_to = replyTo;
  if (mentions?.length) body.mentions = mentions;
  return body;
}

class WahaClient {
  constructor({
    baseUrl,
    session,
    apiKey = '',
    timeoutMs = 15000,
    mediaTimeoutMs = 60000,
    typingKeepaliveMs = 12000,
    lidCacheTtlMs = 10 * 60 * 1000,
    lidCacheMaxEntries = 1000,
    retryBaseDelayMs = 50,
    axiosInstance = null
  } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.session = session;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.mediaTimeoutMs = mediaTimeoutMs;
    this.typingKeepaliveMs = typingKeepaliveMs;
    this.lidCacheTtlMs = lidCacheTtlMs;
    this.lidCacheMaxEntries = lidCacheMaxEntries;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this._lidCache = new Map();
    this._lidInFlight = new Map();
    this.httpAgent = new http.Agent({ keepAlive: true });
    this.httpsAgent = new https.Agent({ keepAlive: true });
    this.http = axiosInstance || axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeoutMs,
      maxRedirects: 0,
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent
    });
  }

  close() {
    this.httpAgent?.destroy?.();
    this.httpsAgent?.destroy?.();
  }

  async request(method, endpoint, data, options = {}) {
    const timeout = options.timeoutMs ?? this.timeoutMs;
    try {
      const response = await this.http.request({
        method,
        url: endpoint,
        ...(data !== undefined ? { data } : {}),
        ...(options.params ? { params: options.params } : {}),
        timeout,
        headers: {
          ...(this.apiKey ? { 'X-Api-Key': this.apiKey } : {}),
          ...(data !== undefined ? { 'Content-Type': 'application/json' } : {})
        }
      });
      return response.data;
    } catch (err) {
      throw sanitizeWahaError(err, endpoint, this.apiKey);
    }
  }

  async _withRetry(fn, maxRetries = 2) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt >= maxRetries || !isTransientWahaError(err)) {
          throw err;
        }
        const base = this.retryBaseDelayMs;
        const delayMs = base > 0
          ? base * (attempt + 1) + Math.floor(Math.random() * base)
          : 0;
        await sleep(delayMs);
      }
    }
    throw lastError;
  }

  sendSeen(chatId, options = {}) {
    // Compatible with all WAHA engines. Optional messageIds/participant support
    // targeted read receipts on engines such as GOWS/NOWEB.
    const body = {
      session: this.session,
      chatId
    };
    if (Array.isArray(options.messageIds) && options.messageIds.length > 0) {
      body.messageIds = options.messageIds;
    }
    if (options.participant) {
      body.participant = options.participant;
    }
    return this._withRetry(() => this.request('POST', '/api/sendSeen', body));
  }

  startTyping(chatId) {
    return this._withRetry(() => this.request('POST', '/api/startTyping', {
      session: this.session,
      chatId
    }));
  }

  stopTyping(chatId) {
    return this._withRetry(() => this.request('POST', '/api/stopTyping', {
      session: this.session,
      chatId
    }));
  }

  createTypingKeepalive(chatId, { intervalMs, logger } = {}) {
    const effectiveInterval = Number(intervalMs) > 0 ? Number(intervalMs) : this.typingKeepaliveMs;
    let timer = null;
    let started = false;
    let stopped = false;
    let inFlight = false;

    const tick = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        await this.startTyping(chatId);
      } catch (err) {
        logger?.warn?.({ chatId, error: err.message }, 'WAHA typing keepalive failed');
      } finally {
        inFlight = false;
      }
    };

    return {
      start: async () => {
        if (started || stopped) return;
        started = true;
        await tick();
        if (stopped) return;
        timer = setInterval(() => {
          void tick();
        }, effectiveInterval);
        timer.unref?.();
      },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        if (!started) return;
        try {
          await this.stopTyping(chatId);
        } catch (err) {
          logger?.warn?.({ chatId, error: err.message }, 'WAHA stopTyping failed');
        }
      }
    };
  }

  sendText(text, chatId, options = {}) {
    const body = { session: this.session, chatId, text };
    if (options.replyTo) body.reply_to = options.replyTo;
    if (options.mentions?.length) body.mentions = options.mentions;
    return this.request('POST', '/api/sendText', body);
  }

  sendVoice(buffer, chatId, {
    filename = 'bubu-voice.ogg',
    mimetype = 'audio/ogg; codecs=opus',
    convert = false,
    replyTo,
    mentions
  } = {}) {
    const body = {
      session: this.session,
      chatId,
      file: {
        filename,
        mimetype,
        data: Buffer.from(buffer).toString('base64')
      },
      convert
    };
    if (replyTo) body.reply_to = replyTo;
    if (mentions?.length) body.mentions = mentions;
    return this.request('POST', '/api/sendVoice', body, { timeoutMs: this.mediaTimeoutMs });
  }

  async sendImage(filePath, chatId, { filename, mimetype, caption = '', replyTo, mentions } = {}) {
    const data = (await fs.promises.readFile(filePath)).toString('base64');
    const body = buildMediaPayload({
      session: this.session,
      chatId,
      filename,
      mimetype,
      data,
      caption,
      replyTo,
      mentions
    });
    return this.request('POST', '/api/sendImage', body, { timeoutMs: this.mediaTimeoutMs });
  }

  async sendFile(filePath, chatId, { filename, mimetype, caption = '', replyTo, mentions } = {}) {
    const data = (await fs.promises.readFile(filePath)).toString('base64');
    const body = buildMediaPayload({
      session: this.session,
      chatId,
      filename,
      mimetype,
      data,
      caption,
      replyTo,
      mentions
    });
    return this.request('POST', '/api/sendFile', body, { timeoutMs: this.mediaTimeoutMs });
  }

  async sendVideo(filePath, chatId, { filename, mimetype = 'video/mp4', caption = '', replyTo, mentions } = {}) {
    const data = (await fs.promises.readFile(filePath)).toString('base64');
    const body = buildMediaPayload({
      session: this.session,
      chatId,
      filename,
      mimetype,
      data,
      caption,
      replyTo,
      mentions
    });
    return this.request('POST', '/api/sendVideo', body, { timeoutMs: this.mediaTimeoutMs });
  }

  sendReaction(_chatId, messageId, reaction) {
    return this.request('PUT', '/api/reaction', {
      session: this.session,
      messageId,
      reaction
    });
  }

  sendPoll(chatId, { name, options, multipleAnswers = false, replyTo } = {}) {
    const body = {
      session: this.session,
      chatId,
      poll: {
        name,
        options,
        multipleAnswers: Boolean(multipleAnswers)
      }
    };
    if (replyTo) body.reply_to = replyTo;
    return this.request('POST', '/api/sendPoll', body);
  }

  sendLocation(chatId, { latitude, longitude, title = '', replyTo } = {}) {
    const body = {
      session: this.session,
      chatId,
      latitude,
      longitude,
      title
    };
    if (replyTo) body.reply_to = replyTo;
    return this.request('POST', '/api/sendLocation', body);
  }

  sendContactVcard(chatId, contacts, { replyTo } = {}) {
    const body = {
      session: this.session,
      chatId,
      contacts: Array.isArray(contacts) ? contacts : [contacts]
    };
    if (replyTo) body.reply_to = replyTo;
    return this.request('POST', '/api/sendContactVcard', body);
  }

  checkNumberStatus(phone) {
    return this._withRetry(() =>
      this.request('GET', '/api/contacts/check-exists', undefined, {
        params: { session: this.session, phone }
      })
    );
  }

  getContactInfo(contactId) {
    return this._withRetry(() =>
      this.request('GET', '/api/contacts', undefined, {
        params: { session: this.session, contactId }
      })
    );
  }

  getGroupInfo(groupId) {
    return this._withRetry(() =>
      this.request('GET', `/api/${encodeURIComponent(this.session)}/groups/${encodeURIComponent(groupId)}`)
    );
  }

  getGroupParticipants(groupId) {
    return this._withRetry(() =>
      this.request('GET', `/api/${encodeURIComponent(this.session)}/groups/${encodeURIComponent(groupId)}/participants`)
    );
  }

  getChatMessages(chatId, { limit = 10, downloadMedia = false } = {}) {
    return this._withRetry(() =>
      this.request(
        'GET',
        `/api/${encodeURIComponent(this.session)}/chats/${encodeURIComponent(chatId)}/messages`,
        undefined,
        { params: { limit, downloadMedia } }
      )
    );
  }

  async resolveLid(lid) {
    const raw = String(lid || '').trim();
    if (!raw.toLowerCase().endsWith('@lid')) return lid;
    const key = normalizeJid(raw);
    const now = Date.now();
    const cached = this._lidCache.get(key);
    if (cached) {
      if (cached.expiresAt > now) {
        this._lidCache.delete(key);
        this._lidCache.set(key, cached);
        return cached.value;
      }
      this._lidCache.delete(key);
    }
    if (this._lidInFlight.has(key)) {
      return this._lidInFlight.get(key);
    }

    const promise = (async () => {
      try {
        const data = await this._withRetry(() =>
          this.request('GET', `/api/${encodeURIComponent(this.session)}/lids/${encodeURIComponent(key)}`)
        );
        const candidate = data?.pn || data?.phone || data?.phoneNumber ||
          data?.jid || data?.id?._serialized || data?.id || data?.result?.pn ||
          data?.result?.jid || data?.result?.id || key;
        const resolved = typeof candidate === 'string'
          ? candidate
          : candidate?._serialized || candidate?.user || key;

        if (this.lidCacheMaxEntries > 0) {
          while (this._lidCache.size >= this.lidCacheMaxEntries) {
            const oldestKey = this._lidCache.keys().next().value;
            if (oldestKey === undefined) break;
            this._lidCache.delete(oldestKey);
          }
          this._lidCache.set(key, {
            value: resolved,
            expiresAt: Date.now() + this.lidCacheTtlMs
          });
        }
        return resolved;
      } finally {
        this._lidInFlight.delete(key);
      }
    })();

    this._lidInFlight.set(key, promise);
    return promise;
  }

  async sessionStatus() {
    return this._withRetry(() =>
      this.request('GET', `/api/sessions/${encodeURIComponent(this.session)}`)
    );
  }
}

module.exports = {
  WahaClient,
  normalizeIncoming,
  extractQuoteContext,
  unwrapQuotedMessage,
  isTransientWahaError,
  sanitizeWahaError
};
