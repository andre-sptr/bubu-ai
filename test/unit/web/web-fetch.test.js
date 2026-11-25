const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const pino = require('pino');
const {
  WebSearchService,
  WebFetchService,
  isPrivateHost,
  extractReadableText
} = require('../../../src/web/web-service');

test('web fetch blocks loopback, private, NAT64, IPv6-mapped hex, link-local, multicast, and reserved hosts', () => {
  const blocked = [
    '127.0.0.1',
    '10.1.2.3',
    '192.168.1.1',
    '172.16.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '0.0.0.0',
    'localhost',
    'api.localhost',
    'printer.local',
    'metadata.internal',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::7f00:1',
    '::ffff:0:7f00:1',
    '64:ff9b::7f00:1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'fe81::1',
    'febf::1',
    '[fe80::1%eth0]',
    'fe80::1%12',
    'ff02::1',
    '2001:db8::1',
    '0x7f000001',
    '2130706433'
  ];
  for (const host of blocked) {
    assert.equal(isPrivateHost(host), true, `Expected ${host} to be blocked`);
  }

  const allowed = [
    'example.com',
    '93.184.216.34',
    '2606:2800:220:1:248:1893:25c8:1946',
    '2001:4860:4860::8888',
    '::ffff:93.184.216.34'
  ];
  for (const host of allowed) {
    assert.equal(isPrivateHost(host), false, `Expected ${host} to be allowed`);
  }
});

test('HTML extraction removes script/style, decodes valid entities, and ignores out-of-range code points', () => {
  const text = extractReadableText('<html><title>Report</title><script>secret()</script><p>Hello &#65; &#x1F600; &#9999999; &#x9999999; world</p></html>');
  assert.match(text, /Hello A/);
  assert.match(text, /&#9999999;/);
  assert.doesNotMatch(text, /secret/);
});

test('WebFetchService supports Node >=22 lookup({all:true}), passes AbortSignal, and destroys per-hop agents in finally', async () => {
  let allLookupResult = null;
  let singleLookupResult = null;
  let passedSignal = null;
  let httpAgentDestroyed = false;
  let httpsAgentDestroyed = false;

  const service = new WebFetchService({
    dnsLookup: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
    ],
    httpClient: {
      get: async (_url, opts) => {
        passedSignal = opts.signal;
        const origHttpDestroy = opts.httpAgent.destroy.bind(opts.httpAgent);
        const origHttpsDestroy = opts.httpsAgent.destroy.bind(opts.httpsAgent);
        opts.httpAgent.destroy = () => { httpAgentDestroyed = true; return origHttpDestroy(); };
        opts.httpsAgent.destroy = () => { httpsAgentDestroyed = true; return origHttpsDestroy(); };

        await new Promise((resolve, reject) => {
          opts.httpAgent.options.lookup('example.com', { all: true }, (err, list) => {
            if (err) return reject(err);
            allLookupResult = list;
            resolve();
          });
        });
        await new Promise((resolve, reject) => {
          opts.httpAgent.options.lookup('example.com', (err, addr, family) => {
            if (err) return reject(err);
            singleLookupResult = { addr, family };
            resolve();
          });
        });

        return {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          data: '<title>Test Page</title><p>Content OK</p>'
        };
      }
    }
  });

  const res = await service.fetch({ url: 'https://example.com/article' });
  assert.equal(res.title, 'Test Page');
  assert.match(res.content, /Content OK/);
  assert.deepEqual(allLookupResult, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
  ]);
  assert.deepEqual(singleLookupResult, { addr: '93.184.216.34', family: 4 });
  assert.ok(passedSignal instanceof AbortSignal);
  assert.equal(httpAgentDestroyed, true);
  assert.equal(httpsAgentDestroyed, true);
});

test('WebFetchService destroys agents and strips Axios secrets on error', async () => {
  let agentDestroyed = false;
  const service = new WebFetchService({
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    httpClient: {
      get: async (_url, opts) => {
        const origDestroy = opts.httpsAgent.destroy.bind(opts.httpsAgent);
        opts.httpsAgent.destroy = () => { agentDestroyed = true; return origDestroy(); };
        throw new axios.AxiosError(
          'Request failed with status code 502',
          'ERR_BAD_RESPONSE',
          { headers: { Authorization: 'Bearer should-not-leak' } },
          { socket: true },
          { status: 502, config: { headers: { Authorization: 'Bearer should-not-leak' } } }
        );
      }
    }
  });

  await assert.rejects(
    () => service.fetch({ url: 'https://example.com/fail' }),
    (err) => {
      assert.match(err.message, /Gagal membaca halaman: 502/);
      assert.equal(err.status, 502);
      assert.equal(err.config, undefined);
      assert.equal(err.request, undefined);
      assert.equal(JSON.stringify(pino.stdSerializers.err(err)).includes('should-not-leak'), false);
      return true;
    }
  );
  assert.equal(agentDestroyed, true);
});

test('WebSearchService strips AxiosError credentials while preserving status and code', async () => {
  const searchService = new WebSearchService({
    apiKey: 'secret-tavily-token',
    httpClient: {
      post: async () => {
        throw new axios.AxiosError(
          'Request failed with status code 401',
          'ERR_BAD_REQUEST',
          { headers: { Authorization: 'Bearer secret-tavily-token' } },
          { socket: true },
          { status: 401, config: { headers: { Authorization: 'Bearer secret-tavily-token' } } }
        );
      }
    }
  });

  await assert.rejects(
    () => searchService.search({ query: 'bubu test' }),
    (err) => {
      assert.equal(err.status, 401);
      assert.equal(err.response?.status, 401);
      assert.equal(err.code, 'ERR_BAD_REQUEST');
      assert.equal(err.config, undefined);
      assert.equal(err.request, undefined);
      assert.equal(JSON.stringify(pino.stdSerializers.err(err)).includes('secret-tavily-token'), false);
      return true;
    }
  );
});

