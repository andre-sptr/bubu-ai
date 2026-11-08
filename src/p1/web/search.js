const dns = require('node:dns/promises');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

class WebSearchService {
  constructor({ apiKey, maxResults = 5, timeoutMs = 20000 }) {
    this.apiKey = apiKey;
    this.maxResults = maxResults;
    this.timeoutMs = timeoutMs;
  }

  async search({ query, maxResults, timeRange }) {
    if (!this.apiKey) throw new Error('Web search belum dikonfigurasi. Tambahkan TAVILY_API_KEY pada .env.');
    const axios = require('axios');
    const response = await axios.post('https://api.tavily.com/search', {
      query,
      max_results: Math.max(1, Math.min(Number(maxResults || this.maxResults), 10)),
      search_depth: 'advanced',
      topic: 'general',
      time_range: timeRange || undefined,
      include_answer: false,
      include_raw_content: false
    }, {
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      timeout: this.timeoutMs
    });
    return (response.data?.results || []).map((item) => ({
      title: item.title || '',
      url: item.url || '',
      content: String(item.content || '').slice(0, 3500),
      score: item.score ?? null,
      publishedDate: item.published_date || null
    }));
  }
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice(7);
    if (net.isIP(mapped) === 4) return isPrivateHost(mapped);
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
  const parts = host.split('.').map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a,b] = parts;
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  return false;
}

function extractReadableText(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(header|footer|nav|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|article|section|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
    .slice(0, 18000);
}

class WebFetchService {
  async fetch({ url }) {
    let current = new URL(url);
    for (let hop = 0; hop <= 3; hop++) {
      if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password || isPrivateHost(current.hostname)) {
        throw new Error('URL tidak diizinkan untuk diakses.');
      }
      try {
        const resolved = await dns.lookup(current.hostname, { all: true, verbatim: true });
        if (!resolved.length || resolved.some((entry) => isPrivateHost(entry.address))) {
          throw new Error('Host mengarah ke jaringan privat.');
        }
        const selected = resolved[0];
        const pinnedLookup = (_hostname, options, callback) => {
          if (typeof options === 'function') callback = options;
          callback(null, selected.address, selected.family);
        };
        var pinnedAgents = {
          httpAgent: new http.Agent({ lookup: pinnedLookup }),
          httpsAgent: new https.Agent({ lookup: pinnedLookup })
        };
      } catch (error) {
        throw new Error(`Host tidak dapat diverifikasi: ${error.message}`);
      }
      const axios = require('axios');
      let response;
      try {
        response = await axios.get(current.toString(), {
          timeout: 15000,
          maxRedirects: 0,
          proxy: false,
          ...pinnedAgents,
          maxContentLength: 3 * 1024 * 1024,
          responseType: 'text',
          headers: { 'User-Agent': 'BubuResearchBot/2.1 (+documented agent fetch)' },
          validateStatus: (status) => status >= 200 && status < 300
        });
      } catch (error) {
        if (error.response?.status >= 300 && error.response?.status < 400 && error.response.headers.location && hop < 3) {
          current = new URL(error.response.headers.location, current);
          continue;
        }
        throw new Error(`Gagal membaca halaman: ${error.response?.status || error.message}`);
      }
      const contentType = String(response.headers['content-type'] || '');
      if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
        throw new Error(`Tipe konten tidak didukung: ${contentType || 'unknown'}`);
      }
      const raw = String(response.data || '');
      const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, '').trim();
      return {
        url: current.toString(),
        title,
        content: contentType.includes('text/html') ? extractReadableText(raw) : raw.slice(0,18000),
        contentType
      };
    }
    throw new Error('Terlalu banyak redirect.');
  }
}

module.exports = { WebSearchService, WebFetchService, extractReadableText, isPrivateHost };
