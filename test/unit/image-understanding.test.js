const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MediaIntelligenceService } = require('../../src/p3/media/service');
const { SumopodProvider, validateImageDataUrl, sanitizeMessagesForProvider } = require('../../src/providers/sumopod');
const { ModelRouter } = require('../../src/agent/model-router');
const { AgentRuntime } = require('../../src/agent/runtime');
const { MessageProcessor } = require('../../src/agent/message-processor');

const APPLE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x41, 0x50, 0x50, 0x4c, 0x45, 0xff, 0xd9]);
const BANANA_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x42, 0x41, 0x4e, 0x41, 0x4e, 0x41, 0xff, 0xd9]);
const OWNER = '628111111111@c.us';
const GROUP = '120363000000000000@g.us';

test('Task 2.6: ModelRouter selects verified candidate visual model (claude-sonnet-5-5) when needsVision is true', () => {
  const router = new ModelRouter({
    fast: { id: 'claude-haiku-5-5', supportsTools: true },
    balanced: { id: 'claude-sonnet-5-5', supportsTools: true, supportsVision: true },
    reasoning: { id: 'claude-opus-5-5', supportsTools: true },
    summary: { id: 'gemini/gemini-3.1-pro-preview', supportsTools: true },
    vision: { id: 'claude-sonnet-5-5', supportsTools: true, supportsVision: true }
  });

  // Even if the user caption is a short question ('simple_question' -> fast) or 'summarize',
  // visual turns must route to the verified visual model.
  assert.equal(router.select('simple_question', { needsTools: true, needsVision: true }).model, 'claude-sonnet-5-5');
  assert.equal(router.select('summarize', { needsTools: true, needsVision: true }).model, 'claude-sonnet-5-5');
});

test('Task 2.6: SumopodProvider permits sanitized base64 image data URLs and rejects private/remote WAHA URLs or credentials', () => {
  const validDataUrl = `data:image/jpeg;base64,${APPLE_JPEG.toString('base64')}`;
  assert.equal(validateImageDataUrl(validDataUrl, 1024), validDataUrl);

  assert.throws(
    () => validateImageDataUrl('http://127.0.0.1:3000/api/files/secret.jpg'),
    /Private or remote URLs are forbidden/
  );
  assert.throws(
    () => validateImageDataUrl('https://waha.internal/api/files/secret.jpg'),
    /Private or remote URLs are forbidden/
  );
  assert.throws(
    () => validateImageDataUrl('/api/files/secret.jpg'),
    /Private or remote URLs are forbidden/
  );
  assert.throws(
    () => validateImageDataUrl('http://user:token@127.0.0.1:3000/file.jpg'),
    /Private or remote URLs are forbidden/
  );
  assert.throws(
    () => validateImageDataUrl(validDataUrl, 4),
    /exceeds limit/
  );

  const sanitized = sanitizeMessagesForProvider([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Inspect image' },
        { type: 'image_url', image_url: { url: validDataUrl } }
      ]
    }
  ]);
  assert.equal(sanitized[0].content[1].image_url.url, validDataUrl);
});

