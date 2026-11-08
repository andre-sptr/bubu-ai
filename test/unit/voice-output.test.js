const test = require('node:test');
const assert = require('node:assert/strict');
const { WahaClient } = require('../../src/channels/waha/client');
const { ResponseHandler, ResponseDeliveryError } = require('../../src/channels/response-handler');

function makeResponseHarness({ failVoice = false, failTts = false } = {}) {
  const calls = [];
  const waha = {
    sendText: async (text, chatId) => {
      calls.push({ type: 'text', text, chatId });
      return { id: `text-${calls.length}` };
    },
    sendVoice: async (buffer, chatId, options) => {
      calls.push({ type: 'voice', buffer: Buffer.from(buffer), chatId, options });
      if (failVoice) throw new Error('simulated WAHA voice timeout');
      return { id: `voice-${calls.length}` };
    }
  };
  const mediaService = {
    createVoiceReply: async text => {
      if (failTts) throw new Error('simulated Piper failure');
      return Buffer.from(`ogg-opus:${text}`);
    }
  };
  return { handler: new ResponseHandler({ waha, mediaService }), calls };
}

for (const chatId of ['628111111111@c.us', '120363000000000000@g.us']) {
  const label = chatId.endsWith('@g.us') ? 'group' : 'DM';

  test(`${label}: text mode sends text only`, async () => {
    const h = makeResponseHarness();
    const result = await h.handler.sendAssistantResponse('Halo Bubu', chatId, 'text');
    assert.deepEqual(h.calls.map(x => x.type), ['text']);
    assert.equal(h.calls[0].chatId, chatId);
    assert.equal(result.mode, 'text');
  });

  test(`${label}: voice mode sends voice only`, async () => {
    const h = makeResponseHarness();
    const result = await h.handler.sendAssistantResponse('Halo Bubu', chatId, 'voice');
    assert.deepEqual(h.calls.map(x => x.type), ['voice']);
    assert.equal(h.calls[0].chatId, chatId);
    assert.equal(h.calls[0].buffer.toString(), 'ogg-opus:Halo Bubu');
    assert.equal(result.mode, 'voice');
  });

  test(`${label}: both mode sends text then voice to the same chat`, async () => {
    const h = makeResponseHarness();
    const result = await h.handler.sendAssistantResponse('Halo Bubu', chatId, 'both');
    assert.deepEqual(h.calls.map(x => x.type), ['text', 'voice']);
    assert.deepEqual(h.calls.map(x => x.chatId), [chatId, chatId]);
    assert.equal(result.deliveries.length, 2);
  });

  test(`${label}: voice-only TTS failure is fail-closed`, async () => {
    const h = makeResponseHarness({ failTts: true });
    await assert.rejects(
      () => h.handler.sendAssistantResponse('Halo Bubu', chatId, 'voice'),
      /simulated Piper failure/
    );
    assert.deepEqual(h.calls, []);
  });

  test(`${label}: both mode reports uncertain partial delivery if voice send fails`, async () => {
    const h = makeResponseHarness({ failVoice: true });
    await assert.rejects(
      () => h.handler.sendAssistantResponse('Halo Bubu', chatId, 'both'),
      error => error instanceof ResponseDeliveryError &&
        error.deliveryStatus === 'uncertain' &&
        error.sentTypes.includes('text')
    );
    assert.deepEqual(h.calls.map(x => x.type), ['text', 'voice']);
    assert.equal(h.calls[0].chatId, chatId);
    assert.equal(h.calls[1].chatId, chatId);
  });
}

test('WAHA sendVoice adapter posts base64 OGG/Opus payload to /api/sendVoice', async () => {
  const client = new WahaClient({
    baseUrl: 'http://waha.test:3000/',
    session: 'default',
    apiKey: 'test-key'
  });
  let captured;
  client.request = async (method, endpoint, body) => {
    captured = { method, endpoint, body };
    return { id: 'waha-voice-1' };
  };

  const audio = Buffer.from('fixture-ogg-opus');
  const response = await client.sendVoice(audio, '628111111111@c.us');

  assert.deepEqual(captured, {
    method: 'POST',
    endpoint: '/api/sendVoice',
    body: {
      session: 'default',
      chatId: '628111111111@c.us',
      file: {
        filename: 'bubu-voice.ogg',
        mimetype: 'audio/ogg; codecs=opus',
        data: audio.toString('base64')
      },
      convert: false
    }
  });
  assert.equal(response.id, 'waha-voice-1');
});

test('WAHA sendVoice adapter allows explicit filename, MIME and convert option', async () => {
  const client = new WahaClient({
    baseUrl: 'http://waha.test:3000',
    session: 'default'
  });
  let captured;
  client.request = async (method, endpoint, body) => {
    captured = { method, endpoint, body };
    return { id: 'voice-custom' };
  };

  await client.sendVoice(Buffer.from('custom'), '120363000000000000@g.us', {
    filename: 'reply.ogg',
    mimetype: 'audio/ogg; codecs=opus',
    convert: true
  });

  assert.equal(captured.endpoint, '/api/sendVoice');
  assert.equal(captured.body.chatId, '120363000000000000@g.us');
  assert.equal(captured.body.file.filename, 'reply.ogg');
  assert.equal(captured.body.convert, true);
});
