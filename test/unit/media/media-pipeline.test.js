const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MediaIntelligenceService, detectMediaKind, extensionFromMime, resolveMediaExtension, validateMediaSignature, runCommand } = require('../../../src/media/media-service');

test('detects image, audio, video and documents using MIME precedence', () => {
  assert.equal(detectMediaKind('attachment.bin','image/jpeg'),'image');
  assert.equal(detectMediaKind('voice.ogg','audio/ogg'),'audio');
  assert.equal(detectMediaKind('clip.webm','video/webm'),'video');
  assert.equal(detectMediaKind('scan.pdf','application/pdf'),'document');
  assert.equal(detectMediaKind('script.exe','application/octet-stream'),'unsupported');
});

test('runCommand captures stdout and supports stdin', async () => {
  const result = await runCommand(process.execPath,['-e','process.stdin.pipe(process.stdout)'],{input:'bubu-test'});
  assert.equal(result.stdout,'bubu-test');
});

test('runCommand rejects missing command', async () => {
  await assert.rejects(
    () => runCommand('bubu-command-that-does-not-exist-xyz',[]),
    /unavailable/
  );
});


test('media signature validation rejects a mislabeled executable payload', () => {
  assert.equal(validateMediaSignature(Buffer.from([0xff,0xd8,0xff,0x00]),'.jpg','image'),true);
  assert.equal(validateMediaSignature(Buffer.from('MZ executable payload'),'.jpg','image'),false);
  assert.equal(validateMediaSignature(Buffer.from('OggS1234567890123456'),'.ogg','audio'),true);
});


test('maps missing filename extensions from MIME types', () => {
  assert.equal(extensionFromMime('image/png','image'),'.png');
  assert.equal(extensionFromMime('audio/ogg; codecs=opus','audio'),'.ogg');
  assert.equal(extensionFromMime('audio/webm','audio'),'.webm');
  assert.equal(extensionFromMime('video/mp4','video'),'.mp4');
});


test('resolves missing and generic filenames from parameterized MIME types', () => {
  assert.equal(resolveMediaExtension('upload.bin', 'image/jpeg; charset=binary', 'image'), '.jpg');
  assert.equal(resolveMediaExtension('', 'audio/ogg; codecs=opus', 'audio'), '.ogg');
  assert.equal(resolveMediaExtension('clip.webm', 'video/webm', 'video'), '.webm');
  assert.equal(resolveMediaExtension('sound.webm', 'audio/webm', 'audio'), '.webm');
});

test('rejects extension and MIME mismatches', () => {
  assert.throws(() => resolveMediaExtension('photo.jpg', 'image/png', 'image'), /MIME type/);
  assert.throws(() => resolveMediaExtension('payload.exe', 'image/jpeg', 'image'), /Ekstensi/);
  assert.throws(() => resolveMediaExtension('clip.mp4', 'image/jpeg', 'image'), /MIME type|kategori/);
});

test('uses strict signatures for AMR, M4A, AAC, and WebM audio', () => {
  assert.equal(validateMediaSignature(Buffer.from('#!AMR\nrest'), '.amr', 'audio'), true);
  assert.equal(validateMediaSignature(Buffer.from('0000ftypM4A rest'), '.m4a', 'audio'), true);
  assert.equal(validateMediaSignature(Buffer.from([0xff, 0xf1, 0x50, 0x80]), '.aac', 'audio'), true);
  assert.equal(validateMediaSignature(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), '.webm', 'audio'), true);
  assert.equal(validateMediaSignature(Buffer.from('just long enough bytes'), '.m4a', 'audio'), false);
});

