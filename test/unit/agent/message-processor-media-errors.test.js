const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageProcessor } = require('../../../src/agent/message-processor');
const { ResponseHandler } = require('../../../src/channels/response-handler');
const { InboxWorker } = require('../../../src/workers/inbox-worker');

const OWNER = '628111111111@c.us';

function fixture({
  mode = 'text',
  mediaEnabled = true,
  mediaService = { processIncoming: async () => ({ kind: 'image', filename: 'image.jpg', promptText: 'image text' }) },
  responseHandler = null,
  media = { url: 'http://waha:3000/api/files/image.jpg', filename: 'image.jpg', mimetype: 'image/jpeg' },
  hasMedia = true
} = {}) {
  const notices = [];
  const warnings = [];
  const presence = [];
  const db = {
    consumeRateLimit: () => ({ allowed: true }),
    getChatOutputMode: ({ chatId, requesterId, defaultMode }) => {
      assert.equal(chatId, OWNER);
      assert.equal(requesterId, OWNER);
      return mode || defaultMode;
    },
    getHistory: () => [],
    addMessage: () => {},
    searchMemories: () => [],
    claimTaskResponse: () => 'not expected',
    finishTaskResponse: () => {}
  };
  const waha = {
    sendSeen: async () => presence.push('seen'),
    startTyping: async () => presence.push('typing'),
    stopTyping: async () => presence.push('stop'),
    sendText: async (text, chatId) => notices.push({ type: 'text', text, chatId }),
    sendVoice: async (_buffer, chatId) => notices.push({ type: 'voice', chatId })
  };
  const handler = responseHandler || {
    sendAssistantResponse: async (text, chatId, outputMode) => {
      notices.push({ type: 'assistant', text, chatId, mode: outputMode });
    }
  };
  const logger = {
    warn: (details, message) => warnings.push({ details, message }),
    error: () => {}
  };
  const config = {
    ownerJid: OWNER,
    waha: { baseUrl: 'http://waha:3000' },
    groupPolicy: 'all',
    groupRequireMention: true,
    groupMediaRequireMention: false,
    agent: { enabled: true, messageRateLimit: 10, messageRateWindowMs: 60000 },
    media: { enabled: mediaEnabled, voiceReplyDefault: false, piperModelPath: '' },
    documents: { maxExtractChars: 50000 }
  };
  const processor = new MessageProcessor({
    config,
    db,
    waha,
    responseHandler: handler,
    mediaService,
    agent: { run: async () => assert.fail('agent should not run in this fixture') },
    approvalManager: {},
    provider: {},
    router: {},
    documentService: { ingestMedia: async () => assert.fail('document service should not run') },
    memoryService: null,
    logger
  });

  let eventSequence = 0;
  const payload = {
    event: 'message',
    payload: {
      id: `media-test-${++eventSequence}`,
      from: OWNER,
      author: OWNER,
      body: '',
      hasMedia,
      ...(media === undefined ? {} : { media })
    }
  };

  return { processor, notices, warnings, presence, payload, waha, db };
}

for (const mode of ['text', 'voice', 'both']) {
  test(`missing media URL notice respects ${mode} output mode`, async () => {
    const f = fixture({ mode, media: { mimetype: 'image/jpeg' } });
    await f.processor.process(f.payload);
    assert.equal(f.notices.length, 1);
    assert.equal(f.notices[0].type, 'assistant');
    assert.equal(f.notices[0].mode, mode);
    assert.match(f.notices[0].text, /media\.url/);
    assert.deepEqual(f.presence, ['seen', 'typing', 'stop']);
  });

  test(`unsupported media notice respects ${mode} output mode`, async () => {
    const f = fixture({
      mode,
      media: {
        url: 'http://waha:3000/api/files/unknown.bin',
        filename: 'unknown.bin',
        mimetype: 'application/octet-stream'
      }
    });
    await f.processor.process(f.payload);
    assert.equal(f.notices.length, 1);
    assert.equal(f.notices[0].mode, mode);
    assert.match(f.notices[0].text, /Format media belum didukung/);
  });

  test(`disabled media notice respects ${mode} output mode`, async () => {
    const f = fixture({ mode, mediaEnabled: false });
    await f.processor.process(f.payload);
    assert.equal(f.notices.length, 1);
    assert.equal(f.notices[0].mode, mode);
    assert.match(f.notices[0].text, /dinonaktifkan/);
  });
}

