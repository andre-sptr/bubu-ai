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

  async fetch({ url, allowJson = false }) {
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
      const isJsonType = contentType.includes('application/json') || contentType.includes('+json') || contentType.includes('text/javascript');
      if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !(allowJson && isJsonType)) {
        throw new Error(`Tipe konten tidak didukung: ${contentType || 'unknown'}`);
      }
      const raw = Buffer.isBuffer(response.data)
        ? response.data.toString('utf8')
        : (typeof response.data === 'object' && response.data !== null
          ? JSON.stringify(response.data)
          : String(response.data || ''));
      const rawTitle = decodeHtmlEntities(
        (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, '').trim()
      );
      const isHtml = !isJsonType && (contentType.includes('text/html') || /<(?:html|head|meta|title)\b/i.test(raw.slice(0, 2000)));
      if (!isHtml) {
        return {
          url: current.toString(),
          title: rawTitle,
          content: raw.slice(0, 18000),
          contentType
        };
      }

      const readableText = extractReadableText(raw);
      const metadata = extractHtmlMetadata(raw);
      const oembedUrl = resolveOEmbedUrl(current);
      let oembed = null;
      if (oembedUrl) {
        try {
          oembed = await fetchJsonWithSsrfGuard(oembedUrl, {
            fetchText: (target) => this.fetch({ url: target, allowJson: true })
          });
        } catch {
          oembed = null;
        }
      }

      const title = [
        oembed?.title,
        metadata?.og?.title,
        metadata?.twitter?.title,
        metadata?.title,
        rawTitle
      ].map((v) => String(v || '').trim()).find(Boolean) || '';

      const enrichedHeader = formatPageMetadataBlock({ metadata, oembed });
      const content = enrichedHeader
        ? `${enrichedHeader}\n\n${readableText}`.trim().slice(0, 18000)
        : readableText;

      return {
        url: current.toString(),
        title,
        content,
        contentType,
        ...(enrichedHeader ? { metadata } : {}),
        ...(oembed ? { oembed } : {})
      };
    }
    throw new Error('Terlalu banyak redirect.');
  }
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTagAttributes(tagText) {
  const attrs = {};
  const attrRegex = /([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;
  while ((match = attrRegex.exec(tagText)) !== null) {
    const key = String(match[1] || '').toLowerCase();
    const rawVal = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = decodeHtmlEntities(rawVal);
  }
  return attrs;
}

function pickJsonLdSummary(rawNode) {
  if (!rawNode || typeof rawNode !== 'object') return null;
  if (Array.isArray(rawNode)) {
    for (const item of rawNode) {
      const picked = pickJsonLdSummary(item);
      if (picked) return picked;
    }
    return null;
  }
  if (Array.isArray(rawNode['@graph'])) {
    const picked = pickJsonLdSummary(rawNode['@graph']);
    if (picked) return picked;
  }
  const type = String(rawNode['@type'] || '').trim();
  const headline = String(rawNode.headline || rawNode.name || rawNode.title || '').trim();
  const description = String(rawNode.description || rawNode.caption || rawNode.articleBody || '').trim().slice(0, 600);
  const authorRaw = rawNode.author || rawNode.creator;
  const author = typeof authorRaw === 'string'
    ? authorRaw.trim()
    : Array.isArray(authorRaw)
      ? String(authorRaw[0]?.name || authorRaw[0] || '').trim()
      : String(authorRaw?.name || authorRaw?.alternateName || '').trim();
  const published = String(rawNode.uploadDate || rawNode.datePublished || '').trim();
  if (!headline && !description && !author) return null;
  return {
    ...(type ? { type } : {}),
    ...(headline ? { headline } : {}),
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
    ...(published ? { published } : {})
  };
}

function extractHtmlMetadata(html = '') {
  const source = String(html || '');
  const title = decodeHtmlEntities(
    (source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, '').trim()
  );
  const og = {};
  const twitter = {};
  let description = '';
  let author = '';
  let canonicalUrl = '';

  const metaRegex = /<meta\b[^>]*>/gi;
  let metaMatch;
  while ((metaMatch = metaRegex.exec(source)) !== null) {
    const attrs = parseTagAttributes(metaMatch[0]);
    const key = String(attrs.property || attrs.name || '').toLowerCase().trim();
    const content = String(attrs.content || '').trim();
    if (!key || !content) continue;
    if (key.startsWith('og:')) {
      og[key.slice(3)] = content;
    } else if (key.startsWith('twitter:')) {
      twitter[key.slice(8)] = content;
    } else if (key === 'description' && !description) {
      description = content;
    } else if ((key === 'author' || key === 'article:author') && !author) {
      author = content;
    }
  }

  const linkRegex = /<link\b[^>]*>/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(source)) !== null) {
    const attrs = parseTagAttributes(linkMatch[0]);
    const rel = String(attrs.rel || '').toLowerCase().split(/\s+/);
    if (rel.includes('canonical') && attrs.href && !canonicalUrl) {
      canonicalUrl = attrs.href;
    }
  }

  let jsonLd = null;
  const ldRegex = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch;
  while ((ldMatch = ldRegex.exec(source)) !== null) {
    try {
      const parsed = JSON.parse(String(ldMatch[1] || '').trim());
      const summary = pickJsonLdSummary(parsed);
      if (summary) {
        jsonLd = summary;
        break;
      }
    } catch {
      // Ignore malformed JSON-LD blocks on public pages.
    }
  }

  return {
    title,
    description: og.description || twitter.description || description,
    siteName: og.site_name || twitter.site || '',
    author: author || twitter.creator || jsonLd?.author || '',
    canonicalUrl: canonicalUrl || og.url || '',
    og,
    twitter,
    ...(jsonLd ? { jsonLd } : {})
  };
}

