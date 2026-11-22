const { normalizeJid } = require('../../config/env');

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

function extractIdentityString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    if (typeof value._serialized === 'string' && value._serialized.trim()) return value._serialized.trim();
    if (typeof value.id === 'string' && value.id.trim()) return value.id.trim();
    if (value.id && typeof value.id === 'object') return extractIdentityString(value.id);
    if (typeof value.jid === 'string' && value.jid.trim()) return value.jid.trim();
    if (typeof value.user === 'string' && value.user.trim()) {
      const server = typeof value.server === 'string' && value.server.trim() ? value.server.trim() : '';
      return server ? `${value.user.trim()}@${server}` : value.user.trim();
    }
  }
  return '';
}

function normalizeBotLid(value) {
  const raw = extractIdentityString(value).toLowerCase();
  if (!raw) return '';
  if (raw.includes('@')) {
    const normalized = normalizeJid(raw);
    return normalized.endsWith('@lid') ? normalized : '';
  }
  const bare = raw.split(':')[0].trim();
  return bare && !/\s/.test(bare) ? `${bare}@lid` : '';
}

class WahaSessionMonitor {
  constructor({ session = 'default', status = 'UNKNOWN', botJid = '', botLid = '' } = {}) {
    this.session = String(session || 'default');
    this.status = normalizeSessionState(status);
    this.botJid = botJid ? normalizeJid(extractIdentityString(botJid)) : '';
    this.botLid = normalizeBotLid(botLid);
    this.ownerLid = '';
    this.updatedAt = null;
  }

  rememberOwnerLid(lid) {
    const normalized = normalizeBotLid(lid);
    if (normalized) {
      this.ownerLid = normalized;
    }
    return this.ownerLid;
  }

  getOwnerLid() {
    return this.ownerLid;
  }

  update({ session, status, me } = {}) {
    const previousStatus = this.status;
    if (session) this.session = String(session);
    this.status = normalizeSessionState(status);
    if (me && typeof me === 'object') {
      this.updateBotIdentity(me);
    }
    this.updatedAt = new Date().toISOString();
    return {
      session: this.session,
      status: this.status,
      previousStatus,
      changed: previousStatus !== this.status,
      degraded: this.isDegraded(),
      botJid: this.botJid,
      botLid: this.botLid,
      updatedAt: this.updatedAt
    };
  }

  updateBotIdentity(identity = {}) {
    if (!identity || typeof identity !== 'object') {
      return { botJid: this.botJid, botLid: this.botLid, changed: false };
    }
    const rawId = extractIdentityString(identity.id ?? identity._serialized ?? identity.jid ?? identity.botJid);
    const nextJid = rawId ? normalizeJid(rawId) : '';
    const nextLid = normalizeBotLid(identity.lid ?? identity.botLid ?? '');
    let changed = false;
    if (nextJid && nextJid !== this.botJid) {
      this.botJid = nextJid;
      changed = true;
    }
    if (nextLid && nextLid !== this.botLid) {
      this.botLid = nextLid;
      changed = true;
    }
    if (changed) {
      this.updatedAt = new Date().toISOString();
    }
    return {
      botJid: this.botJid,
      botLid: this.botLid,
      changed
    };
  }

  getBotIdentities() {
    return {
      botJid: this.botJid,
      botLid: this.botLid
    };
  }

  async syncFromWaha(waha, { logger } = {}) {
    if (!waha || (typeof waha.sessionStatus !== 'function' && typeof waha.getMe !== 'function')) {
      logger?.warn?.('WAHA client unavailable for session sync');
      return { ok: false, snapshot: this.snapshot() };
    }
    try {
      let sessionInfo = null;
      if (typeof waha.sessionStatus === 'function') {
        sessionInfo = await waha.sessionStatus();
        this.update({
          session: sessionInfo?.name || sessionInfo?.session || this.session,
          status: sessionInfo?.status ?? this.status
        });
      }

      let me = sessionInfo?.me && typeof sessionInfo.me === 'object' ? sessionInfo.me : null;
      const hasMeIdentity = Boolean(
        me && (extractIdentityString(me.id ?? me._serialized ?? me.jid) || extractIdentityString(me.lid))
      );
      if (!hasMeIdentity && typeof waha.getMe === 'function') {
        try {
          const meResult = await waha.getMe();
          const candidate = meResult?.me && typeof meResult.me === 'object' ? meResult.me : meResult;
          if (candidate && typeof candidate === 'object') {
            me = candidate;
          }
        } catch (err) {
          logger?.warn?.({ error: err?.message }, 'WAHA getMe fallback failed during session sync');
          if (typeof waha.sessionStatus !== 'function') {
            return { ok: false, snapshot: this.snapshot() };
          }
        }
      }

      if (me && typeof me === 'object') {
        this.updateBotIdentity(me);
      }
      return { ok: true, snapshot: this.snapshot() };
    } catch (err) {
      logger?.warn?.({ error: err?.message }, 'WAHA startup session sync failed');
      return { ok: false, snapshot: this.snapshot() };
    }
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
      botJid: this.botJid,
      botLid: this.botLid,
      updatedAt: this.updatedAt
    };
  }
}

module.exports = { WahaSessionMonitor, WAHA_SESSION_STATUSES, DEGRADED_STATUSES };