test('media processing error is rethrown unchanged for InboxWorker classification and retry policy', async () => {
  const original = Object.assign(new Error('Model request timed out'), { code: 'ETIMEDOUT' });
  const f = fixture({
    mediaService: { processIncoming: async () => { throw original; } }
  });

  await assert.rejects(
    () => f.processor.process(f.payload),
    error => error === original
  );

  assert.equal(f.notices.length, 0);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.warnings[0].message, 'P3 media processing failed');
  assert.deepEqual(f.presence, ['seen', 'typing', 'stop']);
});

test('media processing 403 is rethrown unchanged for terminal InboxWorker handling', async () => {
  const original = Object.assign(new Error('Forbidden'), { response: { status: 403 } });
  const f = fixture({
    mediaService: { processIncoming: async () => { throw original; } }
  });

  await assert.rejects(
    () => f.processor.process(f.payload),
    error => error === original
  );
  assert.equal(f.notices.length, 0);
});

test('voice-only media validation notice never falls back to text when TTS is unavailable', async () => {
  const calls = [];
  const responseHandler = new ResponseHandler({
    waha: {
      sendText: async (...args) => calls.push({ type: 'text', args }),
      sendVoice: async (...args) => calls.push({ type: 'voice', args })
    },
    mediaService: { createVoiceReply: async () => { throw new Error('Piper unavailable'); } },
    config: { media: { enabled: true, piperModelPath: '/missing/model.onnx' } }
  });
  const f = fixture({
    mode: 'voice',
    responseHandler,
    media: { url: 'http://waha:3000/api/files/unknown.bin', filename: 'unknown.bin', mimetype: 'application/octet-stream' }
  });

  await f.processor.process(f.payload);
  assert.deepEqual(calls, []);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0].message, /Unable to deliver media notice/);
});


test('MessageProcessor transient media error reaches InboxWorker bounded retry policy', async () => {
  const original = Object.assign(new Error('Model request timed out'), { code: 'ETIMEDOUT' });
  const f = fixture({
    mediaService: { processIncoming: async () => { throw original; } }
  });
  let failure = null;
  f.db.claimNextEvent = () => ({
    event_id: 'integrated-timeout-1',
    chat_id: OWNER,
    payload: f.payload,
    attempts: 1
  });
  f.db.failEvent = (...args) => { failure = args; };
  f.db.finishEvent = () => assert.fail('transient media error must not complete');

  const worker = new InboxWorker({
    db: f.db,
    handler: payload => f.processor.process(payload),
    logger: { warn: () => {}, error: () => {} },
    maxAttempts: 5
  });

  await worker.tick();
  assert.deepEqual(failure, [
    'integrated-timeout-1',
    'timeout: Model request timed out',
    1,
    5
  ]);
  assert.equal(f.notices.length, 0);
  await worker.stop();
});

test('MessageProcessor permanent media 403 reaches InboxWorker dead-letter notification', async () => {
  const original = Object.assign(new Error('Forbidden'), { response: { status: 403 } });
  const f = fixture({
    mediaService: { processIncoming: async () => { throw original; } }
  });
  let failure = null;
  let notice = null;
  f.db.claimNextEvent = () => ({
    event_id: 'integrated-403-1',
    chat_id: OWNER,
    payload: f.payload,
    attempts: 1
  });
  f.db.failEvent = (...args) => { failure = args; };
  f.db.finishEvent = () => assert.fail('permanent media error must not complete');

  const worker = new InboxWorker({
    db: f.db,
    handler: payload => f.processor.process(payload),
    onDeadLetter: async value => { notice = value; },
    logger: { warn: () => {}, error: () => {} },
    maxAttempts: 5
  });

  await worker.tick();
  assert.equal(failure[0], 'integrated-403-1');
  assert.equal(failure[1], 'authentication: Forbidden');
  assert.equal(failure[2], 5);
  assert.equal(notice.category, 'authentication');
  assert.match(notice.message, /autentikasi/);
  assert.equal(f.notices.length, 0);
  await worker.stop();
});

