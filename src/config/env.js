const path = require('node:path');

function parseBool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function loadConfig(env = process.env) {
  const required = ['SUMOPOD_API_KEY', 'WAHA_BASE_URL', 'WAHA_SESSION', 'OWNER_JID'];
  const missing = required.filter((k) => !String(env[k] || '').trim());
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  if ((env.NODE_ENV || 'development') === 'production' && !env.WAHA_WEBHOOK_TOKEN) {
    throw new Error('WAHA_WEBHOOK_TOKEN is required in production');
  }

  // Benchmark-informed defaults for the Sumopod catalog supplied by the owner.
  // Optional MODEL_* overrides are available, so routine model selection needs no
  // per-tier capability flags or manual smoke-test configuration.
  const modelDefaults = {
    fast: 'claude-haiku-5-5',
    balanced: 'claude-sonnet-5-5',
    reasoning: 'claude-opus-5-5',
    coding: 'claude-sonnet-5-5',
    summary: 'gemini/gemini-3.1-pro-preview'
  };
  const models = {};
  for (const [tier, defaultId] of Object.entries(modelDefaults)) {
    const envKey = `MODEL_${tier.toUpperCase()}`;
    models[tier] = {
      id: String(env[envKey] || defaultId).trim(),
      supportsTools: true,
      ...(tier === 'balanced' ? { supportsVision: true } : {})
    };
  }
  models.vision = {
    id: String(env.MODEL_VISION || models.balanced.id).trim(),
    supportsTools: true,
    supportsVision: true
  };

  return Object.freeze({
    nodeEnv: env.NODE_ENV || 'development',
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 3088),
    logLevel: env.LOG_LEVEL || 'info',
    databasePath: path.resolve(env.DATABASE_PATH || './data/bubu.sqlite'),
    storageDir: path.resolve(env.STORAGE_DIR || './storage'),
    ownerJid: normalizeJid(env.OWNER_JID),
    botJid: normalizeJid(env.BOT_JID || ''),
    groupPolicy: env.GROUP_POLICY || 'all',
    groupRequireMention: parseBool(env.GROUP_REQUIRE_MENTION, true),
    groupMediaRequireMention: parseBool(env.GROUP_MEDIA_REQUIRE_MENTION, false),
    groupProactiveEnabled: parseBool(env.GROUP_PROACTIVE_ENABLED, false),
    waha: {
      baseUrl: String(env.WAHA_BASE_URL).replace(/\/+$/, ''),
      session: env.WAHA_SESSION,
      apiKey: env.WAHA_API_KEY || '',
      webhookToken: env.WAHA_WEBHOOK_TOKEN || '',
      webhookHeader: (env.WAHA_WEBHOOK_HEADER || 'x-webhook-token').toLowerCase()
    },
    search: {
      tavilyApiKey: env.TAVILY_API_KEY || '',
      maxResults: Math.min(10, Math.max(1, Number(env.WEB_SEARCH_MAX_RESULTS || 5)))
    },
    documents: {
      maxFileBytes: Math.min(30 * 1024 * 1024, Math.max(1024 * 1024, Number(env.MAX_DOCUMENT_BYTES || 15 * 1024 * 1024))),
      maxExtractChars: Math.min(100000, Math.max(5000, Number(env.MAX_DOCUMENT_CHARS || 50000)))
    },
    media: {
      enabled: parseBool(env.MEDIA_INTELLIGENCE_ENABLED, true),
      visionEnabled: parseBool(env.MEDIA_VISION_ENABLED, true),
      maxFileBytes: Math.min(50 * 1024 * 1024, Math.max(1024 * 1024, Number(env.MAX_MEDIA_BYTES || 25 * 1024 * 1024))),
      maxVisionBytes: Math.min(10 * 1024 * 1024, Math.max(256 * 1024, Number(env.MAX_VISION_IMAGE_BYTES || 4 * 1024 * 1024))),
      maxVisionDimension: Math.min(2048, Math.max(256, Number(env.MAX_VISION_IMAGE_DIMENSION || 1280))),
      maxAudioSeconds: Math.min(1800, Math.max(30, Number(env.MAX_AUDIO_SECONDS || 900))),
      maxVideoSeconds: Math.min(300, Math.max(10, Number(env.MAX_VIDEO_SECONDS || 180))),
      maxVideoFrames: Math.min(12, Math.max(1, Number(env.MAX_VIDEO_FRAMES || 8))),
      tesseractBin: env.TESSERACT_BIN || 'tesseract',
      ffmpegBin: env.FFMPEG_BIN || 'ffmpeg',
      ffprobeBin: env.FFPROBE_BIN || 'ffprobe',
      whisperBin: env.WHISPER_BIN !== undefined ? env.WHISPER_BIN : '/opt/whisper.cpp/build/bin/whisper-cli',
      whisperModelPath: env.WHISPER_MODEL_PATH !== undefined ? env.WHISPER_MODEL_PATH : '/opt/whisper.cpp/models/ggml-base.bin',
      whisperLanguage: env.WHISPER_LANGUAGE || 'auto',
      whisperVadModelPath: env.WHISPER_VAD_MODEL_PATH !== undefined ? env.WHISPER_VAD_MODEL_PATH : '/opt/whisper.cpp/models/ggml-silero-v6.2.0.bin',
      piperBin: env.PIPER_BIN !== undefined ? env.PIPER_BIN : '/opt/piper-venv/bin/piper',
      piperModelPath: env.PIPER_MODEL_PATH !== undefined ? env.PIPER_MODEL_PATH : '/opt/piper-voices/id_ID-news_tts-medium.onnx',
      voiceReplyDefault: parseBool(env.VOICE_REPLY_DEFAULT, false)
    },
    sumopod: {
      baseUrl: (env.SUMOPOD_BASE_URL || 'https://ai.sumopod.com/v1').replace(/\/+$/, ''),
      apiKey: env.SUMOPOD_API_KEY,
      timeoutMs: Number(env.SUMOPOD_TIMEOUT_MS || 60000),
      models
    },
    inbox: {
      pollMs: Math.min(5000, Math.max(100, Number(env.INBOX_POLL_MS || 500))),
      maxAttempts: Math.min(10, Math.max(1, Number(env.INBOX_MAX_ATTEMPTS || 5))),
      staleMs: Math.min(600000, Math.max(30000, Number(env.INBOX_STALE_MS || 120000)))
    },
    agent: {
      enabled: parseBool(env.AGENT_ENABLED, true),
      maxRounds: Number(env.AGENT_MAX_ROUNDS || 5),
      maxToolCalls: Number(env.AGENT_MAX_TOOL_CALLS || 8),
      maxToolResultChars: Number(env.AGENT_MAX_TOOL_RESULT_CHARS || 12000),
      maxOutputTokens: Math.min(8192, Math.max(1024, Number(env.AGENT_MAX_OUTPUT_TOKENS || 4096))),
      taskTimeoutMs: Number(env.AGENT_TASK_TIMEOUT_MS || 90000),
      toolTimeoutMs: Number(env.AGENT_TOOL_TIMEOUT_MS || 15000),
      maxConcurrentJobs: Number(env.AGENT_MAX_CONCURRENT_JOBS || 1),
      messageRateLimit: Number(env.MESSAGE_RATE_LIMIT || 10),
      messageRateWindowMs: Number(env.MESSAGE_RATE_WINDOW_MS || 60000),
      approvalTtlMinutes: Number(env.APPROVAL_TTL_MINUTES || 5)
    }
  });
}

function normalizeJid(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (/^\d+(?::\d+)?@c\.us$/.test(raw)) return `${raw.split('@')[0].split(':')[0]}@c.us`;
  if (/^\d+(?::\d+)?@s\.whatsapp\.net$/.test(raw)) return `${raw.split('@')[0].split(':')[0]}@c.us`;
  if (/^\d{8,15}$/.test(raw)) return `${raw}@c.us`;
  return raw;
}

module.exports = { loadConfig, normalizeJid, parseBool };
