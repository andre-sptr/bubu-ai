const test = require('node:test');
const assert = require('node:assert/strict');
const { ResponseHandler, ResponseDeliveryError } = require('../../../src/channels/response-handler');

function harness(overrides = {}) {
  const calls = [];
  const waha = {
    sendText: async (text, chatId, options) => { calls.push({ type: 'text', text, chatId, options }); return { id: 'text-1' }; },
    sendVoice: async (buffer, chatId, options) => { calls.push({ type: 'voice', buffer, chatId, options }); return { id: 'voice-1' }; },
    sendFile: async (filePath, chatId, options) => { calls.push({ type: 'file', filePath, chatId, options }); return { id: 'file-1' }; },
    sendImage: async (filePath, chatId, options) => { calls.push({ type: 'image', filePath, chatId, options }); return { id: 'image-1' }; },
    sendVideo: async (filePath, chatId, options) => { calls.push({ type: 'video', filePath, chatId, options }); return { id: 'video-1' }; },
    sendReaction: async (chatId, messageId, reaction) => { calls.push({ type: 'reaction', chatId, messageId, reaction }); return { id: 'react-1' }; },
    sendPoll: async (chatId, poll) => { calls.push({ type: 'poll', chatId, poll }); return { id: 'poll-1' }; },
    sendLocation: async (chatId, location) => { calls.push({ type: 'location', chatId, location }); return { id: 'loc-1' }; },
    sendContactVcard: async (chatId, contacts, options) => { calls.push({ type: 'contact', chatId, contacts, options }); return { id: 'contact-1' }; },
    sendLinkCustomPreview: async (chatId, payload) => { calls.push({ type: 'link_preview', chatId, payload }); return { id: 'link-1' }; },
    editMessage: async (chatId, messageId, text, options) => { calls.push({ type: 'edit', chatId, messageId, text, options }); return { id: messageId }; },
    deleteMessage: async (chatId, messageId) => { calls.push({ type: 'delete', chatId, messageId }); return { id: messageId }; },
    forwardMessage: async (chatId, messageId) => { calls.push({ type: 'forward', chatId, messageId }); return { id: 'fwd-1' }; },
    ...overrides
  };
  const mediaService = { createVoiceReply: async (text) => Buffer.from(`audio:${text}`) };
  return { handler: new ResponseHandler({ waha, mediaService }), calls, waha, mediaService };
}

test('sendText formats Markdown and returns a normalized delivery receipt', async () => {
  const h = harness();
  const receipt = await h.handler.sendText('## Halo\n**Bubu**', 'chat@c.us');
  assert.equal(h.calls[0].text, '*Halo*\n*Bubu*');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.type, 'text');
  assert.equal(receipt.messageId, 'text-1');
});

test('sendAssistantResponse text mode sends only formatted text', async () => {
  const h = harness();
  const result = await h.handler.sendAssistantResponse('**Halo**', 'chat@c.us', 'text');
  assert.deepEqual(result.deliveries.map((item) => item.type), ['text']);
});

test('sendAssistantResponse voice mode sends only voice', async () => {
  const h = harness();
  const result = await h.handler.sendAssistantResponse('Halo', 'chat@c.us', 'voice');
  assert.deepEqual(h.calls.map((item) => item.type), ['voice']);
  assert.equal(result.mode, 'voice');
});

test('sendAssistantResponse both mode sends formatted text then voice from original text', async () => {
  const h = harness();
  const result = await h.handler.sendAssistantResponse('## Halo', 'chat@c.us', 'both');
  assert.deepEqual(h.calls.map((item) => item.type), ['text', 'voice']);
  assert.equal(h.calls[0].text, '*Halo*');
  assert.equal(h.calls[1].buffer.toString(), 'audio:## Halo');
  assert.equal(result.deliveries.length, 2);
});

