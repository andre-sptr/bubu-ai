const test = require('node:test');
const assert = require('node:assert/strict');
const { SlidingWindowRateLimiter } = require('../../../src/utils/rate-limiter');

test('allows messages within configured window and blocks excess', () => {
  const limiter = new SlidingWindowRateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.consume('u', 100).allowed, true);
  assert.equal(limiter.consume('u', 200).allowed, true);
  assert.equal(limiter.consume('u', 300).allowed, false);
  assert.equal(limiter.consume('u', 1200).allowed, true);
});

test('refreshes LRU order on access so active keys are not evicted before idle keys', () => {
  const limiter = new SlidingWindowRateLimiter({ limit: 2, windowMs: 10000, maxKeys: 2 });
  assert.equal(limiter.consume('a', 100).allowed, true);
  assert.equal(limiter.consume('b', 200).allowed, true);
  // Access 'a' again so 'b' becomes the least-recently-used key
  assert.equal(limiter.consume('a', 300).allowed, true);
  // Throttled access on 'a' also keeps 'a' fresh
  assert.equal(limiter.consume('a', 400).allowed, false);
  // Adding 'c' should evict 'b', keeping 'a' throttled
  assert.equal(limiter.consume('c', 500).allowed, true);
  assert.equal(limiter.entries.has('b'), false);
  assert.equal(limiter.entries.has('a'), true);
  assert.equal(limiter.consume('a', 600).allowed, false);
});

test('guards limit <= 0 and NaN without returning NaN retryAfterMs', () => {
  for (const badLimit of [0, -1]) {
    const limiter = new SlidingWindowRateLimiter({ limit: badLimit, windowMs: 5000 });
    const res = limiter.consume('u', 1000);
    assert.equal(res.allowed, false);
    assert.equal(res.remaining, 0);
    assert.equal(Number.isFinite(res.retryAfterMs), true);
    assert.equal(res.retryAfterMs, 5000);
  }
  const nanLimiter = new SlidingWindowRateLimiter({ limit: Number.NaN, windowMs: 5000 });
  const nanRes = nanLimiter.consume('u', 1000);
  assert.equal(nanRes.allowed, true);
  assert.equal(Number.isFinite(nanRes.retryAfterMs), true);
});
