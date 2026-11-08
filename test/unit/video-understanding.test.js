const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MediaIntelligenceService, formatTimestampSeconds } = require('../../src/p3/media/service');
const { ModelRouter } = require('../../src/agent/model-router');
const { AgentRuntime } = require('../../src/agent/runtime');
const { MessageProcessor } = require('../../src/agent/message-processor');

const MP4_BYTES = Buffer.from('0000ftypisom0000mdat-video-fixture');
const FRAME_1_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x46, 0x52, 0x41, 0x4d, 0x45, 0x31, 0xff, 0xd9]);
const FRAME_2_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x46, 0x52, 0x41, 0x4d, 0x45, 0x32, 0xff, 0xd9]);
const FRAME_3_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x46, 0x52, 0x41, 0x4d, 0x45, 0x33, 0xff, 0xd9]);
const OWNER = '628111111111@c.us';
const GROUP = '120363000000000000@g.us';

test('Task 2.7: formatTimestampSeconds formats frame timestamps deterministically', () => {
  assert.equal(formatTimestampSeconds(0), '00:00.0');
  assert.equal(formatTimestampSeconds(2.5), '00:02.5');
  assert.equal(formatTimestampSeconds(65), '01:05.0');
});

test('Task 2.7: silent video without text extracts timestamped visual frames, preserves sequence, and reconciles metadata vs ffprobe duration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-27-silent-video-'));
  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: dir,
    visionEnabled: true,
    maxVideoSeconds: 180,
    maxVideoFrames: 8,
    httpClient: {
      get: async () => ({
        status: 200,
        data: MP4_BYTES,
        headers: { 'content-type': 'video/mp4', 'content-length': String(MP4_BYTES.length) }
      })
    },
    commandRunner: async (cmd, args) => {
      if (cmd === 'ffprobe') return { stdout: '5.6\n', stderr: '' };
      if (cmd === 'ffmpeg' && args.some((a) => String(a).includes('frame-%02d.jpg'))) {
        const pattern = args[args.length - 1];
        const framesDir = path.dirname(pattern);
        fs.writeFileSync(path.join(framesDir, 'frame-01.jpg'), FRAME_1_JPEG);
        fs.writeFileSync(path.join(framesDir, 'frame-02.jpg'), FRAME_2_JPEG);
        fs.writeFileSync(path.join(framesDir, 'frame-03.jpg'), FRAME_3_JPEG);
        return { stdout: '', stderr: '' };
      }
      if (cmd === 'tesseract') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    }
  });

  try {
    const result = await service.processIncoming({
      media: {
        url: '/api/files/silent.mp4',
        filename: 'silent.mp4',
        mimetype: 'video/mp4',
        duration: 5
      }
    });

    assert.equal(result.kind, 'video');
    assert.equal(result.visualMode, 'visual_frames');
    assert.equal(result.partialOnly, false);
    assert.equal(result.temporalStatus, 'sampled_frames');
    assert.equal(result.durationSeconds, 5.6);
    assert.equal(result.declaredDurationSeconds, 5);
    assert.equal(result.noSpeech, true);
    assert.equal(result.frames.length, 3);
    assert.equal(result.visualImages.length, 3);
    assert.deepEqual(
      result.frames.map((f) => ({ index: f.index, timestampLabel: f.timestampLabel, hasVisual: f.hasVisual })),
      [
        { index: 1, timestampLabel: '00:00.0', hasVisual: true },
        { index: 2, timestampLabel: '00:01.0', hasVisual: true },
        { index: 3, timestampLabel: '00:02.0', hasVisual: true }
      ]
    );
    assert.equal(result.visualImages[0].label, 'Frame 1 (t=00:00.0)');
    assert.equal(result.visualImages[1].label, 'Frame 2 (t=00:01.0)');
    assert.equal(result.visualImages[2].label, 'Frame 3 (t=00:02.0)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Task 2.7: video with soundtrack combines timestamped visual frames and Task 2.5 VAD+Whisper audio transcript', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-27-soundtrack-'));
  const vadPath = path.join(dir, 'silero.bin');
  fs.writeFileSync(vadPath, 'vad-fixture');

  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: dir,
    visionEnabled: true,
    whisperModelPath: '/opt/whisper.cpp/models/ggml-base.bin',
    whisperVadModelPath: vadPath,
    httpClient: {
      get: async () => ({
        status: 200,
        data: MP4_BYTES,
        headers: { 'content-type': 'video/mp4', 'content-length': String(MP4_BYTES.length) }
      })
    },
    commandRunner: async (cmd, args) => {
      if (cmd === 'ffprobe') return { stdout: '6.0\n', stderr: '' };
      if (cmd === 'ffmpeg') {
        const out = args[args.length - 1];
        if (String(out).includes('frame-%02d.jpg')) {
          const framesDir = path.dirname(out);
          fs.writeFileSync(path.join(framesDir, 'frame-01.jpg'), FRAME_1_JPEG);
          fs.writeFileSync(path.join(framesDir, 'frame-02.jpg'), FRAME_2_JPEG);
        } else {
          fs.writeFileSync(out, 'RIFF-wav-fixture');
        }
        return { stdout: '', stderr: '' };
      }
      if (cmd === 'tesseract') return { stdout: 'SLIDE 1: AGENDA', stderr: '' };
      if (cmd === 'whisper-cli') return { stdout: '[00:00.000 --> 00:05.000] Selamat pagi, kita mulai demo produk sekarang.\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }
  });

  try {
    const result = await service.processIncoming({
      media: { url: '/api/files/demo.mp4', filename: 'demo.mp4', mimetype: 'video/mp4' }
    });

    assert.equal(result.visualMode, 'visual_frames');
    assert.equal(result.partialOnly, false);
    assert.equal(result.noSpeech, false);
    assert.equal(result.transcript, 'Selamat pagi, kita mulai demo produk sekarang.');
    assert.equal(result.visualImages.length, 2);
    assert.match(result.extractedText, /Selamat pagi, kita mulai demo produk sekarang/);
    assert.match(result.extractedText, /Frame 1 \[t=00:00\.0\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Task 2.7: too-short video (<2 frames or <1.5s) marks temporalStatus=insufficient_sample and states sequence limitation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-27-short-'));
  const filePath = path.join(dir, 'short.mp4');
  fs.writeFileSync(filePath, MP4_BYTES);

  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: dir,
    visionEnabled: true,
    commandRunner: async (cmd, args) => {
      if (cmd === 'ffprobe') return { stdout: '0.8\n', stderr: '' };
      if (cmd === 'ffmpeg' && String(args[args.length - 1]).includes('frame-%02d.jpg')) {
        const framesDir = path.dirname(args[args.length - 1]);
        fs.writeFileSync(path.join(framesDir, 'frame-01.jpg'), FRAME_1_JPEG);
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
  });

  try {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-27-short-work-'));
    try {
      const result = await service.processVideo({ filePath, filename: 'short.mp4' }, workDir);
      assert.equal(result.temporalStatus, 'insufficient_sample');
      assert.equal(result.frames.length, 1);
      assert.match(result.extractedText, /KETERBATASAN SAMPEL/);
      assert.match(result.promptText, /urutan perubahan keadaan visual tidak dapat dipastikan/);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Task 2.7: video exceeding maxVideoSeconds is rejected and cleans up downloaded and temporary files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-27-overlimit-'));
  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: dir,
    maxVideoSeconds: 60,
    httpClient: {
      get: async () => ({
        status: 200,
        data: MP4_BYTES,
        headers: { 'content-type': 'video/mp4', 'content-length': String(MP4_BYTES.length) }
      })
    },
    commandRunner: async (cmd) => {
      if (cmd === 'ffprobe') return { stdout: '125.4\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }
  });

  try {
    await assert.rejects(
      () => service.processIncoming({
        media: { url: '/api/files/long.mp4', filename: 'long.mp4', mimetype: 'video/mp4' }
      }),
      /Video berdurasi 126 detik\. Batas P3 adalah 60 detik/
    );
    assert.equal(service.videoBusy, false);
    const inboundDir = path.join(dir, 'inbound');
    if (fs.existsSync(inboundDir)) {
      const remaining = fs.readdirSync(inboundDir, { recursive: true })
        .filter((entry) => String(entry).endsWith('.mp4'));
      assert.deepEqual(remaining, []);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Task 2.7: OCR-and-transcript-only video processing is explicitly marked as partial_ocr_audio (partialOnly=true)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-27-partial-'));
  const filePath = path.join(dir, 'clip.mp4');
  fs.writeFileSync(filePath, MP4_BYTES);

  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: dir,
    visionEnabled: false,
    commandRunner: async (cmd, args) => {
      if (cmd === 'ffprobe') return { stdout: '4.0\n', stderr: '' };
      if (cmd === 'ffmpeg' && String(args[args.length - 1]).includes('frame-%02d.jpg')) {
        const framesDir = path.dirname(args[args.length - 1]);
        fs.writeFileSync(path.join(framesDir, 'frame-01.jpg'), FRAME_1_JPEG);
        fs.writeFileSync(path.join(framesDir, 'frame-02.jpg'), FRAME_2_JPEG);
        return { stdout: '', stderr: '' };
      }
      if (cmd === 'tesseract') return { stdout: 'TEKS FRAME', stderr: '' };
      return { stdout: '', stderr: '' };
    }
  });

  try {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-27-partial-work-'));
    try {
      const result = await service.processVideo({ filePath, filename: 'clip.mp4' }, workDir);
      assert.equal(result.visualMode, 'partial_ocr_audio');
      assert.equal(result.partialOnly, true);
      assert.deepEqual(result.visualImages, []);
      assert.match(result.extractedText, /MODE PARSIAL/);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Task 2.7: DM and group end-to-end video understanding links timestamps, frames, and state-change sequence', async () => {
  const f1Url = `data:image/jpeg;base64,${FRAME_1_JPEG.toString('base64')}`;
  const f2Url = `data:image/jpeg;base64,${FRAME_2_JPEG.toString('base64')}`;
  const f3Url = `data:image/jpeg;base64,${FRAME_3_JPEG.toString('base64')}`;

  function makeVideoHarness({ reverseSequence = false } = {}) {
    const sent = [];
    const providerRequests = [];
    const orderedFrames = reverseSequence
      ? [
          { label: 'Frame 1 (t=00:00.0)', index: 1, frameIndex: 1, timestampSeconds: 0, timestampLabel: '00:00.0', mimeType: 'image/jpeg', byteLength: FRAME_3_JPEG.length, dataUrl: f3Url },
          { label: 'Frame 2 (t=00:01.0)', index: 2, frameIndex: 2, timestampSeconds: 1, timestampLabel: '00:01.0', mimeType: 'image/jpeg', byteLength: FRAME_2_JPEG.length, dataUrl: f2Url },
          { label: 'Frame 3 (t=00:02.0)', index: 3, frameIndex: 3, timestampSeconds: 2, timestampLabel: '00:02.0', mimeType: 'image/jpeg', byteLength: FRAME_1_JPEG.length, dataUrl: f1Url }
        ]
      : [
          { label: 'Frame 1 (t=00:00.0)', index: 1, frameIndex: 1, timestampSeconds: 0, timestampLabel: '00:00.0', mimeType: 'image/jpeg', byteLength: FRAME_1_JPEG.length, dataUrl: f1Url },
          { label: 'Frame 2 (t=00:01.0)', index: 2, frameIndex: 2, timestampSeconds: 1, timestampLabel: '00:01.0', mimeType: 'image/jpeg', byteLength: FRAME_2_JPEG.length, dataUrl: f2Url },
          { label: 'Frame 3 (t=00:02.0)', index: 3, frameIndex: 3, timestampSeconds: 2, timestampLabel: '00:02.0', mimeType: 'image/jpeg', byteLength: FRAME_3_JPEG.length, dataUrl: f3Url }
        ];

    const db = {
      task: null,
      consumeRateLimit: () => ({ allowed: true }),
      getHistory: () => [],
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
        providerRequests.push({ model, messages });
        const evidenceMsg = messages.find((m) => Array.isArray(m.content));
        const urls = evidenceMsg.content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url);
        const answer = urls[0] === f1Url
          ? 'Urutan kejadian: Frame 1 [t=00:00.0] gelas kosong, Frame 2 [t=00:01.0] air dituangkan, Frame 3 [t=00:02.0] gelas penuh.'
          : 'Urutan kejadian: Frame 1 [t=00:00.0] gelas penuh, Frame 2 [t=00:01.0] air diminum, Frame 3 [t=00:02.0] gelas kosong.';
        return {
          message: { role: 'assistant', content: answer },
          model,
          finishReason: 'stop',
          usage: { prompt_tokens: 800, completion_tokens: 35 }
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
        kind: 'video',
        filename: 'sequence.mp4',
        visualMode: 'visual_frames',
        partialOnly: false,
        temporalStatus: 'sampled_frames',
        durationSeconds: 3.0,
        samplingIntervalSeconds: 1,
        frames: [
          { index: 1, timestampSeconds: 0, timestampLabel: '00:00.0', ocrText: '', hasVisual: true },
          { index: 2, timestampSeconds: 1, timestampLabel: '00:01.0', ocrText: '', hasVisual: true },
          { index: 3, timestampSeconds: 2, timestampLabel: '00:02.0', ocrText: '', hasVisual: true }
        ],
        visualImages: orderedFrames,
        transcript: '',
        extractedText: 'Durasi video: 3 detik'
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

  const dmForward = makeVideoHarness({ reverseSequence: false });
  await dmForward.processor.process({
    event: 'message',
    payload: {
      id: 'dm-video-forward',
      from: OWNER,
      author: OWNER,
      body: 'Jelaskan urutan kejadian di video ini.',
      hasMedia: true,
      media: { url: 'http://waha:3000/api/files/seq1.mp4', filename: 'seq1.mp4', mimetype: 'video/mp4' }
    }
  });

  const groupReverse = makeVideoHarness({ reverseSequence: true });
  await groupReverse.processor.process({
    event: 'message',
    payload: {
      id: 'group-video-reverse',
      from: GROUP,
      author: '628222222222@c.us',
      body: 'Bubu, jelaskan urutan kejadian di video ini.',
      hasMedia: true,
      media: { url: 'http://waha:3000/api/files/seq2.mp4', filename: 'seq2.mp4', mimetype: 'video/mp4' }
    }
  });

  assert.equal(dmForward.providerRequests[0].model, 'claude-sonnet-5-5');
  assert.equal(groupReverse.providerRequests[0].model, 'claude-sonnet-5-5');
  assert.match(dmForward.sent[0].text, /Frame 1 \[t=00:00\.0\] gelas kosong.*Frame 3 \[t=00:02\.0\] gelas penuh/);
  assert.match(groupReverse.sent[0].text, /Frame 1 \[t=00:00\.0\] gelas penuh.*Frame 3 \[t=00:02\.0\] gelas kosong/);
  assert.equal(groupReverse.sent[0].chatId, GROUP);
});