test('sendAssistantResponse voice-only remains fail-closed if TTS fails', async () => {
  const h = harness();
  h.mediaService.createVoiceReply = async () => { throw new Error('Piper failed'); };
  await assert.rejects(
    () => h.handler.sendAssistantResponse('Halo', 'chat@c.us', 'voice'),
    /Piper failed/
  );
  assert.equal(h.calls.length, 0);
});

test('sendAssistantResponse both mode reports partial delivery if voice send fails after text', async () => {
  const h = harness({
    sendVoice: async () => { throw new Error('WAHA voice timeout'); }
  });
  await assert.rejects(
    () => h.handler.sendAssistantResponse('Halo', 'chat@c.us', 'both'),
    (error) => error instanceof ResponseDeliveryError &&
      error.deliveryStatus === 'uncertain' &&
      error.sentTypes.includes('text')
  );
  assert.equal(h.calls.filter((item) => item.type === 'text').length, 1);
});

test('sendFile and sendImage use the normalized media delivery path and format captions', async () => {
  const h = harness();
  const file = await h.handler.sendFile('/tmp/report.docx', 'group@g.us', {
    filename: 'report.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    caption: '**Report**'
  });
  const image = await h.handler.sendImage('/tmp/photo.jpg', 'group@g.us', {
    filename: 'photo.jpg',
    mimetype: 'image/jpeg',
    caption: '## Foto'
  });
  assert.equal(file.type, 'file');
  assert.equal(h.calls[0].options.caption, '*Report*');
  assert.equal(image.type, 'image');
  assert.equal(h.calls[1].options.caption, '*Foto*');
});

test('sendVideo uses the WAHA video adapter and formats its caption', async () => {
  const h = harness();
  const result = await h.handler.send({
    type: 'video',
    filePath: '/tmp/demo.mp4',
    chatId: 'chat@c.us',
    options: { filename: 'demo.mp4', mimetype: 'video/mp4', caption: '**Demo**' }
  });
  assert.equal(result.type, 'video');
  assert.equal(h.calls[0].type, 'video');
  assert.equal(h.calls[0].options.caption, '*Demo*');
});

test('generic send dispatcher rejects unsupported response types', async () => {
  const h = harness();
  await assert.rejects(
    () => h.handler.send({ type: 'sticker', chatId: 'chat@c.us' }),
    /Unsupported response type/
  );
});


test('sendText can preserve already-formatted WhatsApp text for system notifications', async () => {
  const h = harness();
  await h.handler.sendText('⏰ *Reminder Bubu*', 'chat@c.us', { format: false });
  assert.equal(h.calls[0].text, '⏰ *Reminder Bubu*');
  assert.equal(h.calls[0].options.format, undefined);
});

test('sendAssistantResponse forwards replyTo and mentions only when explicitly passed', async () => {
  const h = harness();
  await h.handler.sendAssistantResponse('Halo', 'group@g.us', 'text');
  assert.deepEqual(h.calls[0].options, {});

  await h.handler.sendAssistantResponse('Halo **tim**', 'group@g.us', 'text', {
    replyTo: 'msg-99',
    mentions: ['6281@c.us']
  });
  assert.deepEqual(h.calls[1].options, { replyTo: 'msg-99', mentions: ['6281@c.us'] });

  await h.handler.sendAssistantResponse('Halo voice', 'group@g.us', 'both', {
    replyTo: 'msg-100',
    mentions: ['6282@c.us']
  });
  assert.deepEqual(h.calls[2].options, { replyTo: 'msg-100', mentions: ['6282@c.us'] });
  assert.deepEqual(h.calls[3].options, { replyTo: 'msg-100', mentions: ['6282@c.us'] });
});

