const dns = require('node:dns/promises');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { sanitizeAxiosError } = require('../utils/media-http');

const PRIVATE_IP_BLOCKLIST = (() => {
  const blocklist = new net.BlockList();
  const ipv4Subnets = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
  ];
  for (const [subnet, prefix] of ipv4Subnets) {
    blocklist.addSubnet(subnet, prefix, 'ipv4');
  }

  const ipv6Subnets = [
    ['::', 96],
    ['::ffff:0:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 32],
    ['2001:2::', 48],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8]
  ];
  for (const [subnet, prefix] of ipv6Subnets) {
    blocklist.addSubnet(subnet, prefix, 'ipv6');
  }
  return blocklist;
})();

class WebSearchService {
  constructor({ apiKey, maxResults = 5, timeoutMs = 20000, httpClient = null }) {
    this.apiKey = apiKey;
    this.maxResults = maxResults;
    this.timeoutMs = timeoutMs;
    this.httpClient = httpClient;
  }

  async search({ query, maxResults, timeRange }) {
    if (!this.apiKey) throw new Error('Web search belum dikonfigurasi. Tambahkan TAVILY_API_KEY pada .env.');
    const axios = this.httpClient || require('axios');
    let response;
    try {
      response = await axios.post('https://api.tavily.com/search', {
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
    } catch (error) {
      throw sanitizeAxiosError(error);
    }
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
  const withoutBrackets = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const host = withoutBrackets.split('%')[0].replace(/\.+$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }

  const family = net.isIP(host);
  if (family === 4) return PRIVATE_IP_BLOCKLIST.check(host, 'ipv4');
  if (family === 6) return PRIVATE_IP_BLOCKLIST.check(host, 'ipv6');

  if (/^(?:\d+|0x[0-9a-f]+)(?:\.(?:\d+|0x[0-9a-f]+))*$/i.test(host)) {
    try {
      const normalized = new URL(`http://${host}`).hostname;
      if (net.isIP(normalized) === 4) {
        return PRIVATE_IP_BLOCKLIST.check(normalized, 'ipv4');
      }
    } catch {
      return true;
    }
  }
  return false;
}

function safeFromCodePoint(codePoint, fallback) {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : fallback;
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
    .replace(/&#x([0-9a-fA-F]+);/gi, (match, hex) => safeFromCodePoint(Number.parseInt(hex, 16), match))
    .replace(/&#(\d+);/g, (match, n) => safeFromCodePoint(Number.parseInt(n, 10), match))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
    .slice(0, 18000);
}

class WebFetchService {
  constructor({ httpClient = null, dnsLookup = null, timeoutMs = 15000 } = {}) {
    this.httpClient = httpClient;
    this.dnsLookup = dnsLookup;
    this.timeoutMs = timeoutMs;
  }

  async fetch({ url }) {
    let current = new URL(url);
    for (let hop = 0; hop <= 3; hop++) {
      if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password || isPrivateHost(current.hostname)) {
        throw new Error('URL tidak diizinkan untuk diakses.');
      }
      let pinnedAgents;
      try {
        const lookupFn = this.dnsLookup || dns.lookup;
        const resolved = await lookupFn(current.hostname, { all: true, verbatim: true });
        if (!resolved.length || resolved.some((entry) => isPrivateHost(entry.address))) {
          throw new Error('Host mengarah ke jaringan privat.');
        }
        const selected = resolved[0];
        const pinnedLookup = (_hostname, options, callback) => {
          if (typeof options === 'function') {
            callback = options;
            options = {};
          }
          const requestedFamily = options && (options.family === 4 || options.family === 6) ? options.family : 0;
          const matching = requestedFamily
            ? resolved.filter((entry) => (entry.family || net.isIP(entry.address) || 4) === requestedFamily)
            : resolved;
          if (options && options.all) {
            callback(null, matching.map((entry) => ({
              address: entry.address,
              family: entry.family || net.isIP(entry.address) || 4
            })));
            return;
          }
          const pick = matching[0] || selected;
          callback(null, pick.address, pick.family || net.isIP(pick.address) || 4);
        };
        pinnedAgents = {
          httpAgent: new http.Agent({ lookup: pinnedLookup }),
          httpsAgent: new https.Agent({ lookup: pinnedLookup })
        };
      } catch (error) {
        throw new Error(`Host tidak dapat diverifikasi: ${error.message}`);
      }
      const axios = this.httpClient || require('axios');
      const signal = AbortSignal.timeout(this.timeoutMs);
      let response;
      try {
        response = await axios.get(current.toString(), {
          timeout: this.timeoutMs,
          signal,
          maxRedirects: 0,
          proxy: false,
          ...pinnedAgents,
          maxContentLength: 3 * 1024 * 1024,
          responseType: 'text',
          headers: { 'User-Agent': 'BubuResearchBot/2.1 (+documented agent fetch)' },
          validateStatus: (status) => status >= 200 && status < 300
        });
      } catch (error) {
        if (error.response?.status >= 300 && error.response?.status < 400 && error.response.headers?.location && hop < 3) {
          current = new URL(error.response.headers.location, current);
          continue;
        }
        const clean = sanitizeAxiosError(error);
        const timedOut = signal.aborted && clean.code === 'ERR_CANCELED';
        const wrapped = new Error(`Gagal membaca halaman: ${timedOut ? 'Request timed out' : (clean.response?.status || clean.message)}`);
        if (clean.status) {
          wrapped.status = clean.status;
          wrapped.response = { status: clean.status };
        }
        if (timedOut) wrapped.code = 'ETIMEDOUT';
        else if (clean.code) wrapped.code = clean.code;
        throw wrapped;
      } finally {
        pinnedAgents.httpAgent.destroy();
        pinnedAgents.httpsAgent.destroy();
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
        content: contentType.includes('text/html') ? extractReadableText(raw) : raw.slice(0, 18000),
        contentType
      };
    }
    throw new Error('Terlalu banyak redirect.');
  }
}

module.exports = { WebSearchService, WebFetchService, extractReadableText, isPrivateHost };
