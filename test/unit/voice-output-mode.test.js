const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageProcessor } = require('../../src/agent/message-processor');

function fixture({ mode = 'text', sender = '628111111111@c.us', chatId = '628111111111@c.us', piper = '/models/id_ID-voice.onnx', ttsFails = false } = {}) {
  const sentText = [];
  const sentVoice = [];
  const preferences = new Map();
  const db = {
    consumeRateLimit: () => ({ allowed: true }),
    getChatOutputMode: ({ chatId: c, requesterId, defaultMode }) => preferences.get(`${c}:${requesterId}`) || mode || defaultMode,
    getChatOutputPreference: ({ chatId: c, requesterId, defaultMode }) => {
      const saved = preferences.get(`${c}:${requesterId}`);
      return saved ? { mode: saved, isCustom: true } : { mode: defaultMode || mode, isCustom: false };
    },
    setChatOutputMode: ({ chatId: c, requesterId, mode: m }) => preferences.set(`${c}:${requesterId}`, m),
    resetChatOutputMode: ({ chatId: c, requesterId }) => preferences.delete(`${c}:${requesterId}`),
    getHistory: () => [],
    addMessage: () => {},
    searchMemories: () => [],
    claimTaskResponse: () => 'Ini jawaban Bubu.',
    finishTaskResponse: () => {}
  };
  const waha = {
    sendText: async (text, target) => { sentText.push({ text, target }); },
    sendVoice: async (audio, target) => { sentVoice.push({ audio, target }); }
  };
  const mediaService = {
    createVoiceReply: async () => {
      if (ttsFails) throw new Error('TTS unavailable');
      return Buffer.from('voice-data');
    }
  };
  const config = {
    ownerJid: '628111111111@c.us',
    groupPolicy: 'all',
    groupRequireMention: true,
    agent: { messageRateLimit: 10, messageRateWindowMs: 60000, enabled: true },
    media: { enabled: true, piperModelPath: piper, voiceReplyDefault: false },
    documents: { maxExtractChars: 50000 }
  };
  const processor = new MessageProcessor({
    config, db, waha, mediaService,
    agent: { run: async () => ({ taskId: 'task-1', text: 'Ini jawaban Bubu.' }) },
    router: { select: () => ({ model: 'test' }) },
    provider: {}, approvalManager: {}, documentService: {},
    memoryService: null,
    logger: { warn: () => {} }
  });
  return { processor, sentText, sentVoice, preferences, db };
}

test('voice-only mode sends voice and never sends the generated answer as text', async () => {
  const f = fixture({ mode: 'voice' });
  await f.processor.process({
    event: 'message',
    payload: { id: 'event-voice-only', from: '628111111111@c.us', author: '628111111111@c.us', body: 'Jelaskan singkat.' }
  });
  assert.equal(f.sentText.length, 0);
  assert.equal(f.sentVoice.length, 1);
  assert.equal(f.sentVoice[0].target, '628111111111@c.us');
});

test('text-only mode sends text and no voice', async () => {
  const f = fixture({ mode: 'text' });
  await f.processor.process({
    event: 'message',
    payload: { id: 'event-text-only', from: '628111111111@c.us', author: '628111111111@c.us', body: 'Halo.' }
  });
  assert.equal(f.sentText.length, 1);
  assert.equal(f.sentVoice.length, 0);
});

test('both mode sends text and voice', async () => {
  const f = fixture({ mode: 'both' });
  await f.processor.process({
    event: 'message',
    payload: { id: 'event-both', from: '628111111111@c.us', author: '628111111111@c.us', body: 'Halo.' }
  });
  assert.equal(f.sentText.length, 1);
  assert.equal(f.sentVoice.length, 1);
});

test('voice-only mode fails closed when TTS fails', async () => {
  const f = fixture({ mode: 'voice', ttsFails: true });
  await assert.rejects(() => f.processor.process({
    event: 'message',
    payload: { id: 'event-tts-failure', from: '628111111111@c.us', author: '628111111111@c.us', body: 'Halo.' }
  }), /TTS unavailable/);
  assert.equal(f.sentText.length, 0);
  assert.equal(f.sentVoice.length, 0);
});

test('/voice on sets voice-only preference for the current chat', async () => {
  const f = fixture({ chatId: '628111111111@c.us' });
  await f.processor.process({
    event: 'message',
    payload: { id: 'event-command-on', from: '628111111111@c.us', author: '628111111111@c.us', body: '/voice on' }
  });
  assert.equal(f.preferences.get('628111111111@c.us:628111111111@c.us'), 'voice');
  assert.equal(f.sentText.length, 0);
  assert.equal(f.sentVoice.length, 1);
});

test('/voice command is accepted in a group by the owner and scoped to that group', async () => {
  const f = fixture({ chatId: '120363000000000000@g.us' });
  await f.processor.process({
    event: 'message',
    payload: { id: 'event-group-command', from: '120363000000000000@g.us', author: '628111111111@c.us', body: '/voice on' }
  });
  assert.equal(f.preferences.get('120363000000000000@g.us:628111111111@c.us'), 'voice');
});


test('/voice reset removes only the current chat override and restores configured default', async () => {
  const f = fixture({ mode: 'text' });
  await f.processor.process({
    event: 'message',
    payload: { id: 'event-reset-on', from: '628111111111@c.us', author: '628111111111@c.us', body: '/voice on' }
  });
  assert.equal(f.preferences.get('628111111111@c.us:628111111111@c.us'), 'voice');

  await f.processor.process({
    event: 'message',
    payload: { id: 'event-reset-default', from: '628111111111@c.us', author: '628111111111@c.us', body: '/voice reset' }
  });
  assert.equal(f.preferences.has('628111111111@c.us:628111111111@c.us'), false);
  assert.equal(f.sentText.length, 1);
  assert.match(f.sentText[0].text, /mengikuti default Bubu: text-only/);
});