test('ResponseDeliveryError classifies deterministic FS/4xx errors as failed and transient/untyped errors as uncertain', async () => {
  for (const code of ['ENOENT', 'EACCES', 'EISDIR']) {
    const h = harness({
      sendFile: async () => { throw Object.assign(new Error(`FS ${code}`), { code }); }
    });
    await assert.rejects(
      () => h.handler.sendFile('/missing.pdf', 'chat@c.us'),
      (err) => err instanceof ResponseDeliveryError && err.deliveryStatus === 'failed'
    );
  }

  for (const status of [400, 401, 403, 404, 413, 415, 422]) {
    const h = harness({
      sendText: async () => { throw Object.assign(new Error(`HTTP ${status}`), { response: { status } }); }
    });
    await assert.rejects(
      () => h.handler.sendText('Halo', 'chat@c.us'),
      (err) => err instanceof ResponseDeliveryError && err.deliveryStatus === 'failed'
    );
  }

  const hTts = harness();
  hTts.mediaService.createVoiceReply = async () => { throw new Error('Piper model missing'); };
  await assert.rejects(
    () => hTts.handler.sendAssistantResponse('Halo', 'chat@c.us', 'voice'),
    (err) => err instanceof ResponseDeliveryError && err.deliveryStatus === 'failed' && err.type === 'voice_generation'
  );

  for (const cause of [
    Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    Object.assign(new Error('server error'), { response: { status: 503 } }),
    new Error('WAHA voice timeout')
  ]) {
    const h = harness({ sendText: async () => { throw cause; } });
    await assert.rejects(
      () => h.handler.sendText('Halo', 'chat@c.us'),
      (err) => err instanceof ResponseDeliveryError && err.deliveryStatus === 'uncertain'
    );
  }
});

test('Phase 4 outbound methods (reaction, poll, location, contact) format inputs, return receipts, and dispatch via send()', async () => {
  const h = harness();

  const reactReceipt = await h.handler.send({
    type: 'reaction',
    chatId: 'chat@c.us',
    messageId: 'msg-1',
    reaction: '👍'
  });
  assert.equal(reactReceipt.ok, true);
  assert.equal(reactReceipt.type, 'reaction');
  assert.equal(reactReceipt.messageId, 'react-1');
  assert.deepEqual(h.calls[0], { type: 'reaction', chatId: 'chat@c.us', messageId: 'msg-1', reaction: '👍' });

  const pollReceipt = await h.handler.send({
    type: 'poll',
    chatId: 'group@g.us',
    name: '**Makan siang?**',
    options: ['**Nasi Goreng**', 'Mie Ayam'],
    multipleAnswers: true,
    replyTo: 'msg-2'
  });
  assert.equal(pollReceipt.type, 'poll');
  assert.equal(pollReceipt.name, '*Makan siang?*');
  assert.deepEqual(pollReceipt.options, ['*Nasi Goreng*', 'Mie Ayam']);
  assert.deepEqual(h.calls[1].poll, {
    name: '*Makan siang?*',
    options: ['*Nasi Goreng*', 'Mie Ayam'],
    multipleAnswers: true,
    replyTo: 'msg-2'
  });

  const locReceipt = await h.handler.send({
    type: 'location',
    chatId: 'chat@c.us',
    latitude: -6.2,
    longitude: 106.8,
    title: '**Monas**'
  });
  assert.equal(locReceipt.type, 'location');
  assert.equal(locReceipt.title, '*Monas*');
  assert.deepEqual(h.calls[2].location, { latitude: -6.2, longitude: 106.8, title: '*Monas*' });

  const contactReceipt = await h.handler.send({
    type: 'contact',
    chatId: 'chat@c.us',
    contacts: [{ fullName: 'Budi', phoneNumber: '+628123456' }],
    replyTo: 'msg-3'
  });
  assert.equal(contactReceipt.type, 'contact');
  assert.equal(contactReceipt.count, 1);
  assert.deepEqual(h.calls[3], {
    type: 'contact',
    chatId: 'chat@c.us',
    contacts: [{ fullName: 'Budi', phoneNumber: '+628123456' }],
    options: { replyTo: 'msg-3' }
  });

  await assert.rejects(
    () => h.handler.sendPoll('group@g.us', { name: 'Vote', options: ['OnlyOne'] }),
    /at least 2/
  );
  await assert.rejects(
    () => h.handler.sendLocation('chat@c.us', { latitude: 120, longitude: 106.8 }),
    /Valid latitude and longitude/
  );
});

