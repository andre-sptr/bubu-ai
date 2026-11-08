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
  const decoded = Buffer.from(match[2], 'base64');
  if (!decoded.length || decoded.length > maxBytes) {
    throw new Error(`Visual payload size (${decoded.length} bytes) is empty or exceeds limit (${maxBytes} bytes)`);
  }
  return `data:image/${match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase()};base64,${decoded.toString('base64')}`;
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
  constructor({ baseUrl, apiKey, timeoutMs = 60000, maxImageBytes = DEFAULT_MAX_VISION_BYTES, httpClient = null }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.maxImageBytes = maxImageBytes;
    this.httpClient = httpClient;
  }

  client() {
    return this.httpClient || require('axios');
  }

  headers() {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  async listModels() {
    const response = await this.client().get(`${this.baseUrl}/models`, {
      headers: this.headers(), timeout: this.timeoutMs
    });
    return response.data?.data || [];
  }


  async embed({ input, model = 'gemini/gemini-embedding-001', timeoutMs = 12000 }) {
    const response = await this.client().post(`${this.baseUrl}/embeddings`, {
      model,
      input: Array.isArray(input) ? input : [input]
    }, {
      headers: this.headers(),
      timeout: timeoutMs
    });
    const vector = response.data?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || !vector.length) {
      throw new Error('Sumopod embeddings endpoint returned no vector');
    }
    return vector.map(Number);
  }

  async chat({ model, messages, tools, temperature, maxTokens = 1800 }) {
    if (!model) throw new Error('No model configured for selected task tier');
    const safeMessages = sanitizeMessagesForProvider(messages, { maxImageBytes: this.maxImageBytes });
    const body = { model, messages: safeMessages, max_tokens: maxTokens };
    // Do not force temperature by default: newer Claude models use adaptive
    // thinking and may reject temperature/top_p parameters at the provider layer.
    if (Number.isFinite(temperature)) body.temperature = temperature;
    if (tools?.length) body.tools = tools;
    const response = await this.client().post(`${this.baseUrl}/chat/completions`, body, {
      headers: this.headers(), timeout: this.timeoutMs
    });
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
