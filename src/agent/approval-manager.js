const crypto = require('node:crypto');
const { ResponseHandler } = require('../channels/response-handler');

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
    const prompt = toolName === 'send_whatsapp_file'
      ? `*Konfirmasi pengiriman file Bubu*\n\nTujuan: ${args.targetId}\nFile: ${args.filename}\nKeterangan: ${args.caption || '-'}\n\nBalas /approve ${id} untuk mengirim atau /deny ${id} untuk membatalkan.\nBerlaku ${Math.ceil(this.ttlMs / 60000)} menit.`
      : `*Konfirmasi tindakan Bubu*\n\nTujuan: ${args.targetId}\nPesan:\n${args.message}\n\nBalas /approve ${id} untuk mengirim atau /deny ${id} untuk membatalkan.\nBerlaku ${Math.ceil(this.ttlMs / 60000)} menit.`;
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
    if (!['send_whatsapp_message','send_whatsapp_file'].includes(item.tool_name)) {
      this.db.finishApproval(id, 'failed', 'Unsupported approved tool');
      return { ok: false, reason: 'unsupported_tool' };
    }
    try {
      if (item.tool_name === 'send_whatsapp_file') {
        await this.responseHandler.sendFile(item.arguments.filePath, item.arguments.targetId, {
          filename: item.arguments.filename,
          mimetype: item.arguments.mimetype,
          caption: item.arguments.caption || ''
        });
      } else {
        await this.responseHandler.sendText(item.arguments.message, item.arguments.targetId);
      }
      this.db.finishApproval(id, 'approved');
      return { ok: true, sent: true };
    } catch (error) {
      // Network timeout can leave remote delivery ambiguous. Never auto-retry a send.
      this.db.finishApproval(id, 'uncertain', error.message);
      return { ok: false, reason: 'send_result_uncertain' };
    }
  }
}

module.exports = { ApprovalManager };
