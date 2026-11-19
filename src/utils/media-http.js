const path = require('node:path');

function safeFilename(name, fallback = 'document') {
  const portable = String(name || fallback).replace(/\\/g, '/');
  const base = path.basename(portable).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 100);
  return base || fallback;
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
    throw new Error('WAHA tidak menyediakan URL media yang valid.');
  }

  let base;
  let media;
  try {
    base = new URL(wahaBaseUrl);
    media = new URL(mediaUrl.trim(), base);
  } catch {
    throw new Error('Media URL atau WAHA base URL tidak valid.');
  }

  if (!['http:', 'https:'].includes(base.protocol) ||
      !['http:', 'https:'].includes(media.protocol)) {
    throw new Error('Media URL hanya boleh menggunakan HTTP atau HTTPS.');
  }
  if (media.username || media.password) {
    throw new Error('Media URL dengan kredensial tertanam ditolak.');
  }

  const localAliases = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);
  if (localAliases.has(media.hostname.toLowerCase())) {
    media = new URL(`${media.pathname}${media.search}`, base);
  }

  if (media.origin !== base.origin) {
    throw new Error('Media URL tidak berasal dari host WAHA yang dikonfigurasi.');
  }

  // Fragments are client-side only and must never be sent to WAHA.
  media.hash = '';
  return media;
}

function validateResponseMime(declaredMime, responseMime, acceptedMimes, label) {
  const declared = normalizeMimeType(declaredMime);
  const received = normalizeMimeType(responseMime);
  const accepted = new Set((acceptedMimes || []).map((m) => m.toLowerCase()));

  if (declared && !isGenericMime(declared) && accepted.size && !accepted.has(declared) &&
      !(declared === 'application/zip' && ['.docx', '.xlsx', '.xlsm'].includes(label))) {
    throw new Error(`MIME type media tidak didukung untuk ${label}.`);
  }
  if (received && !isGenericMime(received) && accepted.size && !accepted.has(received)) {
    // application/zip is a common generic container MIME for OOXML files.
    if (!(received === 'application/zip' && ['.docx', '.xlsx', '.xlsm'].includes(label))) {
      throw new Error(`Content-Type unduhan tidak sesuai dengan ${label}.`);
    }
  }
  if (declared && received && !isGenericMime(declared) && !isGenericMime(received) &&
      declared !== received && !(received === 'application/zip' &&
        ['.docx', '.xlsx', '.xlsm'].includes(label))) {
    throw new Error('MIME type webhook berbeda dengan Content-Type hasil unduhan.');
  }
}

module.exports = {
  safeFilename,
  normalizeMediaUrl,
  normalizeMimeType,
  isGenericMime,
  validateResponseMime
};
