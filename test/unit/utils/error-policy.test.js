const test = require('node:test');
const assert = require('node:assert/strict');
const { UserValidationError, classifyOperationalError } = require('../../../src/utils/error-policy');

test('classifies delivery uncertainty as non-retryable', () => {
  const result = classifyOperationalError({
    name: 'ResponseDeliveryError',
    deliveryStatus: 'uncertain',
    message: 'WAHA request timed out'
  });
  assert.equal(result.category, 'delivery_uncertain');
  assert.equal(result.retryable, false);
});

test('classifies provider timeout and network failures as retryable', () => {
  assert.equal(classifyOperationalError(new Error('Model request timed out')).retryable, true);
  assert.equal(classifyOperationalError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })).category, 'upstream_unavailable');
});

test('classifies authentication and invalid client requests as non-retryable', () => {
  assert.equal(classifyOperationalError({ response: { status: 401 } }).category, 'authentication');
  assert.equal(classifyOperationalError({ response: { status: 400 } }).retryable, false);
});

test('classifies rate limits as retryable', () => {
  assert.equal(classifyOperationalError({ response: { status: 429 } }).category, 'rate_limit');
});

test('classifies UserValidationError as non-retryable with exact userMessage', () => {
  const err = new UserValidationError('Video berdurasi 240 detik. Batas P3 adalah 180 detik.');
  assert.deepEqual(classifyOperationalError(err), {
    category: 'validation',
    retryable: false,
    userMessage: 'Video berdurasi 240 detik. Batas P3 adalah 180 detik.'
  });
});