test('downloads relative WAHA media URLs with redirects disabled and MIME parameters normalized', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-p3-download-'));
  let requestedUrl;
  let requestOptions;
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000', apiKey: 'test-only' },
    storageDir: dir,
    maxFileBytes: 1024,
    httpClient: {
      get: async (url, options) => {
        requestedUrl = url;
        requestOptions = options;
        return {
          status: 200,
          data: bytes,
          headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.length) }
        };
      }
    }
  });

  try {
    const result = await service.download({
      url: '/api/files/image',
      filename: 'photo',
      mimetype: 'image/jpeg; charset=binary'
    });

    assert.equal(requestedUrl, 'http://127.0.0.1:3000/api/files/image');
    assert.equal(requestOptions.maxRedirects, 0);
    assert.equal(result.ext, '.jpg');
    assert.equal(result.filename, 'photo.jpg');
    assert.equal(fs.existsSync(result.filePath), true);
    await fs.promises.rm(result.filePath, { force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects redirects, oversized content-length, response MIME mismatch, and bad signatures without storing files', async () => {
  const scenarios = [
    {
      name: 'redirect',
      response: { status: 302, data: Buffer.from([0xff,0xd8,0xff]), headers: { location: 'https://attacker.example/x' } },
      error: /HTTP 302/
    },
    {
      name: 'oversize',
      response: { status: 200, data: Buffer.from([0xff,0xd8,0xff]), headers: { 'content-length': '2048', 'content-type': 'image/jpeg' } },
      error: /melewati batas/
    },
    {
      name: 'mime',
      response: { status: 200, data: Buffer.from([0xff,0xd8,0xff]), headers: { 'content-type': 'image/png' } },
      error: /Content-Type|MIME type/
    },
    {
      name: 'signature',
      response: { status: 200, data: Buffer.from('MZ executable payload'), headers: { 'content-type': 'image/jpeg' } },
      error: /Signature/
    }
  ];

  for (const scenario of scenarios) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bubu-p3-${scenario.name}-`));
    const service = new MediaIntelligenceService({
      wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
      storageDir: dir,
      maxFileBytes: 1024,
      httpClient: { get: async () => scenario.response }
    });

    try {
      await assert.rejects(
        () => service.download({
          url: '/api/files/photo.jpg',
          filename: 'photo.jpg',
          mimetype: 'image/jpeg'
        }),
        scenario.error
      );
      assert.equal(fs.readdirSync(dir).length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('rejects foreign-origin and credential-bearing media URLs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-p3-url-'));
  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: dir,
    httpClient: { get: async () => assert.fail('HTTP client must not be called') }
  });

  try {
    await assert.rejects(
      () => service.download({
        url: 'https://attacker.example/file.jpg',
        filename: 'file.jpg',
        mimetype: 'image/jpeg'
      }),
      /host WAHA/
    );
    await assert.rejects(
      () => service.download({
        url: 'http://user:pass@127.0.0.1:3000/api/file.jpg',
        filename: 'file.jpg',
        mimetype: 'image/jpeg'
      }),
      /kredensial/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('distinguishes audio WebM from video WebM by MIME category', () => {
  assert.equal(resolveMediaExtension('clip.webm', 'video/webm', 'video'), '.webm');
  assert.equal(resolveMediaExtension('voice.webm', 'audio/webm', 'audio'), '.webm');
  assert.throws(() => resolveMediaExtension('clip.webm', 'audio/webm', 'video'), /MIME type/);
  assert.throws(() => resolveMediaExtension('voice.webm', 'video/webm', 'audio'), /MIME type/);
});


test('transcribeAudio invokes FFmpeg normalization and configured Silero VAD before Whisper', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-stt-vad-'));
  const input = path.join(dir, 'voice.ogg');
  fs.writeFileSync(input, 'fixture');
  const model = path.join(dir, 'ggml-base.bin');
  fs.writeFileSync(model, 'model-fixture');
  const vad = path.join(dir, 'silero.bin');
  fs.writeFileSync(vad, 'vad-fixture');
  const calls = [];
  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: dir,
    whisperModelPath: model,
    whisperVadModelPath: vad,
    commandRunner: async (command, args) => {
      calls.push({ command, args });
      if (command === 'ffprobe') return { stdout: '12.5' };
      if (command === 'ffmpeg') {
        fs.writeFileSync(args[args.length - 1], 'wav-fixture');
        return { stdout: '' };
      }
      return { stdout: 'Halo Bubu, ini tes transkripsi.' };
    }
  });
  try {
    const transcript = await service.transcribeAudio(input, dir);
    assert.equal(transcript, 'Halo Bubu, ini tes transkripsi.');
    assert.equal(calls[0].command, 'ffprobe');
    assert.equal(calls[1].command, 'ffmpeg');
    assert.equal(calls[1].args.includes('16000'), true);
    const whisper = calls[2];
    assert.equal(whisper.command, 'whisper-cli');
    assert.equal(whisper.args.includes('--vad'), true);
    assert.equal(whisper.args.includes('-vm'), true);
    assert.equal(whisper.args.includes(vad), true);
    assert.equal(whisper.args.includes('-t'), true);
    assert.equal(whisper.args.includes('2'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('transcribeAudio returns empty string when VAD produces no speech segments', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-stt-silent-'));
  const input = path.join(dir, 'silent.wav');
  fs.writeFileSync(input, 'fixture');
  const model = path.join(dir, 'ggml-base.bin');
  fs.writeFileSync(model, 'model-fixture');
  const vad = path.join(dir, 'silero.bin');
  fs.writeFileSync(vad, 'vad-fixture');
  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: dir,
    whisperModelPath: model,
    whisperVadModelPath: vad,
    commandRunner: async (command, args) => {
      if (command === 'ffprobe') return { stdout: '8' };
      if (command === 'ffmpeg') {
        fs.writeFileSync(args[args.length - 1], 'wav-fixture');
        return { stdout: '' };
      }
      return { stdout: '' };
    }
  });
  try {
    assert.equal(await service.transcribeAudio(input, dir), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('transcribeAudio fails closed when VAD model path is missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-stt-no-vad-'));
  const input = path.join(dir, 'voice.wav');
  fs.writeFileSync(input, 'fixture');
  const model = path.join(dir, 'ggml-base.bin');
  fs.writeFileSync(model, 'model-fixture');
  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: dir,
    whisperModelPath: model,
    whisperVadModelPath: ''
  });
  try {
    await assert.rejects(
      () => service.transcribeAudio(input, dir),
      /Silero VAD belum dikonfigurasi/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('processAudio marks VAD-empty result as noSpeech instead of inventing a transcript', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-stt-process-audio-'));
  const file = { filePath: path.join(dir, 'voice.ogg'), filename: 'voice.ogg' };
  fs.writeFileSync(file.filePath, 'fixture');
  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: dir,
    whisperModelPath: '/models/base.bin',
    whisperVadModelPath: '/models/vad.bin'
  });
  service.transcribeAudio = async () => '';
  try {
    const result = await service.processAudio(file, dir);
    assert.equal(result.noSpeech, true);
    assert.equal(result.extractedText, '');
    assert.equal(result.promptText, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('transcribeAudio fails closed when whisperModelPath file does not exist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-stt-missing-model-'));
  const input = path.join(dir, 'voice.wav');
  const vad = path.join(dir, 'silero.bin');
  fs.writeFileSync(input, 'fixture');
  fs.writeFileSync(vad, 'vad-fixture');
  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: dir,
    whisperModelPath: path.join(dir, 'missing-model.bin'),
    whisperVadModelPath: vad
  });
  try {
    await assert.rejects(
      () => service.transcribeAudio(input, dir),
      /Model Whisper tidak ditemukan/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('synthesizeSpeech validates piperModelPath, non-empty text, and non-empty OGG output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-tts-validate-'));
  const piperModel = path.join(dir, 'id.onnx');
  fs.writeFileSync(piperModel, 'onnx-fixture');
  try {
    const missingModelService = new MediaIntelligenceService({
      wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
      storageDir: dir,
      piperModelPath: path.join(dir, 'missing.onnx')
    });
    await assert.rejects(
      () => missingModelService.synthesizeSpeech('Halo', dir),
      /Model Piper TTS tidak ditemukan/
    );

    const emptyOutputService = new MediaIntelligenceService({
      wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
      storageDir: dir,
      piperModelPath: piperModel,
      commandRunner: async () => ({ stdout: '', stderr: '' })
    });
    await assert.rejects(
      () => emptyOutputService.synthesizeSpeech('   \n  ', dir),
      /kosong/
    );
    await assert.rejects(
      () => emptyOutputService.synthesizeSpeech('Halo Bubu', dir),
      /kosong atau tidak valid/
    );

    const okService = new MediaIntelligenceService({
      wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
      storageDir: dir,
      piperModelPath: piperModel,
      commandRunner: async (cmd, args) => {
        if (cmd === 'ffmpeg') fs.writeFileSync(args[args.length - 1], 'OggS-audio');
        return { stdout: '', stderr: '' };
      }
    });
    const voice = await okService.synthesizeSpeech('Halo Bubu', dir);
    assert.equal(voice.filename, 'bubu-voice.ogg');
    assert.equal(fs.existsSync(voice.filePath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MediaIntelligenceService.download sanitizes AxiosError credentials while preserving status and code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-media-axios-sanitize-'));
  const axios = require('axios');
  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000', apiKey: 'secret-waha-key' },
    storageDir: dir,
    httpClient: {
      get: async () => {
        throw new axios.AxiosError(
          'Request failed with status code 401',
          'ERR_BAD_REQUEST',
          { headers: { 'X-Api-Key': 'secret-waha-key' } },
          { socket: true },
          { status: 401, config: { headers: { 'X-Api-Key': 'secret-waha-key' } } }
        );
      }
    }
  });
  try {
    await assert.rejects(
      () => service.download({ url: '/api/files/photo.jpg', filename: 'photo.jpg', mimetype: 'image/jpeg' }),
      (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.response?.status, 401);
        assert.equal(err.code, 'ERR_BAD_REQUEST');
        assert.equal(err.config, undefined);
        assert.equal(err.request, undefined);
        assert.equal(JSON.stringify(err).includes('secret-waha-key'), false);
        return true;
      }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('processIncoming cleans up empty inbound hex subdirectories safely', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-inbound-cleanup-'));
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: dir,
    visionEnabled: false,
    httpClient: {
      get: async () => ({
        status: 200,
        data: jpeg,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(jpeg.length) }
      })
    },
    commandRunner: async () => ({ stdout: 'OCR text', stderr: '' })
  });
  try {
    await service.processIncoming({
      media: { url: '/api/files/photo.jpg', filename: 'photo.jpg', mimetype: 'image/jpeg' }
    });
    const inboundDir = path.join(dir, 'inbound');
    assert.deepEqual(fs.readdirSync(inboundDir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateMediaSignature avoids copying Buffer and handles Uint8Array inputs', () => {
  const origFrom = Buffer.from;
  let bufferFromCalls = 0;
  Buffer.from = (...args) => {
    bufferFromCalls++;
    return origFrom(...args);
  };
  try {
    const jpeg = origFrom([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    assert.equal(validateMediaSignature(jpeg, '.jpg', 'image'), true);
    assert.equal(bufferFromCalls, 0);
  } finally {
    Buffer.from = origFrom;
  }
  assert.equal(validateMediaSignature(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), '.jpg', 'image'), true);
});
