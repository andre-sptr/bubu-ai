class AsyncSemaphore {
  constructor({
    concurrency = 1,
    maxQueue = 10,
    acquireTimeoutMs = 60000,
    busyMessage = 'Processor sedang sibuk. Silakan coba kembali beberapa saat lagi.'
  } = {}) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.maxQueue = Math.max(0, Number(maxQueue) || 0);
    this.acquireTimeoutMs = Math.max(100, Number(acquireTimeoutMs) || 60000);
    this.busyMessage = String(busyMessage || 'Processor sedang sibuk.');
    this._active = 0;
    this._queue = [];
  }

  get activeCount() {
    return this._active;
  }

  get pendingCount() {
    return this._queue.length;
  }

  get isBusy() {
    return this._active >= this.concurrency;
  }

  _makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._active = Math.max(0, this._active - 1);
      while (this._queue.length > 0 && this._active < this.concurrency) {
        const next = this._queue.shift();
        if (!next || next.settled) continue;
        next.settled = true;
        if (next.timer) clearTimeout(next.timer);
        this._active += 1;
        next.resolve(this._makeRelease());
        break;
      }
    };
  }

  async acquire(timeoutMs = this.acquireTimeoutMs) {
    if (this._active < this.concurrency) {
      this._active += 1;
      return this._makeRelease();
    }
    if (this._queue.length >= this.maxQueue) {
      throw new Error(this.busyMessage);
    }

    const waitMs = Math.max(50, Number(timeoutMs) || this.acquireTimeoutMs);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, settled: false, timer: null };
      entry.timer = setTimeout(() => {
        if (entry.settled) return;
        entry.settled = true;
        const idx = this._queue.indexOf(entry);
        if (idx !== -1) this._queue.splice(idx, 1);
        reject(new Error(this.busyMessage));
      }, waitMs);
      entry.timer.unref?.();
      this._queue.push(entry);
    });
  }

  async run(fn, timeoutMs = this.acquireTimeoutMs) {
    const release = await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

module.exports = { AsyncSemaphore };