test('WebFetchService blocks private DNS resolution and redirects to private hosts while destroying agents', async () => {
  const dnsRebindService = new WebFetchService({
    dnsLookup: async () => [{ address: '::ffff:7f00:1', family: 6 }],
    httpClient: { get: async () => assert.fail('must not issue HTTP request') }
  });
  await assert.rejects(
    () => dnsRebindService.fetch({ url: 'https://rebind.example/secret' }),
    /jaringan privat/
  );

  let hop1Destroyed = false;
  const redirectPrivateService = new WebFetchService({
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    httpClient: {
      get: async (_url, opts) => {
        const origDestroy = opts.httpsAgent.destroy.bind(opts.httpsAgent);
        opts.httpsAgent.destroy = () => { hop1Destroyed = true; return origDestroy(); };
        const err = new Error('Redirect');
        err.response = { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } };
        throw err;
      }
    }
  });
  await assert.rejects(
    () => redirectPrivateService.fetch({ url: 'https://example.com/start' }),
    /URL tidak diizinkan/
  );
  assert.equal(hop1Destroyed, true);
});

test('Tier 1 social & HTML metadata extraction preserves single fetch on normal sites and enriches IG/TikTok previews safely', async () => {
  const {
    extractHtmlMetadata,
    resolveOEmbedUrl,
    fetchJsonWithSsrfGuard
  } = require('../../../src/web/web-service');

  // 1. Plain non-oEmbed website makes strictly 1 HTTP call
  let exampleCalls = 0;
  const plainFetcher = new WebFetchService({
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    httpClient: {
      get: async () => {
        exampleCalls++;
        return {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          data: '<html><head><title>Plain Docs</title></head><body><p>Isi dokumentasi normal.</p></body></html>'
        };
      }
    }
  });
  const plainRes = await plainFetcher.fetch({ url: 'https://example.com/docs' });
  assert.equal(exampleCalls, 1);
  assert.equal(plainRes.title, 'Plain Docs');
  assert.match(plainRes.content, /Isi dokumentasi normal/);
  assert.equal(plainRes.content.includes('[PAGE_METADATA]'), false);

  // 2. Instagram HTML shell extracts OpenGraph + Twitter + JSON-LD caption & creator cleanly
  const igHtml = `
    <html><head>
      <title>Instagram</title>
      <meta content="instagram.com" property="og:site_name">
      <meta property="og:title" content="Andre (@andresptr) on Instagram">
      <meta content="Liputan teknis antena array terbaru #rf" property="og:description">
      <meta name="twitter:creator" content="@andresptr">
      <link rel="canonical" href="https://www.instagram.com/reel/abc123/">
      <script type="application/ld+json">{"@type":"VideoObject","author":{"name":"Andre Saputra"},"uploadDate":"2026-11-20"}</script>
    </head><body>Log in to Instagram</body></html>
  `;
  const meta = extractHtmlMetadata(igHtml);
  assert.equal(meta.siteName, 'instagram.com');
  assert.equal(meta.og.description, 'Liputan teknis antena array terbaru #rf');
  assert.equal(meta.canonicalUrl, 'https://www.instagram.com/reel/abc123/');
  assert.equal(meta.author, '@andresptr');
  assert.equal(meta.jsonLd.published, '2026-11-20');

  // 3. oEmbed allowlist & TikTok pre-parsed JSON response handling
  assert.equal(resolveOEmbedUrl('https://example.com/video'), null);
  assert.match(resolveOEmbedUrl('https://www.tiktok.com/@user/video/777'), /^https:\/\/www\.tiktok\.com\/oembed\?url=/);
  assert.match(resolveOEmbedUrl('https://youtu.be/dQw4w9WgXcQ'), /^https:\/\/www\.youtube\.com\/oembed\?url=/);

  const fetchedUrls = [];
  const tiktokFetcher = new WebFetchService({
    dnsLookup: async () => [{ address: '104.16.1.1', family: 4 }],
    httpClient: {
      get: async (url) => {
        fetchedUrls.push(url);
        if (url.includes('/oembed')) {
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            data: {
              title: 'Tutorial Antena',
              author_name: 'Teknisi RF',
              provider_name: 'TikTok',
              html: '<blockquote class="tiktok-embed"><title>embed</title></blockquote>'
            }
          };
        }
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          data: '<html><head><meta property="og:site_name" content="TikTok"></head><body></body></html>'
        };
      }
    }
  });
  const ttRes = await tiktokFetcher.fetch({ url: 'https://www.tiktok.com/@user/video/777' });
  assert.equal(fetchedUrls.length, 2);
  assert.equal(ttRes.title, 'Tutorial Antena');
  assert.match(ttRes.content, /\[PAGE_METADATA\]/);
  assert.match(ttRes.content, /Author\/Creator: Teknisi RF/);

  // 4. SSRF block in fetchJsonWithSsrfGuard
  await assert.rejects(
    () => fetchJsonWithSsrfGuard('http://127.0.0.1:3000/oembed'),
    /jaringan privat/
  );
});
