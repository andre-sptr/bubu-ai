const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WahaClient } = require('../../../src/channels/waha/client');

test('WahaClient configures reusable axios instance with keepAlive agents and zero redirects', () => {
  const client = new WahaClient({
    baseUrl: 'http://127.0.0.1:3000/',
    session: 'default',
    apiKey: 'secret-key',
    timeoutMs: 12000,
    mediaTimeoutMs: 45000,
    typingKeepaliveMs: 9000
  });
  try {
    assert.equal(client.http.defaults.baseURL, 'http://127.0.0.1:3000');
    assert.equal(client.http.defaults.timeout, 12000);
    assert.equal(client.http.defaults.maxRedirects, 0);
    assert.equal(client.httpAgent.keepAlive, true);
    assert.equal(client.httpsAgent.keepAlive, true);
    assert.equal(client.mediaTimeoutMs, 45000);
    assert.equal(client.typingKeepaliveMs, 9000);
  } finally {
    client.close();
  }
});

test('WahaClient sanitizes axios errors so API keys, headers, config, and base64 payloads never leak', async () => {
  const fakeAxios = {
    request: async () => {
      const err = new Error('Request failed with status code 401');
      err.code = 'ERR_BAD_REQUEST';
      err.config = {
        headers: { 'X-Api-Key': 'super-secret-waha-key' },
        data: JSON.stringify({ file: { data: 'BASE64_SECRET_BLOB' } })
      };
      err.request = { secretSocket: true };
      err.response = {
        status: 401,
        headers: { 'set-cookie': 'secret' },
        data: { message: 'Invalid API key super-secret-waha-key' }
      };
      throw err;
    }
  };
  const client = new WahaClient({
    baseUrl: 'http://127.0.0.1:3000',
    session: 'default',
    apiKey: 'super-secret-waha-key',
    axiosInstance: fakeAxios
  });
  try {
    await assert.rejects(
      () => client.sendText('Halo', '6281@c.us'),
      (err) => {
        assert.equal(err.status, 401);
        assert.deepEqual(err.response, { status: 401 });
        assert.equal(err.code, 'ERR_BAD_REQUEST');
        assert.equal(Object.hasOwn(err, 'config'), false);
        assert.equal(Object.hasOwn(err, 'request'), false);
        const serialized = JSON.stringify({ message: err.message, ...err });
        assert.equal(serialized.includes('super-secret-waha-key'), false);
        assert.equal(serialized.includes('BASE64_SECRET_BLOB'), false);
        return true;
      }
    );
  } finally {
    client.close();
  }
});

