const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { normalizeJid } = require('../config/env');
const { ResponseHandler } = require('../channels/response-handler');

const VALID_JID = /^[^@\s]+@(?:c\.us|g\.us|lid)$/i;
const APPROVED_TOOLS = new Set([
  'send_whatsapp_message',
  'send_whatsapp_file',
  'send_whatsapp_poll',
  'send_whatsapp_location',
  'send_whatsapp_contact'
]);

function formatApprovalPrompt({ id, toolName, args = {}, ttlMs = null }) {
  const expiryNote = ttlMs ? `\nBerlaku ${Math.ceil(ttlMs / 60000)} menit.` : '';
  if (toolName === 'send_whatsapp_file') {
    return `*Konfirmasi pengiriman file Bubu*\n\nTujuan: ${args.targetId}\nFile: ${args.filename}\nKeterangan: ${args.caption || '-'}\n\nBalas /approve ${id} untuk mengirim atau /deny ${id} untuk membatalkan.${expiryNote}`;
  }
  if (toolName === 'send_whatsapp_poll') {
    const question = args.question ?? args.name ?? '';
    const optionsList = Array.isArray(args.options) ? args.options.join(', ') : '';
    return `*Konfirmasi pengiriman polling Bubu*\n\nTujuan: ${args.targetId}\nPertanyaan: ${question}\nOpsi: ${optionsList}\n\nBalas /approve ${id} untuk mengirim atau /deny ${id} untuk membatalkan.${expiryNote}`;
  }
  if (toolName === 'send_whatsapp_location') {
    return `*Konfirmasi pengiriman lokasi Bubu*\n\nTujuan: ${args.targetId}\nKoordinat: ${args.latitude}, ${args.longitude}\nLabel: ${args.title || '-'}\n\nBalas /approve ${id} untuk mengirim atau /deny ${id} untuk membatalkan.${expiryNote}`;
  }
  if (toolName === 'send_whatsapp_contact') {
    return `*Konfirmasi pengiriman kontak Bubu*\n\nTujuan: ${args.targetId}\nNama: ${args.fullName}\nTelepon: ${args.phoneNumber}${args.organization ? `\nOrganisasi: ${args.organization}` : ''}\n\nBalas /approve ${id} untuk mengirim atau /deny ${id} untuk membatalkan.${expiryNote}`;
  }
  return `*Konfirmasi tindakan Bubu*\n\nTujuan: ${args.targetId}\nPesan:\n${args.message}\n\nBalas /approve ${id} untuk mengirim atau /deny ${id} untuk membatalkan.${expiryNote}`;
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
    if (!APPROVED_TOOLS.has(item.tool_name)) {
      this.db.finishApproval(id, 'failed', 'Unsupported approved tool');
      return { ok: false, reason: 'unsupported_tool' };
    }
    const targetId = normalizeJid(item.arguments?.targetId);
    if (!VALID_JID.test(targetId)) {
      this.db.finishApproval(id, 'failed', 'Invalid or empty targetId');
      return { ok: false, reason: 'invalid_target' };
    }

    let pollPayload = null;
    let locationPayload = null;
    let contactPayload = null;

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
    } else if (item.tool_name === 'send_whatsapp_poll') {
      const pollQuestion = String(item.arguments?.question ?? item.arguments?.name ?? '').trim();
      const rawOptions = Array.isArray(item.arguments?.options) ? item.arguments.options : [];
      const cleanedOptions = rawOptions.map((o) => String(o ?? '').trim()).filter(Boolean);
      const uniqueCount = new Set(cleanedOptions.map((o) => o.toLowerCase())).size;
      if (
        !pollQuestion ||
        rawOptions.length < 2 ||
        rawOptions.length > 12 ||
        cleanedOptions.length !== rawOptions.length ||
        uniqueCount !== cleanedOptions.length
      ) {
        this.db.finishApproval(id, 'failed', 'Approved poll requires a question and 2-12 unique options');
        return { ok: false, reason: 'invalid_arguments' };
      }
      pollPayload = {
        name: pollQuestion,
        options: cleanedOptions,
        multipleAnswers: Boolean(item.arguments?.multipleAnswers),
        ...(item.arguments?.replyTo ? { replyTo: item.arguments.replyTo } : {})
      };
    } else if (item.tool_name === 'send_whatsapp_location') {
      const lat = item.arguments?.latitude;
      const lon = item.arguments?.longitude;
      if (
        typeof lat !== 'number' ||
        typeof lon !== 'number' ||
        !Number.isFinite(lat) ||
        lat < -90 ||
        lat > 90 ||
        !Number.isFinite(lon) ||
        lon < -180 ||
        lon > 180
      ) {
        this.db.finishApproval(id, 'failed', 'Approved location requires finite latitude (-90..90) and longitude (-180..180)');
        return { ok: false, reason: 'invalid_arguments' };
      }
      locationPayload = {
        latitude: lat,
        longitude: lon,
        title: item.arguments?.title ? String(item.arguments.title).trim() : '',
        ...(item.arguments?.replyTo ? { replyTo: item.arguments.replyTo } : {})
      };
    } else if (item.tool_name === 'send_whatsapp_contact') {
      const fullName = String(item.arguments?.fullName || '').trim();
      const phoneNumber = String(item.arguments?.phoneNumber || '').trim();
      const digits = phoneNumber.replace(/\D/g, '');
      if (!fullName || digits.length < 6 || digits.length > 20) {
        this.db.finishApproval(id, 'failed', 'Approved contact requires fullName and a valid phoneNumber (6-20 digits)');
        return { ok: false, reason: 'invalid_arguments' };
      }
      const organization = String(item.arguments?.organization || '').trim();
      contactPayload = {
        contact: {
          fullName,
          phoneNumber,
          ...(organization ? { organization } : {})
        },
        options: item.arguments?.replyTo ? { replyTo: item.arguments.replyTo } : {}
      };
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
      } else if (item.tool_name === 'send_whatsapp_poll') {
        await this.responseHandler.sendPoll(targetId, pollPayload);
      } else if (item.tool_name === 'send_whatsapp_location') {
        await this.responseHandler.sendLocation(targetId, locationPayload);
      } else if (item.tool_name === 'send_whatsapp_contact') {
        await this.responseHandler.sendContactVcard(targetId, [contactPayload.contact], contactPayload.options);
      } else {
        const sendOpts = {};
        if (item.arguments?.replyTo) sendOpts.replyTo = item.arguments.replyTo;
        if (Array.isArray(item.arguments?.mentions) && item.arguments.mentions.length > 0) {
          sendOpts.mentions = item.arguments.mentions;
        }
        const hasSendOpts = Object.keys(sendOpts).length > 0;
        await (hasSendOpts
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

module.exports = { ApprovalManager, formatApprovalPrompt, APPROVED_TOOLS };
