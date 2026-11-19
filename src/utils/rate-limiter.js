class SlidingWindowRateLimiter {
  constructor({ limit = 10, windowMs = 60000, maxKeys = 5000 } = {}) {
    this.limit = Number.isFinite(Number(limit)) ? Number(limit) : 10;
    this.windowMs = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0 ? Number(windowMs) : 60000;
    this.maxKeys = Number.isFinite(Number(maxKeys)) && Number(maxKeys) > 0 ? Math.floor(Number(maxKeys)) : 5000;
    this.entries = new Map();
  }

  consume(key, now = Date.now()) {
    if (!(this.limit > 0)) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, this.windowMs) };
    }
    const existing = this.entries.get(key) || [];
    const current = existing.filter((ts) => now - ts < this.windowMs);
    if (current.length >= this.limit) {
      this.entries.delete(key);
      this.entries.set(key, current);
      const retryAfterMs = current.length
        ? Math.max(1, this.windowMs - (now - current[0]))
        : Math.max(1, this.windowMs);
      return { allowed: false, remaining: 0, retryAfterMs };
    }
    current.push(now);
    this.entries.delete(key);
    this.entries.set(key, current);
    if (this.entries.size > this.maxKeys) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }
    return { allowed: true, remaining: this.limit - current.length, retryAfterMs: 0 };
  }
}

module.exports = { SlidingWindowRateLimiter };
