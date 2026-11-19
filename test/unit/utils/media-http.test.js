const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const pino = require('pino');
const { safeFilename, sanitizeAxiosError } = require('../../../src/utils/media-http');
const { classifyOperationalError } = require('../../../src/utils/error-policy');

test('safeFilename preserves extension when stem exceeds 100 chars and rejects dot-only names', () => {
  const longDocx = safeFilename(`${'Report_'.repeat(30)}.docx`);
  assert.ok(longDocx.length <= 100);
  assert.equal(longDocx.endsWith('.docx'), true);

  assert.equal(safeFilename('.'), 'document');
  assert.equal(safeFilename('..'), 'document');
  assert.equal(safeFilename('...'), 'document');
  assert.equal(safeFilename('   '), 'document');
  assert.equal(safeFilename('..', 'fallback'), 'fallback');
  assert.equal(safeFilename('../../unsafe?.pdf'), 'unsafe_.pdf');
});

test('sanitizeAxiosError strips config, request, and headers while preserving fields for error-policy', () => {
  const raw = new axios.AxiosError(
    'Request failed with status code 403',
    'ERR_BAD_REQUEST',
    { headers: { Authorization: 'Bearer secret', 'X-Api-Key': 'waha-secret' }, data: 'payload' },
    { req: true },
    { status: 403, config: { headers: { Authorization: 'Bearer secret' } } }
  );
  const sanitized = sanitizeAxiosError(raw);
  assert.equal(sanitized instanceof Error, true);
  assert.equal(sanitized.status, 403);
  assert.equal(sanitized.response?.status, 403);
  assert.equal(sanitized.code, 'ERR_BAD_REQUEST');
  assert.equal(sanitized.config, undefined);
  assert.equal(sanitized.request, undefined);

  const serialized = JSON.stringify(pino.stdSerializers.err(sanitized));
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('waha-secret'), false);
  assert.equal(classifyOperationalError(sanitized).category, 'authentication');
});