test('sendText chunks long messages sequentially with replyTo/mentions on chunk 1 only and preserves single-chunk receipts', async () => {
  let seq = 0;
  const calls = [];
  const waha = {
    sendText: async (text, chatId, options) => {
      seq++;
      calls.push({ type: 'text', text, chatId, options });
      return { id: `chunk-${seq}` };
    }
  };
  const handler = new ResponseHandler({ waha });

  // Single chunk retains exact existing shape (no messageIds / chunks properties)
  const single = await handler.sendText('Short message', 'chat@c.us', { maxChunkChars: 50 });
  assert.deepEqual(single, {
    ok: true,
    type: 'text',
    chatId: 'chat@c.us',
    messageId: 'chunk-1',
    response: { id: 'chunk-1' }
  });

  // chunk: false disables splitting even when longer than maxChunkChars
  calls.length = 0;
  const unchunked = await handler.sendText('A'.repeat(40), 'chat@c.us', { maxChunkChars: 15, chunk: false });
  assert.equal(calls.length, 1);
  assert.equal(unchunked.chunks, undefined);

  // Multi-chunk applies replyTo and mentions on chunk 1 only and uses config.waha.maxMessageChars
  calls.length = 0;
  seq = 0;
  const configuredHandler = new ResponseHandler({
    waha,
    config: { waha: { maxMessageChars: 20 } }
  });
  const multi = await configuredHandler.sendText(
    'Paragraf pertama.\n\nParagraf kedua.\n\nParagraf ketiga.',
    'group@g.us',
    { replyTo: 'orig-1', mentions: ['6281@c.us'] }
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].options, { replyTo: 'orig-1', mentions: ['6281@c.us'] });
  assert.deepEqual(calls[1].options, {});
  assert.deepEqual(calls[2].options, {});
  assert.deepEqual(multi, {
    ok: true,
    type: 'text',
    chatId: 'group@g.us',
    messageId: 'chunk-1',
    messageIds: ['chunk-1', 'chunk-2', 'chunk-3'],
    chunks: 3,
    response: { id: 'chunk-1' }
  });
});

test('sendText throws uncertain ResponseDeliveryError with sentTypes=[text] if chunk i > 0 fails', async () => {
  let attempt = 0;
  const h = harness({
    sendText: async (text, chatId, options) => {
      attempt++;
      h.calls.push({ type: 'text', text, chatId, options });
      if (attempt === 2) {
        throw Object.assign(new Error('Bad request on chunk 2'), { response: { status: 400 } });
      }
      return { id: `chunk-${attempt}` };
    }
  });

  await assert.rejects(
    () => h.handler.sendText('Chunk one.\n\nChunk two.', 'chat@c.us', { maxChunkChars: 12 }),
    (err) => err instanceof ResponseDeliveryError &&
      err.deliveryStatus === 'uncertain' &&
      Array.isArray(err.sentTypes) &&
      err.sentTypes.includes('text')
  );
  assert.equal(attempt, 2);
});

