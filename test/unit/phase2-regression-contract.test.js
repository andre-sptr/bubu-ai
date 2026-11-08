const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../../src/config/env');
const { ModelRouter } = require('../../src/agent/model-router');
const { SYSTEM_PROMPT, buildAttachmentEvidenceMessage } = require('../../src/agent/runtime');
const { validateImageDataUrl } = require('../../src/providers/sumopod');
const { normalizeIncoming } = require('../../src/channels/waha/client');

const projectRoot = path.resolve(__dirname, '../..');

test('Phase 2 contract: MessageProcessor delegates operational media errors to InboxWorker without undefined classifier calls', () => {
  const processorSource = fs.readFileSync(
    path.join(projectRoot, 'src/agent/message-processor.js'),
    'utf8'
  );
  assert.equal(processorSource.includes('classifyOperationalError('), false);
  assert.match(processorSource, /sendMediaNotice\(/);
});

test('Phase 2 contract: WAHA GOWS normalizer separates bodyText, captionText, quote context, and rejects cross-chat quotes', () => {
  const sameChat = normalizeIncoming({
    event: 'message',
    payload: {
      id: 'p2-same-chat',
      from: '628111111111@c.us',
      author: '628111111111@c.us',
      body: 'Body instruction',
      hasMedia: true,
      _data: {
        Info: { Chat: '628111111111@c.us', MediaType: 'image', IsFromMe: false },
        Message: {
          imageMessage: {
            URL: '/api/files/img.jpg',
            caption: 'Image caption',
            mimetype: 'image/jpeg'
          },
          extendedTextMessage: {
            contextInfo: {
              stanzaID: 'stanza-1',
              remoteJid: '628111111111@c.us',
              quotedMessage: { conversation: 'Quoted text' }
            }
          }
        }
      }
    }
  });
  assert.equal(sameChat.bodyText, 'Body instruction');
  assert.equal(sameChat.captionText, 'Image caption');
  assert.equal(sameChat.quote.present, true);
  assert.equal(sameChat.quote.text, 'Quoted text');

  const crossChat = normalizeIncoming({
    event: 'message',
    payload: {
      id: 'p2-cross-chat',
      from: '628111111111@c.us',
      author: '628111111111@c.us',
      body: 'Body instruction',
      _data: {
        Info: { Chat: '628111111111@c.us', IsFromMe: false },
        Message: {
          extendedTextMessage: {
            contextInfo: {
              stanzaID: 'stanza-2',
              remoteJid: '120363000000000000@g.us',
              quotedMessage: { conversation: 'Secret group text' }
            }
          }
        }
      }
    }
  });
  assert.equal(crossChat.quote.rejected, true);
  assert.equal(crossChat.quote.present, false);
  assert.equal(crossChat.quote.text, undefined);
});

test('Phase 2 contract: visual routing selects claude-sonnet-5-5 and enforces base64 data URL boundary', () => {
  const cfg = loadConfig({
    SUMOPOD_API_KEY: 'test-key',
    WAHA_BASE_URL: 'http://127.0.0.1:3000',
    WAHA_SESSION: 'default',
    OWNER_JID: '628111111111@c.us'
  });
  const router = new ModelRouter(cfg.sumopod.models);
  assert.equal(router.select('simple_question', { needsTools: true, needsVision: true }).model, 'claude-sonnet-5-5');

  const sampleJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const dataUrl = `data:image/jpeg;base64,${sampleJpeg.toString('base64')}`;
  assert.equal(validateImageDataUrl(dataUrl), dataUrl);
  assert.throws(() => validateImageDataUrl('http://127.0.0.1:3000/api/files/a.jpg'), /Private or remote URLs are forbidden/);
});

test('Phase 2 contract: runtime builds multimodal evidence for image/video frames and supports forced OCR fallback', () => {
  const sampleJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const dataUrl = `data:image/jpeg;base64,${sampleJpeg.toString('base64')}`;
  const evidence = {
    kind: 'video',
    filename: 'clip.mp4',
    extractedText: 'Timeline summary',
    visualMode: 'visual_frames',
    partialOnly: false,
    temporalStatus: 'sampled_frames',
    durationSeconds: 4.5,
    frames: [{ index: 1, timestampSeconds: 0, timestampLabel: '00:00.0', ocrText: '', hasVisual: true }],
    visualImages: [{ label: 'Frame 1 (t=00:00.0)', index: 1, mimeType: 'image/jpeg', dataUrl }]
  };

  const multimodalMsg = buildAttachmentEvidenceMessage(evidence, { includeVisual: true });
  assert.equal(Array.isArray(multimodalMsg.content), true);
  assert.equal(multimodalMsg.content.length, 2);
  assert.equal(multimodalMsg.content[1].type, 'image_url');
  assert.equal(multimodalMsg.content[1].image_url.url, dataUrl);

  const fallbackMsg = buildAttachmentEvidenceMessage(evidence, { includeVisual: false, forceOcrFallback: true });
  assert.equal(typeof fallbackMsg.content, 'string');
  assert.match(fallbackMsg.content, /"visualMode":"partial_ocr_audio"/);
  assert.match(fallbackMsg.content, /"partialOnly":true/);
});

test('Phase 2 contract: regression docs use /rangkum and current /voice modes', () => {
  const phase1Plan = fs.readFileSync(
    path.join(projectRoot, 'docs/PHASE-1-FULL-REGRESSION-PLAN.md'),
    'utf8'
  );
  assert.equal(phase1Plan.includes('Run `/summary`'), false);
  assert.equal(phase1Plan.includes('Run `/rangkum`'), true);
  assert.match(SYSTEM_PROMPT, /visualMode is "ocr_fallback"/);
  assert.match(SYSTEM_PROMPT, /temporalStatus is "insufficient_sample"/);
});
