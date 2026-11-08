const test = require('node:test');
const assert = require('node:assert/strict');
const { ResponseHandler, ResponseDeliveryError } = require('../../src/channels/response-handler');

function harness(overrides = {}) {
  const calls = [];
  const waha = {
    sendText: async (text, chatId, options) => { calls.push({ type: 'text', text, chatId, options }); return { id: 'text-1' }; },
    sendVoice: async (buffer, chatId, options) => { calls.push({ type: 'voice', buffer, chatId, options }); return { id: 'voice-1' }; },
    sendFile: async (filePath, chatId, options) => { calls.push({ type: 'file', filePath, chatId, options }); return { id: 'file-1' }; },
    sendImage: async (filePath, chatId, options) => { calls.push({ type: 'image', filePath, chatId, options }); return { id: 'image-1' }; },
    sendVideo: async (filePath, chatId, options) => { calls.push({ type: 'video', filePath, chatId, options }); return { id: 'video-1' }; },
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
