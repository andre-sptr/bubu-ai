const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../../src/config/env');

test('requires credentials and owner identity', () => {
  assert.throws(() => loadConfig({}), /SUMOPOD_API_KEY/);
});
test('loads the requested all-groups policy and Sumopod tiers', () => {
  const c = loadConfig({
    SUMOPOD_API_KEY: 'key',
    WAHA_BASE_URL: 'http://localhost:3001',
    WAHA_SESSION: 'default',
    OWNER_JID: '628123@s.whatsapp.net',
    GROUP_POLICY: 'all',
    MODEL_BALANCED: 'model-b',
    MODEL_BALANCED_TOOL_CALLING: 'true'
  });
  assert.equal(c.groupPolicy, 'all');
  assert.equal(c.ownerJid, '628123@c.us');
  assert.equal(c.sumopod.models.balanced.id, 'model-b');
  assert.equal(c.sumopod.models.balanced.supportsTools, true);
});


test('uses benchmark-informed model defaults without model validation flags', () => {
  const c = loadConfig({
    SUMOPOD_API_KEY: 'key',
    WAHA_BASE_URL: 'http://localhost:3001',
    WAHA_SESSION: 'default',
    OWNER_JID: '628123@c.us'
  });
  assert.equal(c.sumopod.models.fast.id, 'claude-haiku-5-5');
  assert.equal(c.sumopod.models.balanced.id, 'claude-sonnet-5-5');
  assert.equal(c.sumopod.models.reasoning.id, 'claude-opus-5-5');
  assert.equal(c.sumopod.models.coding.id, 'claude-sonnet-5-5');
  assert.equal(c.sumopod.models.summary.id, 'gemini/gemini-3.1-pro-preview');
});


test('P3 media configuration has safe defaults and optional local models', () => {
  const c = loadConfig({
    SUMOPOD_API_KEY: 'key',
    WAHA_BASE_URL: 'http://localhost:3001',
    WAHA_SESSION: 'default',
    OWNER_JID: '628123456789'
  });
  assert.equal(c.media.enabled, true);
  assert.equal(c.media.maxVideoFrames, 8);
  assert.equal(c.media.whisperBin, '/opt/whisper.cpp/build/bin/whisper-cli');
  assert.equal(c.media.whisperModelPath, '/opt/whisper.cpp/models/ggml-base.bin');
  assert.equal(c.media.whisperLanguage, 'auto');
  assert.equal(c.media.whisperVadModelPath, '/opt/whisper.cpp/models/ggml-silero-v6.2.0.bin');
  assert.equal(c.media.piperBin, '/opt/piper-venv/bin/piper');
  assert.equal(c.media.piperModelPath, '/opt/piper-voices/id_ID-news_tts-medium.onnx');
  assert.equal(c.media.voiceReplyDefault, false);
});


test('group routing defaults to mention-gated text and accepts media-only group messages', () => {
  const c = loadConfig({
    SUMOPOD_API_KEY: 'key',
    WAHA_BASE_URL: 'http://localhost:3000',
    WAHA_SESSION: 'default',
    OWNER_JID: '628123456789',
    BOT_JID: '628987654321@s.whatsapp.net'
  });
  assert.equal(c.botJid, '628987654321@c.us');
  assert.equal(c.groupRequireMention, true);
  assert.equal(c.groupMediaRequireMention, false);
});

test('group media can optionally require a detectable bot mention', () => {
  const c = loadConfig({
    SUMOPOD_API_KEY: 'key',
    WAHA_BASE_URL: 'http://localhost:3000',
    WAHA_SESSION: 'default',
    OWNER_JID: '628123456789',
    GROUP_MEDIA_REQUIRE_MENTION: 'true'
  });
  assert.equal(c.groupMediaRequireMention, true);
});


test('agent output token budget is configurable and bounded', () => {
  const base = {
    SUMOPOD_API_KEY: 'key',
    WAHA_BASE_URL: 'http://localhost:3000',
    WAHA_SESSION: 'default',
    OWNER_JID: '628123456789'
  };
  assert.equal(loadConfig(base).agent.maxOutputTokens, 4096);
  assert.equal(loadConfig({ ...base, AGENT_MAX_OUTPUT_TOKENS: '6144' }).agent.maxOutputTokens, 6144);
  assert.equal(loadConfig({ ...base, AGENT_MAX_OUTPUT_TOKENS: '99999' }).agent.maxOutputTokens, 8192);
  assert.equal(loadConfig({ ...base, AGENT_MAX_OUTPUT_TOKENS: '10' }).agent.maxOutputTokens, 1024);
});


test('inbox reliability settings have safe defaults and bounded overrides', () => {
  const base = {
    SUMOPOD_API_KEY: 'key',
    WAHA_BASE_URL: 'http://localhost:3000',
    WAHA_SESSION: 'default',
    OWNER_JID: '628123456789'
  };
  assert.deepEqual(loadConfig(base).inbox, {
    pollMs: 500, maxAttempts: 5, staleMs: 120000
  });
  assert.deepEqual(loadConfig({
    ...base,
    INBOX_POLL_MS: '10000',
    INBOX_MAX_ATTEMPTS: '20',
    INBOX_STALE_MS: '10000'
  }).inbox, {
    pollMs: 5000, maxAttempts: 10, staleMs: 30000
  });
});


test('minimal production environment works without optional overrides', () => {
  const c = loadConfig({
    NODE_ENV: 'production',
    OWNER_JID: '628123456789@c.us',
    WAHA_BASE_URL: 'http://127.0.0.1:3000',
    WAHA_SESSION: 'default',
    WAHA_WEBHOOK_TOKEN: 'a-long-test-webhook-secret',
    SUMOPOD_API_KEY: 'test-sumopod-key'
  });

  assert.equal(c.port, 3088);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.databasePath.replace(/\\/g, '/').endsWith('/data/bubu.sqlite'), true);
  assert.equal(c.storageDir.replace(/\\/g, '/').endsWith('/storage'), true);
  assert.equal(c.sumopod.baseUrl, 'https://ai.sumopod.com/v1');
  assert.equal(c.sumopod.models.vision.id, 'claude-sonnet-5-5');
  assert.equal(c.media.visionEnabled, true);
  assert.equal(c.media.maxVisionBytes, 4 * 1024 * 1024);
  assert.equal(c.media.maxVisionDimension, 1280);
  assert.equal(c.agent.maxOutputTokens, 4096);
  assert.deepEqual(c.inbox, {
    pollMs: 500, maxAttempts: 5, staleMs: 120000
  });
  assert.equal(c.groupRequireMention, true);
  assert.equal(c.media.enabled, true);
});
