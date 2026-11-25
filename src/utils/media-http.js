const path = require('node:path');
const { UserValidationError } = require('./error-policy');

function safeFilename(name, fallback = 'document') {
  const portable = String(name || fallback).replace(/\\/g, '/');
  const rawBase = path.basename(portable).replace(/[^\p{L}\p{N}._ -]/gu, '_').trim();
  if (!rawBase || /^\.+$/.test(rawBase)) return fallback;

  const ext = path.extname(rawBase);
  if (ext && ext.length < 100) {
    const stem = rawBase.slice(0, rawBase.length - ext.length).slice(0, 100 - ext.length).trim();
    if (!stem || /^\.+$/.test(stem)) {
      return `${fallback}${ext}`.slice(0, 100);
    }
    return `${stem}${ext}`;
  }

  const sliced = rawBase.slice(0, 100).trim();
  if (!sliced || /^\.+$/.test(sliced)) return fallback;
  return sliced;
}

function sanitizeAxiosError(error) {
  if (!error || typeof error !== 'object') {
    return new Error(String(error || 'HTTP request failed'));
  }
  const status = Number(error.status || error.statusCode || error.response?.status || error.cause?.response?.status || 0) || undefined;
  const code = error.code || error.cause?.code;
  const message = String(error.message || 'HTTP request failed');
  const sanitized = new Error(message);
  if (error.name && error.name !== 'AxiosError') {
    sanitized.name = error.name;
  }
  if (code) sanitized.code = String(code);
  if (status) {
    sanitized.status = status;
    sanitized.response = { status };
  }
  if (error.stack) {
    sanitized.stack = error.stack;
  }
  return sanitized;
}

function normalizeMimeType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function isGenericMime(value) {
  return ['', 'application/octet-stream', 'binary/octet-stream'].includes(
    normalizeMimeType(value)
  );
}

function normalizeMediaUrl(mediaUrl, wahaBaseUrl) {
  if (typeof mediaUrl !== 'string' || !mediaUrl.trim()) {
    throw new UserValidationError('WAHA tidak menyediakan URL media yang valid.');
  }

  let base;
  let media;
  try {
    base = new URL(wahaBaseUrl);
    media = new URL(mediaUrl.trim(), base);
  } catch {
    throw new UserValidationError('Media URL atau WAHA base URL tidak valid.');
  }

  if (!['http:', 'https:'].includes(base.protocol) ||
      !['http:', 'https:'].includes(media.protocol)) {
    throw new UserValidationError('Media URL hanya boleh menggunakan HTTP atau HTTPS.');
  }
  if (media.username || media.password) {
    throw new UserValidationError('Media URL dengan kredensial tertanam ditolak.');
  }

  const localAliases = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);
  if (localAliases.has(media.hostname.toLowerCase())) {
    media = new URL(`${media.pathname}${media.search}`, base);
  }

  if (media.origin !== base.origin) {
    throw new UserValidationError('Media URL tidak berasal dari host WAHA yang dikonfigurasi.');
  }

  // Fragments are client-side only and must never be sent to WAHA.
  media.hash = '';
  return media;
}

function buildMimeValidationError(message, { declared, received, label }) {
  const error = new UserValidationError(message);
  error.declaredMime = declared || '';
  error.responseMime = received || '';
  error.mediaLabel = label || '';
  return error;
}

function validateResponseMime(declaredMime, responseMime, acceptedMimes, label) {
  const declared = normalizeMimeType(declaredMime);
  const received = normalizeMimeType(responseMime);
  const accepted = new Set((acceptedMimes || []).map((m) => m.toLowerCase()));
  const isCompatibleAlias = (mime) =>
    (mime === 'application/zip' && ['.docx', '.xlsx', '.xlsm'].includes(label)) ||
    (mime === 'video/webm' && label === '.webm');
  const isDeclaredAccepted = !declared || isGenericMime(declared) || !accepted.size ||
    accepted.has(declared) || isCompatibleAlias(declared);
  const isReceivedAccepted = !received || isGenericMime(received) || !accepted.size ||
    accepted.has(received) || isCompatibleAlias(received);

  if (!isDeclaredAccepted) {
    throw buildMimeValidationError(`MIME type media tidak didukung untuk ${label}.`, { declared, received, label });
  }
  if (!isReceivedAccepted) {
    throw buildMimeValidationError(`Content-Type unduhan tidak sesuai dengan ${label}.`, { declared, received, label });
  }
  const sameExtensionAliases = accepted.size > 0 &&
    (accepted.has(declared) || isCompatibleAlias(declared)) &&
    (accepted.has(received) || isCompatibleAlias(received));
  if (declared && received && !isGenericMime(declared) && !isGenericMime(received) &&
      declared !== received && !sameExtensionAliases && !isCompatibleAlias(received)) {
    throw buildMimeValidationError('MIME type webhook berbeda dengan Content-Type hasil unduhan.', { declared, received, label });
  }
}

module.exports = {
  safeFilename,
  sanitizeAxiosError,
  normalizeMediaUrl,
  normalizeMimeType,
  isGenericMime,
  validateResponseMime
};