test('Task 2.6: MediaIntelligenceService normalizes image, enforces dimension/byte bounds, and cleans up temp files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-26-img-'));
  const ffmpegCalls = [];
  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000', apiKey: 'secret-waha-key' },
    storageDir: dir,
    visionEnabled: true,
    maxVisionBytes: 4096,
    maxVisionDimension: 1280,
    httpClient: {
      get: async () => ({
        status: 200,
        data: APPLE_JPEG,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(APPLE_JPEG.length) }
      })
    },
    commandRunner: async (cmd, args) => {
      if (cmd === 'ffmpeg') {
        ffmpegCalls.push(args);
        fs.writeFileSync(args[args.length - 1], APPLE_JPEG);
        return { stdout: '', stderr: '' };
      }
      if (cmd === 'tesseract') {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
  });

  try {
    const result = await service.processIncoming({
      media: {
        url: '/api/files/apple.jpg',
        filename: 'apple.jpg',
        mimetype: 'image/jpeg'
      }
    });

    assert.equal(result.kind, 'image');
    assert.equal(result.visualMode, 'sumopod_vision');
    assert.equal(result.visualImages.length, 1);
    assert.equal(result.visualImages[0].mimeType, 'image/jpeg');
    assert.equal(result.visualImages[0].dataUrl, `data:image/jpeg;base64,${APPLE_JPEG.toString('base64')}`);
    assert.equal(JSON.stringify(result).includes('secret-waha-key'), false);
    assert.equal(JSON.stringify(result).includes('/api/files/apple.jpg'), false);
    assert.equal(ffmpegCalls.length, 1);
    assert.equal(ffmpegCalls[0].some((arg) => String(arg).includes('1280')), true);

    // Inbound file must be deleted after processIncoming completes
    const inboundDir = path.join(dir, 'inbound');
    if (fs.existsSync(inboundDir)) {
      const remainingFiles = fs.readdirSync(inboundDir, { recursive: true })
        .filter((entry) => String(entry).endsWith('.jpg'));
      assert.deepEqual(remainingFiles, []);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Task 2.6: MediaIntelligenceService falls back to labeled OCR when vision is disabled or exceeds size bound', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-26-ocr-fallback-'));
  const filePath = path.join(dir, 'screenshot.jpg');
  fs.writeFileSync(filePath, APPLE_JPEG);

  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: dir,
    visionEnabled: true,
    maxVisionBytes: 8, // smaller than APPLE_JPEG to force size-limit fallback
    commandRunner: async (cmd, args) => {
      if (cmd === 'ffmpeg') {
        fs.writeFileSync(args[args.length - 1], APPLE_JPEG);
        return { stdout: '', stderr: '' };
      }
      if (cmd === 'tesseract') {
        return { stdout: 'TOTAL PEMBAYARAN Rp 150.000', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
  });

  try {
    const result = await service.processImage({ filePath, filename: 'screenshot.jpg' });
    assert.equal(result.visualMode, 'ocr_fallback');
    assert.equal(result.visualFallbackReason, 'exceeds_vision_bytes');
    assert.deepEqual(result.visualImages, []);
    assert.equal(result.extractedText, 'TOTAL PEMBAYARAN Rp 150.000');
    assert.match(result.promptText, /\[OCR_FALLBACK: exceeds_vision_bytes\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Task 2.6: DM and group image understanding changes answer when photo content changes, supports screenshots + captions, and falls back to OCR on provider vision error', async () => {
  const appleDataUrl = `data:image/jpeg;base64,${APPLE_JPEG.toString('base64')}`;
  const bananaDataUrl = `data:image/jpeg;base64,${BANANA_JPEG.toString('base64')}`;

  function createEndToEndHarness({ currentBuffer = APPLE_JPEG, ocrText = '', rejectVisionOnProvider = false } = {}) {
    const sent = [];
    const providerRequests = [];
    const db = {
      task: null,
      consumeRateLimit: () => ({ allowed: true }),
      getHistory: () => [{ role: 'user', content: 'Konteks percakapan sebelumnya di chat ini.' }],
      addMessage: () => {},
      searchMemories: () => [],
      getChatOutputMode: () => 'text',
      createTask: (t) => { db.task = { ...t, status: 'running' }; return db.task; },
      getTask: () => null,
      getPendingApprovalForTask: () => null,
      getPendingApprovalsForChat: () => [],
      countTaskSteps: () => 0,
      logModelUsage: () => {},
      updateTask: (_id, f) => { db.task = { ...db.task, ...f }; },
      queueTaskResponse: (_id, text) => { db.queued = text; },
      claimTaskResponse: () => db.queued,
      finishTaskResponse: () => {},
      audit: () => {}
    };
    const router = new ModelRouter({
      fast: { id: 'claude-haiku-5-5', supportsTools: true },
      balanced: { id: 'claude-sonnet-5-5', supportsTools: true, supportsVision: true },
      vision: { id: 'claude-sonnet-5-5', supportsTools: true, supportsVision: true }
    });
    const provider = {
      chat: async ({ model, messages }) => {
        providerRequests.push({ model, messages: JSON.parse(JSON.stringify(messages)) });
        const evidenceMsg = messages.find((m) =>
          m.role === 'user' && (
            Array.isArray(m.content) ||
            (typeof m.content === 'string' && m.content.startsWith('[UNTRUSTED_ATTACHMENT_EVIDENCE]'))
          )
        );
        if (rejectVisionOnProvider && Array.isArray(evidenceMsg?.content)) {
          const err = new Error('Provider rejected image_url content');
          err.response = { status: 400 };
          throw err;
        }
        if (Array.isArray(evidenceMsg?.content)) {
          const imgPart = evidenceMsg.content.find((p) => p.type === 'image_url');
          if (imgPart?.image_url?.url === appleDataUrl) {
            return {
              message: { role: 'assistant', content: 'Objek utama pada foto adalah apel merah di sebelah kiri cangkir.' },
              model,
              finishReason: 'stop',
              usage: { prompt_tokens: 430, completion_tokens: 18 }
            };
          }
          if (imgPart?.image_url?.url === bananaDataUrl) {
            return {
              message: { role: 'assistant', content: 'Objek utama pada foto adalah sesisir pisang kuning di atas meja.' },
              model,
              finishReason: 'stop',
              usage: { prompt_tokens: 430, completion_tokens: 21 }
            };
          }
        }
        return {
          message: { role: 'assistant', content: `[Hasil dari OCR Fallback]: ${ocrText}` },
          model,
          finishReason: 'stop',
          usage: { prompt_tokens: 120, completion_tokens: 15 }
        };
      }
    };
    const config = {
      ownerJid: OWNER,
      botJid: '628999999999@c.us',
      waha: { baseUrl: 'http://waha:3000' },
      groupPolicy: 'all',
      groupRequireMention: true,
      groupMediaRequireMention: false,
      agent: { enabled: true, maxRounds: 2, maxToolCalls: 2, maxToolResultChars: 2000, maxOutputTokens: 2048, taskTimeoutMs: 5000, toolTimeoutMs: 1000, messageRateLimit: 20, messageRateWindowMs: 60000 },
      media: { enabled: true, visionEnabled: true, voiceReplyDefault: false },
      documents: { maxExtractChars: 10000 }
    };
    const agent = new AgentRuntime({
      provider,
      router,
      tools: { definitions: () => [] },
      db,
      config,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
    });
    const mediaService = {
      processIncoming: async () => ({
        kind: 'image',
        filename: 'photo.jpg',
        visualMode: 'sumopod_vision',
        visualImages: [{
          label: 'image-1',
          index: 1,
          mimeType: 'image/jpeg',
          byteLength: currentBuffer.length,
          dataUrl: `data:image/jpeg;base64,${currentBuffer.toString('base64')}`
        }],
        ocrText,
        extractedText: ocrText
      })
    };
    const processor = new MessageProcessor({
      config,
      db,
      waha: { sendSeen: async () => {}, startTyping: async () => {}, stopTyping: async () => {}, resolveLid: async (v) => v },
      responseHandler: {
        sendAssistantResponse: async (text, chatId) => sent.push({ text, chatId }),
        sendText: async (text, chatId) => sent.push({ text, chatId })
      },
      agent,
      approvalManager: {},
      provider,
      router,
      documentService: {},
      memoryService: null,
      mediaService,
      logger: { warn: () => {}, error: () => {} }
    });
    return { processor, sent, providerRequests };
  }

  // 1. DM: two different photos without text produce different visual answers for the same question
  const dmApple = createEndToEndHarness({ currentBuffer: APPLE_JPEG });
  await dmApple.processor.process({
    event: 'message',
    payload: {
      id: 'dm-apple',
      from: OWNER,
      author: OWNER,
      body: 'Objek apa yang ada di foto ini?',
      hasMedia: true,
      media: { url: 'http://waha:3000/api/files/apple.jpg', filename: 'apple.jpg', mimetype: 'image/jpeg' }
    }
  });

  const dmBanana = createEndToEndHarness({ currentBuffer: BANANA_JPEG });
  await dmBanana.processor.process({
    event: 'message',
    payload: {
      id: 'dm-banana',
      from: OWNER,
      author: OWNER,
      body: 'Objek apa yang ada di foto ini?',
      hasMedia: true,
      media: { url: 'http://waha:3000/api/files/banana.jpg', filename: 'banana.jpg', mimetype: 'image/jpeg' }
    }
  });

  assert.equal(dmApple.providerRequests[0].model, 'claude-sonnet-5-5');
  assert.equal(dmBanana.providerRequests[0].model, 'claude-sonnet-5-5');
  assert.match(dmApple.sent[0].text, /apel merah/);
  assert.match(dmBanana.sent[0].text, /pisang kuning/);
  assert.notEqual(dmApple.sent[0].text, dmBanana.sent[0].text);

  // 2. Group: screenshot with text + caption question mentioning Bubu
  const groupScreenshot = createEndToEndHarness({
    currentBuffer: APPLE_JPEG,
    ocrText: 'ERROR 502 Bad Gateway nginx/1.24.0'
  });
  await groupScreenshot.processor.process({
    event: 'message',
    payload: {
      id: 'group-screenshot',
      from: GROUP,
      author: '628222222222@c.us',
      body: 'Bubu, apa arti pesan error pada screenshot ini?',
      hasMedia: true,
      _data: {
        Info: { Chat: GROUP, IsGroup: true, MediaType: 'image', IsFromMe: false },
        Message: {
          imageMessage: {
            URL: 'http://waha:3000/api/files/screen.jpg',
            caption: 'Screenshot dashboard produksi',
            mimetype: 'image/jpeg'
          }
        }
      }
    }
  });
  assert.equal(groupScreenshot.sent.length, 1);
  assert.equal(groupScreenshot.sent[0].chatId, GROUP);
  const groupMessages = groupScreenshot.providerRequests[0].messages;
  assert.equal(groupMessages.some((m) => typeof m.content === 'string' && m.content.includes('CURRENT_MESSAGE_CAPTION')), true);
  const groupEvidence = groupMessages.find((m) => Array.isArray(m.content));
  assert.equal(Array.isArray(groupEvidence.content), true);
  assert.match(groupEvidence.content[0].text, /ERROR 502 Bad Gateway/);
  assert.equal(groupEvidence.content[1].type, 'image_url');

  // 3. Automatic OCR fallback if provider rejects multimodal input
  const fallbackHarness = createEndToEndHarness({
    currentBuffer: APPLE_JPEG,
    ocrText: 'FAKTUR PAJAK #9981',
    rejectVisionOnProvider: true
  });
  await fallbackHarness.processor.process({
    event: 'message',
    payload: {
      id: 'dm-vision-fallback',
      from: OWNER,
      author: OWNER,
      body: 'Baca nomor faktur di gambar ini.',
      hasMedia: true,
      media: { url: 'http://waha:3000/api/files/invoice.jpg', filename: 'invoice.jpg', mimetype: 'image/jpeg' }
    }
  });
  assert.equal(fallbackHarness.providerRequests.length, 2);
  assert.match(fallbackHarness.sent[0].text, /FAKTUR PAJAK #9981/);
});
