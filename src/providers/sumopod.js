const http = require('node:http');
const https = require('node:https');
const axios = require('axios');
const { sanitizeAxiosError } = require('../utils/media-http');
const { STATIC_DYNAMIC_BOUNDARY } = require('../agent/prompt-builder');

const ALLOWED_VISION_DATA_URL = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i;
const DEFAULT_MAX_VISION_BYTES = 10 * 1024 * 1024;

function validateImageDataUrl(url, maxBytes = DEFAULT_MAX_VISION_BYTES) {
  const raw = String(url || '').trim();
  if (!raw) throw new Error('Visual image_url payload is empty');
  if (/^https?:/i.test(raw) || raw.startsWith('/') || raw.includes('@')) {
    throw new Error('Private or remote URLs are forbidden in Sumopod visual payloads; use sanitized data:image base64 only');
  }
  const match = raw.match(ALLOWED_VISION_DATA_URL);
  if (!match) {
    throw new Error('Unsupported visual payload format; only data:image/(jpeg|png|webp);base64 is permitted');
  }
  const b64 = match[2].replace(/[\r\n]+/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 === 1) {
    throw new Error('Unsupported visual payload format; only data:image/(jpeg|png|webp);base64 is permitted');
  }
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const decodedLength = Math.floor((b64.length * 3) / 4) - padding;
  if (!decodedLength || decodedLength <= 0 || decodedLength > maxBytes) {
    throw new Error(`Visual payload size (${decodedLength} bytes) is empty or exceeds limit (${maxBytes} bytes)`);
  }
  return `data:image/${match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase()};base64,${b64}`;
}

function sanitizeMessagesForProvider(messages, { maxImageBytes = DEFAULT_MAX_VISION_BYTES } = {}) {
  if (!Array.isArray(messages)) throw new Error('Messages must be an array');
  return messages.map((msg) => {
    if (!msg || !Array.isArray(msg.content)) return msg;
    const sanitizedContent = msg.content.map((part) => {
      if (!part || typeof part !== 'object') throw new Error('Invalid multimodal message content part');
      if (part.type === 'text') {
        return { type: 'text', text: String(part.text || '') };
      }
      if (part.type === 'image_url') {
        const rawUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        const safeUrl = validateImageDataUrl(rawUrl, maxImageBytes);
        return { type: 'image_url', image_url: { url: safeUrl } };
      }
      throw new Error(`Unsupported multimodal content part type: ${String(part.type)}`);
    });
    return { ...msg, content: sanitizedContent };
  });
}

class SumopodProvider {
  constructor({
    baseUrl,
    apiKey,
    timeoutMs = 60000,
    maxImageBytes = DEFAULT_MAX_VISION_BYTES,
    promptCaching = false,
    httpClient = null
  }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.maxImageBytes = maxImageBytes;
    this.promptCaching = Boolean(promptCaching);
    this.httpClient = httpClient;
    if (!httpClient) {
      this.httpAgent = new http.Agent({ keepAlive: true });
      this.httpsAgent = new https.Agent({ keepAlive: true });
      this._axios = axios.create({
        httpAgent: this.httpAgent,
        httpsAgent: this.httpsAgent
      });
    } else {
      this.httpAgent = null;
      this.httpsAgent = null;
      this._axios = null;
    }
  }

  close() {
    this.httpAgent?.destroy?.();
    this.httpsAgent?.destroy?.();
  }

  client() {
    return this.httpClient || this._axios;
  }

  headers() {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  async listModels() {
    let response;
    try {
      response = await this.client().get(`${this.baseUrl}/models`, {
        headers: this.headers(), timeout: this.timeoutMs
      });
    } catch (error) {
      throw sanitizeAxiosError(error);
    }
    return response.data?.data || [];
  }


  async embed({ input, model = 'gemini/gemini-embedding-001', timeoutMs = 12000, signal = null }) {
    let response;
    try {
      response = await this.client().post(`${this.baseUrl}/embeddings`, {
        model,
        input: Array.isArray(input) ? input : [input]
      }, {
        headers: this.headers(),
        timeout: timeoutMs,
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      throw sanitizeAxiosError(error);
    }
    const vector = response.data?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || !vector.length) {
      throw new Error('Sumopod embeddings endpoint returned no vector');
    }
    return vector.map(Number);
  }

  async chat({ model, messages, tools, temperature, maxTokens = 1800, signal = null }) {
    if (!model) throw new Error('No model configured for selected task tier');
    const safeMessages = sanitizeMessagesForProvider(messages, { maxImageBytes: this.maxImageBytes })
      .map((msg) => {
        if (msg?.role !== 'system' || typeof msg.content !== 'string' || !msg.content.includes(STATIC_DYNAMIC_BOUNDARY)) {
          return msg;
        }
        const [staticPart, ...rest] = msg.content.split(STATIC_DYNAMIC_BOUNDARY);
        const dynamicPart = rest.join('\n');
        if (this.promptCaching && /^claude/i.test(model)) {
          return {
            ...msg,
            content: [
              { type: 'text', text: staticPart, cache_control: { type: 'ephemeral' } },
              ...(dynamicPart ? [{ type: 'text', text: dynamicPart }] : [])
            ]
          };
        }
        return {
          ...msg,
          content: dynamicPart ? `${staticPart}\n${dynamicPart}` : staticPart
        };
      });
    const body = { model, messages: safeMessages, max_tokens: maxTokens };
    // Do not force temperature by default: newer Claude models use adaptive
    // thinking and may reject temperature/top_p parameters at the provider layer.
    if (Number.isFinite(temperature)) body.temperature = temperature;
    if (tools?.length) body.tools = tools;
    let response;
    try {
      response = await this.client().post(`${this.baseUrl}/chat/completions`, body, {
        headers: this.headers(),
        timeout: this.timeoutMs,
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      throw sanitizeAxiosError(error);
    }
    const choice = response.data?.choices?.[0];
    if (!choice?.message) throw new Error('Sumopod returned no assistant message');
    return {
      message: choice.message,
      usage: response.data.usage || null,
      model: response.data.model || model,
      finishReason: choice.finish_reason || null
    };
  }
}

module.exports = { SumopodProvider, validateImageDataUrl, sanitizeMessagesForProvider };
