const test = require('node:test');
const assert = require('node:assert/strict');
const { SlidingWindowRateLimiter } = require('../../src/agent/rate-limiter');

test('allows messages within configured window and blocks excess', () => {
  const limiter = new SlidingWindowRateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.consume('u', 100).allowed, true);
  assert.equal(limiter.consume('u', 200).allowed, true);
  assert.equal(limiter.consume('u', 300).allowed, false);
  assert.equal(limiter.consume('u', 1200).allowed, true);
});
