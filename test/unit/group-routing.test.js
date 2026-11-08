const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageProcessor, hasBotMention } = require('../../src/agent/message-processor');

function fixture({ groupMediaRequireMention = false, botJid = '628999999999@c.us' } = {}) {
  const sent = [];
  const presenceEvents = [];
  let agentCalls = 0;
  let mediaCalls = 0;
  let documentCalls = 0;
  const mediaMimes = [];
  const db = {
    consumeRateLimit: () => ({ allowed: true }),
    getHistory: () => [],
    addMessage: () => {},
    searchMemories: () => [],
    getChatOutputMode: () => 'text',
    claimTaskResponse: () => 'Hasil analisis Bubu.',
    finishTaskResponse: () => {}
  };
  const waha = {
    sendSeen: async (chatId) => { presenceEvents.push(`seen:${chatId}`); },
    startTyping: async (chatId) => { presenceEvents.push(`typing:${chatId}`); },
    stopTyping: async (chatId) => { presenceEvents.push(`stop:${chatId}`); },
    sendText: async (text, chatId) => { sent.push({ text, chatId }); presenceEvents.push(`send:${chatId}`); },
    sendVoice: async () => assert.fail('voice not expected in text-mode routing test')
  };
  const mediaService = {
    processIncoming: async ({ media }) => {
      mediaCalls += 1;
      mediaMimes.push(media.mimetype);
      return { kind: media.mimetype?.startsWith('audio/') ? 'audio' : 'image',
        filename: media.filename || 'media.bin',
        promptText: media.mimetype?.startsWith('audio/') ? 'Transkripsi voice note.' : 'Gambar berisi seekor kucing.' };
    }
  };
  const config = {
    ownerJid: '628111111111@c.us',
    waha: { baseUrl: 'http://waha:3000' },
    botJid,
    groupPolicy: 'all',
    groupRequireMention: true,
    groupMediaRequireMention,
    agent: { messageRateLimit: 10, messageRateWindowMs: 60000, enabled: true },
    media: { enabled: true, piperModelPath: '', voiceReplyDefault: false },
    documents: { maxExtractChars: 50000 }
  };
  const processor = new MessageProcessor({
    config, db, waha, mediaService,
    agent: { run: async () => { agentCalls += 1; return { taskId: `task-${agentCalls}`, text: 'Hasil analisis Bubu.' }; } },
    router: { select: () => ({ model: 'test' }) },
    provider: {}, approvalManager: {},
    documentService: { ingestMedia: async () => {
      documentCalls += 1;
      return { id: 'doc-1', filename: 'report.pdf', mime_type: 'application/pdf', extractedText: 'Isi laporan.' };
    } },
    memoryService: null,
    logger: { warn: () => {} }
  });
  return {
    processor, sent, presenceEvents,
    get agentCalls() { return agentCalls; },
    get mediaCalls() { return mediaCalls; },
    get documentCalls() { return documentCalls; },
    mediaMimes
  };
}

const groupPayload = (id, body, extra = {}) => ({
  event: 'message',
  payload: {
    id, from: '120363000000000000@g.us', author: '628111111111@c.us',
    body, ...extra
  }
});

test('ordinary group text without a Bubu mention is ignored', async () => {
  const f = fixture();
  await f.processor.process(groupPayload('group-plain', 'Halo semuanya, rapat jam 3.'));
  assert.equal(f.agentCalls, 0);
  assert.equal(f.sent.length, 0);
});

test('group text with literal Bubu mention is processed', async () => {
  const f = fixture();
  await f.processor.process(groupPayload('group-bubu', 'Bubu tolong rangkum ini.'));
  assert.equal(f.agentCalls, 1);
  assert.equal(f.sent.length, 1);
});

test('group text with native mention metadata matching BOT_JID is processed', async () => {
  const f = fixture();
  await f.processor.process(groupPayload('group-native-mention', 'Tolong bantu ya', {
    mentionedIds: ['628999999999@s.whatsapp.net']
  }));
  assert.equal(f.agentCalls, 1);
  assert.equal(f.sent.length, 1);
});

test('group media-only message is processed by default even with mention gating enabled', async () => {
  const f = fixture();
  await f.processor.process(groupPayload('group-image-only', '', {
    hasMedia: true,
    media: { url: 'http://waha:3000/api/files/cat.jpg', filename: 'cat.jpg', mimetype: 'image/jpeg' }
  }));
  assert.equal(f.mediaCalls, 1);
  assert.equal(f.agentCalls, 1);
  assert.equal(f.sent.length, 1);
});

test('group media-only message is ignored when GROUP_MEDIA_REQUIRE_MENTION is enabled and no mention exists', async () => {
  const f = fixture({ groupMediaRequireMention: true });
  await f.processor.process(groupPayload('group-image-strict', '', {
    hasMedia: true,
    media: { url: 'http://waha:3000/api/files/cat.jpg', filename: 'cat.jpg', mimetype: 'image/jpeg' }
  }));
  assert.equal(f.mediaCalls, 0);
  assert.equal(f.agentCalls, 0);
  assert.equal(f.sent.length, 0);
});

