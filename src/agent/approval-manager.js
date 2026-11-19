const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { normalizeJid } = require('../config/env');
const { ResponseHandler } = require('../channels/response-handler');

const VALID_JID = /^[^@\s]+@(?:c\.us|g\.us|lid)$/i;

function formatApprovalPrompt({ id, toolName, args, ttlMs = null }) {
  const expiryNote = ttlMs ? `\nBerlaku ${Math.ceil(ttlMs / 60000)} menit.` : '';
  return toolName === 'send_whatsapp_file'
    ? `*Konfirmasi pengiriman file Bubu*\n\nTujuan: ${args.targetId}\nFile: ${args.filename}\nKeterangan: ${args.caption || '-'}\n\nBalas /approve ${id} untuk mengirim atau /deny ${id} untuk membatalkan.${expiryNote}`
    : `*Konfirmasi tindakan Bubu*\n\nTujuan: ${args.targetId}\nPesan:\n${args.message}\n\nBalas /approve ${id} untuk mengirim atau /deny ${id} untuk membatalkan.${expiryNote}`;
}

class ApprovalManager {
  constructor({ db, waha, responseHandler = null, ownerJid, ttlMinutes = 5 }) {
    this.db = db;
    this.waha = waha;
    this.responseHandler = responseHandler || new ResponseHandler({ waha });
    this.ownerJid = ownerJid;
    this.ttlMs = ttlMinutes * 60 * 1000;
  }

  async create({ taskId = null, chatId, requesterId, toolName, args }) {
    const id = crypto.randomBytes(4).toString('hex');
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
    this.db.createApproval({ id, taskId, chatId, requesterId, toolName, arguments: args, expiresAt });
    const prompt = formatApprovalPrompt({ id, toolName, args, ttlMs: this.ttlMs });
    return { pendingApproval: true, approvalId: id, prompt };
  }

  async resolve({ id, actorId, approved }) {
    if (actorId !== this.ownerJid) return { ok: false, reason: 'not_owner' };
    if (!approved) {
      const ok = this.db.denyApproval(id);
      return { ok, sent: false, reason: ok ? null : 'not_pending_or_expired' };
    }
    const item = this.db.claimApproval(id, actorId, this.ownerJid);
    if (!item) return { ok: false, reason: 'not_pending_or_expired' };
    if (!['send_whatsapp_message', 'send_whatsapp_file'].includes(item.tool_name)) {
      this.db.finishApproval(id, 'failed', 'Unsupported approved tool');
      return { ok: false, reason: 'unsupported_tool' };
    }
    const targetId = normalizeJid(item.arguments?.targetId);
    if (!VALID_JID.test(targetId)) {
      this.db.finishApproval(id, 'failed', 'Invalid or empty targetId');
      return { ok: false, reason: 'invalid_target' };
    }
    if (item.tool_name === 'send_whatsapp_file') {
      const filePath = String(item.arguments?.filePath || '').trim();
      if (!filePath) {
        this.db.finishApproval(id, 'failed', 'Missing filePath for approved file send');
        return { ok: false, reason: 'missing_file' };
      }
      try {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile() || stat.size <= 0) {
          this.db.finishApproval(id, 'failed', 'Approved file does not exist or is empty');
          return { ok: false, reason: 'missing_file' };
        }
      } catch (err) {
        this.db.finishApproval(id, 'failed', `Approved file is unavailable: ${err.message}`);
        return { ok: false, reason: 'missing_file' };
      }
    } else if (!String(item.arguments?.message || '').trim()) {
      this.db.finishApproval(id, 'failed', 'Approved message is empty');
      return { ok: false, reason: 'invalid_arguments' };
    }
    try {
      if (item.tool_name === 'send_whatsapp_file') {
        await this.responseHandler.sendFile(item.arguments.filePath, targetId, {
          filename: item.arguments.filename,
          mimetype: item.arguments.mimetype,
          caption: item.arguments.caption || ''
        });
      } else {
        const sendOpts = item.arguments?.replyTo ? { replyTo: item.arguments.replyTo } : undefined;
        await (sendOpts
          ? this.responseHandler.sendText(item.arguments.message, targetId, sendOpts)
          : this.responseHandler.sendText(item.arguments.message, targetId));
      }
      this.db.finishApproval(id, 'approved');
      return { ok: true, sent: true };
    } catch (error) {
      if (error?.deliveryStatus === 'failed') {
        this.db.finishApproval(id, 'failed', error.message);
        return { ok: false, reason: 'send_failed' };
      }
      // Network timeout can leave remote delivery ambiguous. Never auto-retry a send.
      this.db.finishApproval(id, 'uncertain', error.message);
      return { ok: false, reason: 'send_result_uncertain' };
    }
  }
}

module.exports = { ApprovalManager, formatApprovalPrompt };
