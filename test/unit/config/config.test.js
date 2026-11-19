const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, normalizeJid, parsePositiveInt } = require('../../../src/config/env');

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

test('WAHA webhook token trims whitespace and rejects blank token in production while allowing short test tokens', () => {
  const base = {
    NODE_ENV: 'production',
    SUMOPOD_API_KEY: 'key',
    WAHA_BASE_URL: 'http://localhost:3000',
    WAHA_SESSION: 'default',
    OWNER_JID: '628123456789'
  };
  assert.throws(
    () => loadConfig({ ...base, WAHA_WEBHOOK_TOKEN: '   \t\n  ' }),
    /WAHA_WEBHOOK_TOKEN is required in production/
  );
  const shortCfg = loadConfig({ ...base, WAHA_WEBHOOK_TOKEN: '  top-secret  ' });
  assert.equal(shortCfg.waha.webhookToken, 'top-secret');
});

test('WAHA hardening config fields have safe defaults and overrides', () => {
  const base = {
    SUMOPOD_API_KEY: 'key',
    WAHA_BASE_URL: 'http://localhost:3000/',
    WAHA_SESSION: 'default',
    OWNER_JID: '628123456789'
  };
  const defaults = loadConfig(base);
  assert.equal(defaults.waha.webhookHmacSecret, '');
  assert.equal(defaults.waha.timeoutMs, 15000);
  assert.equal(defaults.waha.mediaTimeoutMs, 60000);
  assert.equal(defaults.waha.typingKeepaliveMs, 12000);

  const custom = loadConfig({
    ...base,
    WAHA_WEBHOOK_HMAC_SECRET: '  hmac-secret-val  ',
    WAHA_TIMEOUT_MS: '20000',
    WAHA_MEDIA_TIMEOUT_MS: '90000',
    WAHA_TYPING_KEEPALIVE_MS: '10000'
  });
  assert.equal(custom.waha.webhookHmacSecret, 'hmac-secret-val');
  assert.equal(custom.waha.timeoutMs, 20000);
  assert.equal(custom.waha.mediaTimeoutMs, 90000);
  assert.equal(custom.waha.typingKeepaliveMs, 10000);
});

test('normalizeJid strips device suffixes from @lid, @c.us, and @s.whatsapp.net', () => {
  assert.equal(normalizeJid('12345:2@lid'), '12345@lid');
  assert.equal(normalizeJid('12345@lid'), '12345@lid');
  assert.equal(normalizeJid('628123:4@c.us'), '628123@c.us');
  assert.equal(normalizeJid('628123:9@s.whatsapp.net'), '628123@c.us');
});

test('parsePositiveInt and loadConfig never produce NaN on invalid numeric env vars', () => {
  assert.equal(parsePositiveInt('abc', 42), 42);
  assert.equal(parsePositiveInt('-5', 42), 42);
  assert.equal(parsePositiveInt('0', 42), 42);
  assert.equal(parsePositiveInt('12.5', 42), 42);
  assert.equal(parsePositiveInt(' 15 ', 42), 15);

  const c = loadConfig({
    SUMOPOD_API_KEY: 'key',
    WAHA_BASE_URL: 'http://localhost:3000',
    WAHA_SESSION: 'default',
    OWNER_JID: '628123456789',
    PORT: 'invalid',
    WAHA_TIMEOUT_MS: 'NaN',
    WAHA_MEDIA_TIMEOUT_MS: '-1',
    WAHA_TYPING_KEEPALIVE_MS: '0',
    SUMOPOD_TIMEOUT_MS: 'abc',
    AGENT_MAX_ROUNDS: 'abc',
    AGENT_MAX_TOOL_CALLS: '0',
    AGENT_MAX_TOOL_RESULT_CHARS: '-10',
    AGENT_TASK_TIMEOUT_MS: 'nope',
    AGENT_TOOL_TIMEOUT_MS: 'Infinity',
    AGENT_MAX_CONCURRENT_JOBS: 'bad',
    MESSAGE_RATE_LIMIT: 'bad',
    MESSAGE_RATE_WINDOW_MS: '0',
    APPROVAL_TTL_MINUTES: 'abc'
  });
  assert.equal(c.port, 3088);
  assert.equal(c.waha.timeoutMs, 15000);
  assert.equal(c.waha.mediaTimeoutMs, 60000);
  assert.equal(c.waha.typingKeepaliveMs, 12000);
  assert.equal(c.sumopod.timeoutMs, 60000);
  assert.equal(c.agent.maxRounds, 5);
  assert.equal(c.agent.maxToolCalls, 8);
  assert.equal(c.agent.maxToolResultChars, 12000);
  assert.equal(c.agent.taskTimeoutMs, 90000);
  assert.equal(c.agent.toolTimeoutMs, 15000);
  assert.equal(c.agent.maxConcurrentJobs, 1);
  assert.equal(c.agent.messageRateLimit, 10);
  assert.equal(c.agent.messageRateWindowMs, 60000);
  assert.equal(c.agent.approvalTtlMinutes, 5);
});