test('group media with a caption still requires mention when mention gating is enabled', async () => {
  const f = fixture();
  await f.processor.process(groupPayload('group-caption-no-mention', 'Tolong jelaskan gambar ini', {
    hasMedia: true,
    media: { url: 'http://waha:3000/api/files/cat.jpg', filename: 'cat.jpg', mimetype: 'image/jpeg' }
  }));
  assert.equal(f.mediaCalls, 0);
  assert.equal(f.agentCalls, 0);
});

test('group media with a Bubu caption is processed', async () => {
  const f = fixture();
  await f.processor.process(groupPayload('group-caption-mention', 'Bubu jelaskan gambar ini', {
    hasMedia: true,
    media: { url: 'http://waha:3000/api/files/cat.jpg', filename: 'cat.jpg', mimetype: 'image/jpeg' }
  }));
  assert.equal(f.mediaCalls, 1);
  assert.equal(f.agentCalls, 1);
});

test('direct messages are not subject to group mention gating', async () => {
  const f = fixture();
  await f.processor.process({
    event: 'message',
    payload: {
      id: 'dm-no-mention', from: '628111111111@c.us',
      author: '628111111111@c.us', body: 'Tolong bantu.'
    }
  });
  assert.equal(f.agentCalls, 1);
});

test('native mention helper matches bot JID and avoids matching other group participants', () => {
  assert.equal(hasBotMention({
    text: 'Bisa bantu?', mentions: ['628999999999@s.whatsapp.net']
  }, '628999999999@c.us'), true);
  assert.equal(hasBotMention({
    text: 'Bisa bantu?', mentions: ['628888888888@c.us']
  }, '628999999999@c.us'), false);
});


test('group voice note without caption is routed to media processing', async () => {
  const f = fixture();
  await f.processor.process(groupPayload('group-audio-only', '', {
    hasMedia: true,
    media: { url: 'http://waha:3000/api/files/voice.ogg', filename: 'voice.ogg', mimetype: 'audio/ogg' }
  }));
  assert.equal(f.mediaCalls, 1);
  assert.deepEqual(f.mediaMimes, ['audio/ogg']);
  assert.equal(f.agentCalls, 1);
});

test('group document without caption is routed to document ingestion', async () => {
  const f = fixture();
  await f.processor.process(groupPayload('group-document-only', '', {
    hasMedia: true,
    media: { url: 'http://waha:3000/api/files/report.pdf', filename: 'report.pdf', mimetype: 'application/pdf' }
  }));
  assert.equal(f.documentCalls, 1);
  assert.equal(f.agentCalls, 1);
});


test('eligible group message is seen, typing starts before response, and typing stops after delivery', async () => {
  const f = fixture();
  const chatId = '120363000000000000@g.us';
  await f.processor.process(groupPayload('group-presence', 'Bubu, halo.'));
  assert.deepEqual(f.presenceEvents, [
    `seen:${chatId}`,
    `typing:${chatId}`,
    `send:${chatId}`,
    `stop:${chatId}`
  ]);
});

test('ignored ordinary group conversation does not send seen or typing presence', async () => {
  const f = fixture();
  await f.processor.process(groupPayload('group-presence-ignored', 'Percakapan biasa.'));
  assert.deepEqual(f.presenceEvents, []);
});

test('typing is stopped even when Agent processing throws', async () => {
  const f = fixture();
  f.processor.agent.run = async () => { throw new Error('simulated agent failure'); };
  await assert.rejects(
    () => f.processor.process(groupPayload('group-presence-error', 'Bubu, error test')),
    /simulated agent failure/
  );
  assert.deepEqual(f.presenceEvents, [
    'seen:120363000000000000@g.us',
    'typing:120363000000000000@g.us',
    'stop:120363000000000000@g.us'
  ]);
});


test('presence endpoint failures do not prevent an eligible message from being processed', async () => {
  const f = fixture();
  f.processor.waha.sendSeen = async () => { throw new Error('sendSeen unavailable'); };
  f.processor.waha.startTyping = async () => { throw new Error('startTyping unavailable'); };
  f.processor.waha.stopTyping = async () => { throw new Error('stopTyping unavailable'); };

  await f.processor.process(groupPayload('group-presence-failures', 'Bubu, tetap proses pesan ini.'));
  assert.equal(f.agentCalls, 1);
  assert.equal(f.sent.length, 1);
});


test('DM media with a relative WAHA URL is normalized before media-kind detection', async () => {
  const f = fixture();
  await f.processor.process({
    event: 'message',
    payload: {
      id: 'dm-relative-media',
      from: '628111111111@c.us',
      author: '628111111111@c.us',
      body: '',
      hasMedia: true,
      media: { url: '/api/files/photo', mimetype: 'image/jpeg' }
    }
  });
  assert.equal(f.mediaCalls, 1);
  assert.equal(f.agentCalls, 1);
});

test('foreign-origin media URL is rejected before download or processing', async () => {
  const f = fixture();
  await assert.rejects(
    () => f.processor.process(groupPayload('group-foreign-media', 'Bubu inspect this', {
      hasMedia: true,
      media: {
        url: 'https://attacker.example/payload.jpg',
        filename: 'payload.jpg',
        mimetype: 'image/jpeg'
      }
    })),
    /host WAHA/
  );
  assert.equal(f.mediaCalls, 0);
  assert.equal(f.agentCalls, 0);
});