test('WahaClient sendImage, sendFile, sendVideo read files asynchronously, use mediaTimeoutMs, and support replyTo/mentions', async () => {
  const requests = [];
  const client = new WahaClient({
    baseUrl: 'http://127.0.0.1:3000',
    session: 'default',
    mediaTimeoutMs: 55000,
    axiosInstance: {
      request: async (cfg) => {
        requests.push(cfg);
        return { data: { id: `sent-${requests.length}` } };
      }
    }
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-waha-media-'));
  try {
    const imgPath = path.join(tmpDir, 'photo.jpg');
    const docPath = path.join(tmpDir, 'doc.pdf');
    const vidPath = path.join(tmpDir, 'clip.mp4');
    fs.writeFileSync(imgPath, Buffer.from('img-bytes'));
    fs.writeFileSync(docPath, Buffer.from('pdf-bytes'));
    fs.writeFileSync(vidPath, Buffer.from('vid-bytes'));

    await client.sendImage(imgPath, '123@g.us', {
      filename: 'photo.jpg',
      mimetype: 'image/jpeg',
      caption: 'Photo',
      replyTo: 'm1',
      mentions: ['6281@c.us']
    });
    await client.sendFile(docPath, '123@g.us', {
      filename: 'doc.pdf',
      mimetype: 'application/pdf',
      replyTo: 'm2'
    });
    await client.sendVideo(vidPath, '123@g.us', {
      filename: 'clip.mp4',
      mentions: ['6282@c.us']
    });
    await client.sendVoice(Buffer.from('voice-bytes'), '123@g.us', {
      replyTo: 'm3',
      mentions: ['6283@c.us']
    });

    assert.equal(requests.length, 4);
    assert.equal(requests[0].timeout, 55000);
    assert.equal(requests[0].data.reply_to, 'm1');
    assert.deepEqual(requests[0].data.mentions, ['6281@c.us']);
    assert.equal(requests[1].timeout, 55000);
    assert.equal(requests[1].data.reply_to, 'm2');
    assert.equal(requests[2].timeout, 55000);
    assert.deepEqual(requests[2].data.mentions, ['6282@c.us']);
    assert.equal(requests[3].timeout, 55000);
    assert.equal(requests[3].data.reply_to, 'm3');
    assert.deepEqual(requests[3].data.mentions, ['6283@c.us']);

    await assert.rejects(
      () => client.sendImage(path.join(tmpDir, 'does-not-exist.jpg'), '123@g.us'),
      (err) => err.code === 'ENOENT'
    );
  } finally {
    client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('WahaClient retries idempotent read/presence calls up to 2 times on transient errors and never retries outbound sends', async () => {
  let attempts = 0;
  const client = new WahaClient({
    baseUrl: 'http://127.0.0.1:3000',
    session: 'default',
    retryBaseDelayMs: 0,
    axiosInstance: {
      request: async (cfg) => {
        attempts++;
        if (cfg.url === '/api/sendText') {
          const err = new Error('503');
          err.response = { status: 503 };
          throw err;
        }
        if (attempts < 3) {
          const err = new Error('transient');
          err.response = { status: attempts === 1 ? 503 : 429 };
          throw err;
        }
        return { data: { status: 'WORKING' } };
      }
    }
  });

  try {
    const status = await client.sessionStatus();
    assert.deepEqual(status, { status: 'WORKING' });
    assert.equal(attempts, 3);

    attempts = 0;
    await assert.rejects(() => client.sendText('hello', '6281@c.us'), (err) => err.status === 503);
    assert.equal(attempts, 1);

    attempts = 0;
    client.http = {
      request: async () => {
        attempts++;
        const err = new Error('Bad Request');
        err.response = { status: 400 };
        throw err;
      }
    };
    await assert.rejects(() => client.getGroupInfo('123@g.us'), (err) => err.status === 400);
    assert.equal(attempts, 1);
  } finally {
    client.close();
  }
});

test('WahaClient resolveLid caches with TTL, bounds to max entries, and deduplicates concurrent in-flight requests', async () => {
  let calls = 0;
  let releasePending;
  const client = new WahaClient({
    baseUrl: 'http://127.0.0.1:3000',
    session: 'default',
    lidCacheTtlMs: 60000,
    lidCacheMaxEntries: 2,
    retryBaseDelayMs: 0
  });
  client.request = async (_method, endpoint) => {
    calls++;
    if (endpoint.includes('slow')) {
      await new Promise((resolve) => { releasePending = resolve; });
    }
    return { pn: `${calls}@c.us` };
  };

  try {
    const p1 = client.resolveLid('slow:1@lid');
    const p2 = client.resolveLid('slow:2@lid');
    releasePending();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, '1@c.us');
    assert.equal(r2, '1@c.us');
    assert.equal(calls, 1);

    // Subsequent lookup hits cache
    const r3 = await client.resolveLid('slow@lid');
    assert.equal(r3, '1@c.us');
    assert.equal(calls, 1);

    // Evicts oldest when exceeding lidCacheMaxEntries = 2
    await client.resolveLid('userA@lid');
    await client.resolveLid('userB@lid');
    assert.equal(calls, 3);
    assert.equal(client._lidCache.size, 2);

    // Non-LID passthrough
    assert.equal(await client.resolveLid('6281@c.us'), '6281@c.us');
    assert.equal(calls, 3);
  } finally {
    client.close();
  }

  // Expired TTL entry triggers fresh lookup
  let ttlCalls = 0;
  const shortTtlClient = new WahaClient({
    baseUrl: 'http://127.0.0.1:3000',
    session: 'default',
    lidCacheTtlMs: 15,
    retryBaseDelayMs: 0
  });
  shortTtlClient.request = async () => {
    ttlCalls++;
    return { pn: `628100${ttlCalls}@c.us` };
  };
  try {
    assert.equal(await shortTtlClient.resolveLid('expire@lid'), '6281001@c.us');
    assert.equal(await shortTtlClient.resolveLid('expire@lid'), '6281001@c.us');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(await shortTtlClient.resolveLid('expire@lid'), '6281002@c.us');
    assert.equal(ttlCalls, 2);
  } finally {
    shortTtlClient.close();
  }
});

test('WahaClient sendSeen options and Phase 4 read/write endpoints use expected WAHA routes and payloads', async () => {
  const calls = [];
  const client = new WahaClient({
    baseUrl: 'http://127.0.0.1:3000',
    session: 'bubu',
    retryBaseDelayMs: 0
  });
  client.request = async (...args) => {
    calls.push(args);
    return { ok: true };
  };

  try {
    await client.sendSeen('123@g.us', { messageIds: ['m1', 'm2'], participant: '6281@c.us' });
    await client.sendReaction('6281@c.us', 'm1', '❤️');
    await client.sendPoll('123@g.us', { name: 'Vote', options: ['A', 'B'], multipleAnswers: true, replyTo: 'm0' });
    await client.sendLocation('6281@c.us', { latitude: -6.2, longitude: 106.8, title: 'Jakarta', replyTo: 'm1' });
    await client.sendContactVcard('6281@c.us', [{ fullName: 'Budi' }], { replyTo: 'm2' });
    await client.checkNumberStatus('62812345');
    await client.getContactInfo('62812345@c.us');
    await client.getGroupInfo('123@g.us');
    await client.getGroupParticipants('123@g.us');
    await client.getChatMessages('6281@c.us', { limit: 25, downloadMedia: true });

    assert.deepEqual(calls, [
      ['POST', '/api/sendSeen', { session: 'bubu', chatId: '123@g.us', messageIds: ['m1', 'm2'], participant: '6281@c.us' }],
      ['PUT', '/api/reaction', { session: 'bubu', messageId: 'm1', reaction: '❤️' }],
      ['POST', '/api/sendPoll', { session: 'bubu', chatId: '123@g.us', poll: { name: 'Vote', options: ['A', 'B'], multipleAnswers: true }, reply_to: 'm0' }],
      ['POST', '/api/sendLocation', { session: 'bubu', chatId: '6281@c.us', latitude: -6.2, longitude: 106.8, title: 'Jakarta', reply_to: 'm1' }],
      ['POST', '/api/sendContactVcard', { session: 'bubu', chatId: '6281@c.us', contacts: [{ fullName: 'Budi' }], reply_to: 'm2' }],
      ['GET', '/api/contacts/check-exists', undefined, { params: { session: 'bubu', phone: '62812345' } }],
      ['GET', '/api/contacts', undefined, { params: { session: 'bubu', contactId: '62812345@c.us' } }],
      ['GET', '/api/bubu/groups/123%40g.us'],
      ['GET', '/api/bubu/groups/123%40g.us/participants'],
      ['GET', '/api/bubu/chats/6281%40c.us/messages', undefined, { params: { limit: 25, downloadMedia: true } }]
    ]);
  } finally {
    client.close();
  }
});

test('WahaClient createTypingKeepalive starts immediately, refreshes periodically, and stops cleanly', async () => {
  const events = [];
  const client = new WahaClient({
    baseUrl: 'http://127.0.0.1:3000',
    session: 'default',
    retryBaseDelayMs: 0
  });
  client.startTyping = async (chatId) => { events.push(['start', chatId]); };
  client.stopTyping = async (chatId) => { events.push(['stop', chatId]); };

  const keepalive = client.createTypingKeepalive('6281@c.us', { intervalMs: 25 });
  try {
    await keepalive.start();
    await new Promise((resolve) => setTimeout(resolve, 75));
    await keepalive.stop();
    await keepalive.stop(); // idempotent

    const starts = events.filter(([op]) => op === 'start');
    const stops = events.filter(([op]) => op === 'stop');
    assert.ok(starts.length >= 2, `Expected >=2 startTyping calls, got ${starts.length}`);
    assert.equal(stops.length, 1);
  } finally {
    await keepalive.stop();
    client.close();
  }
});
