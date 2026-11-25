const path = require('node:path');
const { normalizeMimeType, isGenericMime } = require('../utils/media-http');
const { UserValidationError } = require('../utils/error-policy');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff']);
const AUDIO_EXT = new Set(['.ogg', '.oga', '.opus', '.mp3', '.m4a', '.aac', '.wav', '.flac', '.amr', '.webm']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.3gp']);
const DOCUMENT_EXT = new Set(['.pdf', '.docx', '.xlsx', '.xlsm', '.csv', '.txt']);

const EXTENSION_MIMES = {
  '.jpg': ['image/jpeg', 'image/jpg'], '.jpeg': ['image/jpeg', 'image/jpg'],
  '.png': ['image/png'], '.webp': ['image/webp'], '.bmp': ['image/bmp'],
  '.tif': ['image/tiff'], '.tiff': ['image/tiff'],
  '.ogg': ['audio/ogg', 'application/ogg'], '.oga': ['audio/ogg', 'application/ogg'],
  '.opus': ['audio/opus', 'audio/ogg', 'application/ogg'],
  '.mp3': ['audio/mpeg', 'audio/mp3'], '.m4a': ['audio/mp4', 'audio/x-m4a'],
  '.aac': ['audio/aac', 'audio/x-aac'], '.wav': ['audio/wav', 'audio/x-wav'],
  '.flac': ['audio/flac', 'audio/x-flac'], '.amr': ['audio/amr', 'audio/3gpp'],
  '.webm': ['audio/webm', 'video/webm'], '.mp4': ['video/mp4', 'application/mp4'],
  '.mov': ['video/quicktime'], '.mkv': ['video/x-matroska'],
  '.avi': ['video/x-msvideo', 'video/avi'], '.3gp': ['video/3gpp']
};

const GENERIC_EXTENSIONS = new Set(['', '.bin', '.dat']);

function acceptedMimesForExtension(ext, kind) {
  const values = EXTENSION_MIMES[ext] || [];
  if (ext === '.webm') return values.filter((value) => value.startsWith(`${kind}/`));
  return values;
}

function detectMediaKind(filename, mimetype = '') {
  const ext = path.extname(String(filename || '')).toLowerCase();
  const mime = String(mimetype || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext) || ext === '.3gp') return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (DOCUMENT_EXT.has(ext) || mime === 'application/pdf') return 'document';
  return 'unsupported';
}

function validateMediaSignature(buffer, ext, kind) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const starts = (...values) => values.every((value, index) => bytes[index] === value);
  const ascii = (start, end) => bytes.subarray(start, end).toString('ascii');

  if (kind === 'image') {
    if (ext === '.jpg' || ext === '.jpeg') return starts(0xff, 0xd8, 0xff);
    if (ext === '.png') return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    if (ext === '.webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    if (ext === '.bmp') return ascii(0, 2) === 'BM';
    if (ext === '.tif' || ext === '.tiff') return starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a);
    return false;
  }

  if (kind === 'audio') {
    if (ext === '.ogg' || ext === '.oga' || ext === '.opus') return ascii(0, 4) === 'OggS';
    if (ext === '.wav') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE';
    if (ext === '.flac') return ascii(0, 4) === 'fLaC';
    if (ext === '.mp3') return ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    if (ext === '.amr') return ascii(0, 6) === '#!AMR\n';
    if (ext === '.m4a') return ascii(4, 8) === 'ftyp';
    if (ext === '.aac') return bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
    if (ext === '.webm') return starts(0x1a, 0x45, 0xdf, 0xa3);
    return false;
  }

  if (kind === 'video') {
    if (ext === '.mp4' || ext === '.mov' || ext === '.3gp') return ascii(4, 8) === 'ftyp';
    if (ext === '.webm' || ext === '.mkv') return starts(0x1a, 0x45, 0xdf, 0xa3);
    if (ext === '.avi') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'AVI ';
    return false;
  }

  return false;
}

function extensionFromMime(mimetype, kind) {
  const mime = String(mimetype || '').toLowerCase().split(';')[0].trim();
  const map = {
    'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'image/bmp': '.bmp', 'image/tiff': '.tiff',
    'audio/ogg': '.ogg', 'audio/opus': '.opus', 'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
    'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/flac': '.flac', 'audio/x-flac': '.flac',
    'audio/webm': '.webm', 'audio/x-m4a': '.m4a', 'audio/x-aac': '.aac', 'audio/3gpp': '.amr',
    'video/mp4': '.mp4', 'application/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
    'video/x-matroska': '.mkv', 'video/3gpp': '.3gp', 'video/x-msvideo': '.avi', 'video/avi': '.avi'
  };
  return map[mime] || (kind === 'image' ? '.jpg' : kind === 'audio' ? '.ogg' : '.mp4');
}

function resolveMediaExtension(filename, mimetype, kind) {
  let ext = path.extname(String(filename || '')).toLowerCase();
  const mime = normalizeMimeType(mimetype);
  const mapped = extensionFromMime(mime, kind);

  if (!ext || GENERIC_EXTENSIONS.has(ext)) {
    ext = mapped;
  } else if (!EXTENSION_MIMES[ext]) {
    throw new UserValidationError('Ekstensi file media tidak didukung.');
  }

  if (!ext || !EXTENSION_MIMES[ext]) {
    throw new UserValidationError('Ekstensi media tidak dapat ditentukan dari MIME type.');
  }

  const allowedMimes = acceptedMimesForExtension(ext, kind);
  if (mime && !isGenericMime(mime) && !allowedMimes.includes(mime)) {
    throw new UserValidationError(`MIME type ${mime} tidak sesuai dengan ekstensi ${ext}.`);
  }

  const extensionKind = ext === '.webm' ? kind :
    IMAGE_EXT.has(ext) ? 'image' :
    AUDIO_EXT.has(ext) ? 'audio' :
    VIDEO_EXT.has(ext) ? 'video' : 'unsupported';

  if (extensionKind !== kind) {
    throw new UserValidationError('Ekstensi file tidak sesuai dengan kategori media.');
  }

  return ext;
}

function formatTimestampSeconds(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(safe / 60);
  const rem = (safe - mins * 60).toFixed(1).padStart(4, '0');
  return `${String(mins).padStart(2, '0')}:${rem}`;
}

function isAnimatedWebpBuffer(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (bytes.length < 16) return false;
  if (bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WEBP') {
    return false;
  }

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourCc = bytes.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = bytes.readUInt32LE(offset + 4);
    if (fourCc === 'ANIM' || fourCc === 'ANMF') {
      return true;
    }
    if (fourCc === 'VP8X' && offset + 9 <= bytes.length) {
      if ((bytes[offset + 8] & 0x02) !== 0) {
        return true;
      }
    }
    const step = 8 + chunkSize + (chunkSize % 2);
    if (step <= 8 || offset + step > bytes.length) {
      break;
    }
    offset += step;
  }
  return false;
}

module.exports = {
  IMAGE_EXT,
  AUDIO_EXT,
  VIDEO_EXT,
  DOCUMENT_EXT,
  EXTENSION_MIMES,
  GENERIC_EXTENSIONS,
  acceptedMimesForExtension,
  detectMediaKind,
  validateMediaSignature,
  isAnimatedWebpBuffer,
  extensionFromMime,
  resolveMediaExtension,
  formatTimestampSeconds
};