function resolveOEmbedUrl(inputUrl) {
  let parsed;
  try {
    parsed = inputUrl instanceof URL ? inputUrl : new URL(String(inputUrl || ''));
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  const host = parsed.hostname.toLowerCase();
  const pathLower = parsed.pathname.toLowerCase();
  if (pathLower.startsWith('/oembed') || pathLower.startsWith('/api/oembed')) {
    return null;
  }
  const cleanTarget = new URL(parsed.toString());
  cleanTarget.hash = '';
  const encoded = encodeURIComponent(cleanTarget.toString());

  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    if (!parsed.pathname || parsed.pathname === '/') return null;
    return `https://www.tiktok.com/oembed?url=${encoded}`;
  }
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
    if (!parsed.pathname || (parsed.pathname === '/' && !parsed.search)) return null;
    return `https://www.youtube.com/oembed?url=${encoded}&format=json`;
  }
  if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
    if (!parsed.pathname || parsed.pathname === '/') return null;
    return `https://vimeo.com/api/oembed.json?url=${encoded}`;
  }
  return null;
}

async function fetchJsonWithSsrfGuard(rawUrl, { fetchText = null, httpClient = null, dnsLookup = null } = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    throw new Error('URL oEmbed tidak valid.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('URL oEmbed wajib HTTP/HTTPS.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL oEmbed tidak boleh memuat kredensial.');
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error('Akses jaringan privat pada oEmbed ditolak.');
  }

  const runFetch = fetchText || (async (target) => {
    const fetcher = new WebFetchService({ httpClient, dnsLookup });
    return fetcher.fetch({ url: target, allowJson: true });
  });
  const res = await runFetch(parsed.toString());
  const rawContent = String(res?.content || '').trim();
  if (!rawContent) return null;
  const data = JSON.parse(rawContent);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data;
}

function formatPageMetadataBlock({ metadata = null, oembed = null } = {}) {
  const lines = [];
  const hasRichMeta = Boolean(
    metadata?.og?.title || metadata?.og?.description || metadata?.og?.site_name ||
    metadata?.twitter?.title || metadata?.twitter?.description || metadata?.twitter?.creator ||
    metadata?.description || metadata?.author || metadata?.canonicalUrl || metadata?.jsonLd ||
    oembed
  );
  if (!hasRichMeta) return '';

  const site = oembed?.provider_name || metadata?.siteName || '';
  const title = oembed?.title || metadata?.og?.title || metadata?.twitter?.title || metadata?.jsonLd?.headline || metadata?.title || '';
  const author = oembed?.author_name || metadata?.author || '';
  const description = metadata?.og?.description || metadata?.twitter?.description || metadata?.description || metadata?.jsonLd?.description || '';
  const canonicalUrl = metadata?.canonicalUrl || '';
  const published = metadata?.jsonLd?.published || '';

  if (site) lines.push(`Platform/Site: ${site}`);
  if (title) lines.push(`Title: ${title}`);
  if (author) lines.push(`Author/Creator: ${author}`);
  if (published) lines.push(`Published: ${published}`);
  if (canonicalUrl) lines.push(`Canonical URL: ${canonicalUrl}`);
  if (description) lines.push(`Description/Caption: ${description}`);
  if (!lines.length) return '';
  return `[PAGE_METADATA]\n${lines.join('\n')}\n[/PAGE_METADATA]`;
}

module.exports = {
  WebSearchService,
  WebFetchService,
  extractReadableText,
  extractHtmlMetadata,
  resolveOEmbedUrl,
  fetchJsonWithSsrfGuard,
  isPrivateHost
};
