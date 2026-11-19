const WAHA_SESSION_STATUSES = Object.freeze([
  'UNKNOWN',
  'WORKING',
  'STARTING',
  'SCAN_QR_CODE',
  'STOPPED',
  'FAILED'
]);

const DEGRADED_STATUSES = new Set(['FAILED', 'STOPPED', 'SCAN_QR_CODE']);

function normalizeSessionState(status) {
  const normalized = String(status || '').trim().toUpperCase();
  return normalized || 'UNKNOWN';
}

class WahaSessionMonitor {
  constructor({ session = 'default', status = 'UNKNOWN' } = {}) {
    this.session = String(session || 'default');
    this.status = normalizeSessionState(status);
    this.updatedAt = null;
  }

  update({ session, status } = {}) {
    const previousStatus = this.status;
    if (session) this.session = String(session);
    this.status = normalizeSessionState(status);
    this.updatedAt = new Date().toISOString();
    return {
      session: this.session,
      status: this.status,
      previousStatus,
      changed: previousStatus !== this.status,
      degraded: this.isDegraded(),
      updatedAt: this.updatedAt
    };
  }

  isDegraded() {
    return DEGRADED_STATUSES.has(this.status);
  }

  isHealthy() {
    return !this.isDegraded();
  }

  snapshot() {
    return {
      session: this.session,
      status: this.status,
      healthy: this.isHealthy(),
      degraded: this.isDegraded(),
      updatedAt: this.updatedAt
    };
  }
}

module.exports = { WahaSessionMonitor, WAHA_SESSION_STATUSES, DEGRADED_STATUSES };
