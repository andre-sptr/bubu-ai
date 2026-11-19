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