test('Stage 1 Phase 4 outbound methods (link_preview, edit, delete, forward) validate, format, and dispatch via send()', async () => {
  const h = harness();

  // SSRF / URL validation before WAHA call
  for (const badUrl of [
    '',
    'not-a-url',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pass@example.com',
    'http://localhost:3000/test',
    'http://127.0.0.1/admin',
    'http://10.0.0.5/internal',
    'http://169.254.169.254/latest/meta-data',
    'http://192.168.1.10/router',
    'http://[::1]:8080/test'
  ]) {
    await assert.rejects(
      () => h.handler.sendLinkPreview('chat@c.us', { text: 'Test', url: badUrl }),
      /URL|host/i
    );
  }
  assert.equal(h.calls.length, 0);

  const linkReceipt = await h.handler.send({
    type: 'link_preview',
    chatId: 'group@g.us',
    text: 'Cek **artikel** https://example.com/guide',
    url: 'https://example.com/guide',
    title: '**Panduan**',
    description: 'Ringkasan *singkat*',
    replyTo: 'm0',
    mentions: ['6281@c.us']
  });
  assert.equal(linkReceipt.ok, true);
  assert.equal(linkReceipt.type, 'link_preview');
  assert.equal(linkReceipt.messageId, 'link-1');
  assert.deepEqual(h.calls[0], {
    type: 'link_preview',
    chatId: 'group@g.us',
    payload: {
      text: 'Cek *artikel* https://example.com/guide',
      url: 'https://example.com/guide',
      title: '*Panduan*',
      description: 'Ringkasan _singkat_',
      replyTo: 'm0',
      mentions: ['6281@c.us']
    }
  });

  const editReceipt = await h.handler.send({
    type: 'edit',
    chatId: 'group@g.us',
    messageId: 'm1',
    text: '**Revisi**',
    options: { mentions: ['6282@c.us'] }
  });
  assert.equal(editReceipt.type, 'edit');
  assert.deepEqual(h.calls[1], {
    type: 'edit',
    chatId: 'group@g.us',
    messageId: 'm1',
    text: '*Revisi*',
    options: { mentions: ['6282@c.us'] }
  });

  await h.handler.editMessage('chat@c.us', 'm2', '**Raw**', { format: false });
  assert.equal(h.calls[2].text, '**Raw**');

  const delReceipt = await h.handler.send({ type: 'delete', chatId: 'chat@c.us', messageId: 'm2' });
  assert.equal(delReceipt.type, 'delete');
  assert.deepEqual(h.calls[3], { type: 'delete', chatId: 'chat@c.us', messageId: 'm2' });

  const fwdReceipt = await h.handler.send({ type: 'forward', chatId: 'chat@c.us', messageId: 'm3' });
  assert.equal(fwdReceipt.type, 'forward');
  assert.equal(fwdReceipt.messageId, 'fwd-1');
  assert.deepEqual(h.calls[4], { type: 'forward', chatId: 'chat@c.us', messageId: 'm3' });

  // Failures wrap in ResponseDeliveryError
  const failing = harness({
    editMessage: async () => { throw Object.assign(new Error('Gone'), { response: { status: 404 } }); }
  });
  await assert.rejects(
    () => failing.handler.editMessage('chat@c.us', 'm9', 'New text'),
    (err) => err instanceof ResponseDeliveryError && err.deliveryStatus === 'failed' && err.type === 'edit'
  );
});

test('Stage 1: sendLinkPreview blocks DNS resolutions to private networks and fails closed when dnsLookup errors', async () => {
  for (const resolved of [
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '10.3.14.216', family: 4 }],
    [{ address: '::ffff:7f00:1', family: 6 }]
  ]) {
    const calls = [];
    const handler = new ResponseHandler({
      waha: { sendLinkCustomPreview: async (...args) => calls.push(args) },
      dnsLookup: async () => resolved
    });
    await assert.rejects(
      () => handler.sendLinkPreview('chat@c.us', { url: 'https://rebind.nip.io/secret' }),
      /private network/i
    );
    assert.equal(calls.length, 0);
  }

  const failingDnsHandler = new ResponseHandler({
    waha: { sendLinkCustomPreview: async () => assert.fail('must not call WAHA') },
    dnsLookup: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); }
  });
  await assert.rejects(
    () => failingDnsHandler.sendLinkPreview('chat@c.us', { url: 'https://unknown.invalid/test' }),
    /could not be resolved safely/i
  );
});
