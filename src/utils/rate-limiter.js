class SlidingWindowRateLimiter {
  constructor({ limit = 10, windowMs = 60000, maxKeys = 5000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.entries = new Map();
  }

  consume(key, now = Date.now()) {
    const current = (this.entries.get(key) || []).filter((ts) => now - ts < this.windowMs);
    if (current.length >= this.limit) {
      this.entries.set(key, current);
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, this.windowMs - (now - current[0])) };
    }
    current.push(now);
    this.entries.set(key, current);
    if (this.entries.size > this.maxKeys) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }
    return { allowed: true, remaining: this.limit - current.length, retryAfterMs: 0 };
  }
}

module.exports = { SlidingWindowRateLimiter };
