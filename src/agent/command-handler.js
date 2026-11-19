const MAX_RANGKUM_CHARS = 24000;
const MAX_REMINDER_CHARS = 500;

const RECOGNIZED_SLASH_COMMANDS = new Set([
  '/approve',
  '/deny',
  '/voice',
  '/help',
  '/status',
  '/reset',
  '/rangkum',
  '/reminder'
]);

function extractSlashCommand(text = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return '';
  return trimmed.split(/\s+/, 1)[0].toLowerCase();
}

function isRecognizedSlashCommand(text = '') {
  return RECOGNIZED_SLASH_COMMANDS.has(extractSlashCommand(text));
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

async function handleSlashCommand(processor, { text, msg, senderId, owner, isGroup, scope, eventId }) {
  const trimmed = String(text || '').trim();
  const cmd = extractSlashCommand(trimmed);
  if (!cmd) return false;

  if (cmd === '/approve' || cmd === '/deny') {
    if (!owner || isGroup) {
      await processor.responseHandler.sendText('Persetujuan hanya dapat dilakukan pemilik melalui DM pribadi.', msg.chatId);
      return true;
    }
    const [, id] = trimmed.split(/\s+/);
    if (!id) {
      await processor.responseHandler.sendText('Format: /approve <id> atau /deny <id>.', msg.chatId);
      return true;
    }
    const result = await processor.approvalManager.resolve({
      id, actorId: senderId, approved: cmd === '/approve'
    });
    const approvalReply = result.ok
      ? (result.sent ? `Persetujuan ${id} berhasil. File/pesan sudah dikirim.` : `Persetujuan ${id} berhasil dibatalkan.`)
      : `Persetujuan tidak dapat diproses: ${result.reason}.`;
    await processor.responseHandler.sendText(approvalReply, msg.chatId);
    if (result.ok) {
      processor.db.addMessage({
        chatId: msg.chatId,
        scope,
        role: 'assistant',
        content: approvalReply,
        eventId
      });
    }
    return true;
  }

  if (cmd === '/voice') {
    if (!owner) {
      await processor.responseHandler.sendText('Pengaturan voice hanya dapat diubah oleh pemilik Bubu.', msg.chatId);
      return true;
    }
    const command = trimmed.toLowerCase();
    const preferenceKey = { chatId: msg.chatId, requesterId: processor.config.ownerJid };
    if (command === '/voice on' || command === '/voice both') {
      if (!processor.config.media.enabled || !processor.mediaService || !processor.config.media.piperModelPath) {
        await processor.responseHandler.sendText(
          'Voice reply belum siap. Pastikan MEDIA_INTELLIGENCE_ENABLED aktif, PIPER_MODEL_PATH terisi, serta Piper dan FFmpeg tersedia.',
          msg.chatId
        );
        return true;
      }
      const mode = command === '/voice on' ? 'voice' : 'both';
      processor.db.setChatOutputMode({ ...preferenceKey, mode });
      await processor.sendConfiguredResponse(
        mode === 'voice'
          ? 'Mode voice-only aktif untuk chat ini. Bubu hanya akan mengirim voice note sebagai jawaban.'
          : 'Mode text + voice aktif untuk chat ini.',
        msg.chatId,
        mode
      );
      return true;
    }
    if (command === '/voice off') {
      processor.db.setChatOutputMode({ ...preferenceKey, mode: 'text' });
      await processor.responseHandler.sendText('Mode text-only aktif untuk chat ini.', msg.chatId);
      return true;
    }
    if (command === '/voice reset') {
      processor.db.resetChatOutputMode(preferenceKey);
      const defaultMode = processor.config.media.voiceReplyDefault ? 'both' : 'text';
      const labels = { text: 'text-only', voice: 'voice-only', both: 'text + voice' };
      await processor.sendConfiguredResponse(
        `Preferensi khusus chat dihapus. Mode sekarang mengikuti default Bubu: ${labels[defaultMode]}.`,
        msg.chatId,
        defaultMode
      );
      return true;
    }
    if (command === '/voice status' || command === '/voice') {
      const defaultMode = processor.config.media.voiceReplyDefault ? 'both' : 'text';
      const preference = processor.db.getChatOutputPreference({
        ...preferenceKey, defaultMode
      });
      const labels = { text: 'text-only', voice: 'voice-only', both: 'text + voice' };
      const source = preference.isCustom ? 'preferensi khusus chat' : 'default konfigurasi Bubu';
      await processor.sendConfiguredResponse(
        `Mode output chat ini: ${labels[preference.mode] || labels.text}.\nSumber: ${source}.\nPerintah: /voice on, /voice off, /voice both, /voice status, /voice reset.`,
        msg.chatId,
        preference.mode
      );
      return true;
    }
    await processor.responseHandler.sendText(
      'Format: /voice on (voice-only), /voice off (text-only), /voice both (teks + suara), /voice status, /voice reset.',
      msg.chatId
    );
    return true;
  }

  if (cmd === '/help') {
    await processor.responseHandler.sendText(
      '*Bubu v2 — Perintah*\n/help — Bantuan\n/status — Status layanan\n/reset — Reset riwayat chat\n/rangkum — Ringkas percakapan\n/reminder 30m pesan — Reminder sekali jalan\n/voice on|off|both|status|reset — Mode output\n/approve ID — Setujui tindakan\n/deny ID — Tolak tindakan',
      msg.chatId
    );
    return true;
  }

  if (cmd === '/status') {
    const lines = [
      'Bubu v2 aktif.',
      `Mode: ${scope}`,
      `Agent: ${processor.config?.agent?.enabled === false ? 'nonaktif' : 'aktif'}`,
      'Model routing: dynamic Sumopod'
    ];
    if (typeof processor.sessionMonitor?.snapshot === 'function') {
      const snap = processor.sessionMonitor.snapshot();
      lines.push(`WAHA session (${snap.session}): ${snap.status}${snap.degraded ? ' [terdegradasi]' : ''}`);
    }
    lines.push(`Waktu: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`);
    await processor.responseHandler.sendText(lines.join('\n'), msg.chatId);
    return true;
  }

  if (cmd === '/reset') {
    if (!owner || isGroup) {
      await processor.responseHandler.sendText('Reset riwayat hanya dapat dilakukan pemilik melalui DM.', msg.chatId);
      return true;
    }
    processor.db.clearMessages(msg.chatId);
    await processor.responseHandler.sendText('Riwayat percakapan DM ini sudah direset.', msg.chatId);
    return true;
  }

  if (cmd === '/rangkum') {
    if (processor.config?.agent?.enabled === false) {
      await processor.responseHandler.sendText('Bubu Agent sedang dinonaktifkan.', msg.chatId);
      return true;
    }
    const history = processor.db.getHistory(msg.chatId, scope, 60);
    if (!history.length) {
      await processor.responseHandler.sendText('Belum ada riwayat percakapan untuk dirangkum.', msg.chatId);
      return true;
    }
    const transcript = history
      .map((m) => `${m.role}${m.sender ? ` (${m.sender})` : ''}: ${String(m.content || '').slice(0, 1500)}`)
      .join('\n')
      .slice(-MAX_RANGKUM_CHARS);
    const selected = processor.router.select('summarize');
    const started = Date.now();
    const timeoutMs = processor.config?.agent?.taskTimeoutMs || 30000;
    const result = await withTimeout(
      processor.provider.chat({
        model: selected.model,
        maxTokens: Math.min(2000, processor.config?.agent?.maxOutputTokens || 1800),
        messages: [
          { role: 'system', content: 'Ringkas percakapan dalam bahasa Indonesia. Pisahkan keputusan, informasi penting, dan tindak lanjut. Jangan mengarang.' },
          { role: 'user', content: transcript }
        ]
      }),
      timeoutMs,
      'Rangkum request'
    );
    processor.db?.logModelUsage?.({
      taskId: null,
      modelId: result?.model || selected.model,
      tier: selected.tier || 'summary',
      usage: result?.usage || null,
      latencyMs: Date.now() - started,
      outcome: 'success'
    });
    const summaryText = String(result?.message?.content || '').trim() || 'Tidak ada ringkasan yang dihasilkan.';
    await processor.responseHandler.sendText(summaryText, msg.chatId);
    return true;
  }

  if (cmd === '/reminder') {
    if (!owner || isGroup) {
      await processor.responseHandler.sendText('Reminder personal hanya dapat dibuat pemilik melalui DM.', msg.chatId);
      return true;
    }
    const match = trimmed.match(/^\/reminder\s+((?:\d+h(?:\d+m)?|\d+m))\s+(.+)$/is);
    if (!match) {
      await processor.responseHandler.sendText('Format: /reminder 30m Pesan atau /reminder 2h30m Pesan', msg.chatId);
      return true;
    }
    const reminderMessage = match[2].trim();
    if (!reminderMessage || reminderMessage.length > MAX_REMINDER_CHARS) {
      await processor.responseHandler.sendText(`Pesan reminder harus 1–${MAX_REMINDER_CHARS} karakter.`, msg.chatId);
      return true;
    }
    const durationMs = (Number((match[1].match(/(\d+)h/i) || [])[1] || 0) * 3600000)
      + (Number((match[1].match(/(\d+)m/i) || [])[1] || 0) * 60000);
    if (!durationMs || durationMs > 365 * 86400000) {
      await processor.responseHandler.sendText('Waktu reminder tidak valid atau melebihi satu tahun.', msg.chatId);
      return true;
    }
    const id = processor.db.createReminder({
      chatId: msg.chatId, requesterId: senderId, message: reminderMessage,
      dueAt: new Date(Date.now() + durationMs).toISOString(),
      sourceEventId: eventId
    });
    await processor.responseHandler.sendText(`Reminder #${id} tersimpan. Reminder tetap ada setelah restart.`, msg.chatId);
    return true;
  }

  return false;
}

module.exports = {
  RECOGNIZED_SLASH_COMMANDS,
  extractSlashCommand,
  isRecognizedSlashCommand,
  handleSlashCommand
};