test('Stage 1: UserValidationError from MediaIntelligenceService / DocumentService fails immediately on attempt 1 with real message', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { MediaIntelligenceService } = require('../../../src/media/media-service');
  const { DocumentService } = require('../../../src/documents/document-service');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-stage1-userval-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const mp4 = Buffer.from('0000ftypisom0000mdat-video');
  const mediaService = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://waha:3000' },
    storageDir: dir,
    maxVideoSeconds: 60,
    httpClient: {
      get: async () => ({
        status: 200,
        data: mp4,
        headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) }
      })
    },
    commandRunner: async (cmd) => (cmd === 'ffprobe' ? { stdout: '125\n', stderr: '' } : { stdout: '', stderr: '' })
  });
  const documentService = new DocumentService({
    db: {},
    wahaConfig: { baseUrl: 'http://waha:3000' },
    storageDir: dir
  });

  const f = fixture({ mediaService });
  f.processor.documentService = documentService;

  const events = [
    {
      event_id: 'evt-over-video',
      chat_id: OWNER,
      payload: {
        event: 'message',
        payload: {
          id: 'vid-1',
          from: OWNER,
          author: OWNER,
          hasMedia: true,
          media: { url: 'http://waha:3000/api/files/long.mp4', filename: 'long.mp4', mimetype: 'video/mp4' }
        }
      },
      attempts: 1
    },
    {
      event_id: 'evt-bad-pdf',
      chat_id: OWNER,
      payload: {
        event: 'message',
        payload: {
          id: 'doc-1',
          from: OWNER,
          author: OWNER,
          hasMedia: true,
          media: { url: 'http://waha:3000/api/files/bad.exe', filename: 'bad.exe', mimetype: 'application/x-msdownload' }
        }
      },
      attempts: 1
    }
  ];

  // For bad.exe, detectMediaKind returns 'unsupported' handled directly by MessageProcessor;
  // test DocumentService validation via .pdf with invalid signature.
  documentService.httpClient = {
    get: async () => ({
      status: 200,
      data: Buffer.from('NOT-A-PDF'),
      headers: { 'content-type': 'application/pdf', 'content-length': '9' }
    })
  };
  events[1].payload.payload.media = {
    url: 'http://waha:3000/api/files/fake.pdf',
    filename: 'fake.pdf',
    mimetype: 'application/pdf'
  };

  const failures = [];
  const deadLetters = [];
  f.db.claimNextEvent = () => events.shift() || null;
  f.db.failEvent = (...args) => failures.push(args);
  f.db.finishEvent = () => assert.fail('validation error must not complete');

  const worker = new InboxWorker({
    db: f.db,
    handler: (payload, meta) => f.processor.process(payload, meta),
    onDeadLetter: async (info) => deadLetters.push(info),
    logger: { warn: () => {}, error: () => {} },
    maxAttempts: 5
  });

  await worker.tick();
  await worker.tick();
  await worker.stop();

  assert.equal(failures[0][2], 5);
  assert.equal(deadLetters[0].category, 'validation');
  assert.match(deadLetters[0].message, /Video berdurasi 125 detik\. Batas P3 adalah 60 detik/);

  assert.equal(failures[1][2], 5);
  assert.equal(deadLetters[1].category, 'validation');
  assert.match(deadLetters[1].message, /signature PDF yang valid/);
});
