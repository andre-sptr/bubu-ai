const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MediaIntelligenceService, detectMediaKind, extensionFromMime, resolveMediaExtension, validateMediaSignature, runCommand } = require('../../src/p3/media/service');

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
  const vad = path.join(dir, 'silero.bin');
  fs.writeFileSync(vad, 'vad-fixture');
  const calls = [];
  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: dir,
    whisperModelPath: '/models/ggml-base.bin',
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
  const vad = path.join(dir, 'silero.bin');
  fs.writeFileSync(vad, 'vad-fixture');
  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: dir,
    whisperModelPath: '/models/ggml-base.bin',
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
  const service = new MediaIntelligenceService({
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: dir,
    whisperModelPath: '/models/ggml-base.bin',
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
