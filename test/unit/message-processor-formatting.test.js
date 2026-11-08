const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageProcessor } = require('../../src/agent/message-processor');

test('text-only response sends WhatsApp-formatted text', async () => {
  const sent = [];
  const processor = new MessageProcessor({
    config: { media: { enabled: false } },
    waha: { sendText: async (text, chatId) => sent.push({ text, chatId }) }
  });
  await processor.sendConfiguredResponse('## Halo\n**Penting**', 'chat@c.us', 'text');
  assert.deepEqual(sent, [{ text: '*Halo*\n*Penting*', chatId: 'chat@c.us' }]);
});

test('both mode formats WhatsApp text but sends original content to TTS', async () => {
  const sent = [];
  let spoken = null;
  const processor = new MessageProcessor({
    config: { media: { enabled: true, piperModelPath: '/voice.onnx' } },
    mediaService: { createVoiceReply: async (text) => { spoken = text; return Buffer.from('audio'); } },
    waha: {
      sendText: async (text, chatId) => sent.push({ text, chatId }),
      sendVoice: async (_audio, chatId) => sent.push({ voice: true, chatId })
    }
  });
  const original = '## Halo\n**Penting**';
  await processor.sendConfiguredResponse(original, 'chat@c.us', 'both');
  assert.equal(spoken, original);
  assert.equal(sent[0].text, '*Halo*\n*Penting*');
  assert.deepEqual(sent[1], { voice: true, chatId: 'chat@c.us' });
});

test('voice-only mode does not send text', async () => {
  const sent = [];
  const processor = new MessageProcessor({
    config: { media: { enabled: true, piperModelPath: '/voice.onnx' } },
    mediaService: { createVoiceReply: async () => Buffer.from('audio') },
    waha: {
      sendText: async (text) => sent.push(text),
      sendVoice: async () => sent.push('voice')
    }
  });
  await processor.sendConfiguredResponse('## Halo', 'chat@c.us', 'voice');
  assert.deepEqual(sent, ['voice']);
});
