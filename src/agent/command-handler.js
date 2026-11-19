async function handleSlashCommand(processor, { text, msg, senderId, owner, isGroup, scope, eventId }) {
  if (text.startsWith('/approve ') || text.startsWith('/deny ')) {
    if (!owner || isGroup) {
      await processor.responseHandler.sendText('Persetujuan hanya dapat dilakukan pemilik melalui DM pribadi.', msg.chatId);
      return true;
    }
    const [command, id] = text.split(/\s+/);
    const result = await processor.approvalManager.resolve({
      id, actorId: senderId, approved: command === '/approve'
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

  if (text.toLowerCase().startsWith('/voice')) {
    if (!owner) {
      await processor.responseHandler.sendText('Pengaturan voice hanya dapat diubah oleh pemilik Bubu.', msg.chatId);
      return true;
    }
    const command = text.trim().toLowerCase();
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

  if (text === '/help') {
    await processor.responseHandler.sendText(
      '*Bubu v2 — Perintah*\n/help — Bantuan\n/status — Status layanan\n/reset — Reset riwayat chat\n/rangkum — Ringkas percakapan\n/reminder 30m pesan — Reminder sekali jalan\n/voice on|off|both|status|reset — Mode output\n/approve ID — Setujui tindakan\n/deny ID — Tolak tindakan',
      msg.chatId
    );
    return true;
  }

  if (text === '/status') {
    await processor.responseHandler.sendText(`Bubu v2 aktif.\nMode: ${scope}\nModel routing: dynamic Sumopod\nWaktu: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`, msg.chatId);
    return true;
  }

  if (text === '/reset') {
    if (!owner || isGroup) {
      await processor.responseHandler.sendText('Reset riwayat hanya dapat dilakukan pemilik melalui DM.', msg.chatId);
      return true;
    }
    processor.db.clearMessages(msg.chatId);
    await processor.responseHandler.sendText('Riwayat percakapan DM ini sudah direset.', msg.chatId);
    return true;
  }

  if (text === '/rangkum') {
    const history = processor.db.getHistory(msg.chatId, scope, 60);
    if (!history.length) {
      await processor.responseHandler.sendText('Belum ada riwayat percakapan untuk dirangkum.', msg.chatId);
      return true;
    }
    const selected = processor.router.select('summarize');
    const result = await processor.provider.chat({
      model: selected.model,
      messages: [
        { role: 'system', content: 'Ringkas percakapan dalam bahasa Indonesia. Pisahkan keputusan, informasi penting, dan tindak lanjut. Jangan mengarang.' },
        { role: 'user', content: history.map((m) => `${m.role}: ${m.content}`).join('\n') }
      ]
    });
    await processor.responseHandler.sendText(String(result.message.content || '').trim(), msg.chatId);
    return true;
  }

  if (text.startsWith('/reminder ')) {
    if (!owner || isGroup) {
      await processor.responseHandler.sendText('Reminder personal hanya dapat dibuat pemilik melalui DM.', msg.chatId);
      return true;
    }
    const match = text.match(/^\/reminder\s+((?:\d+h(?:\d+m)?|\d+m))\s+(.+)$/i);
    if (!match) {
      await processor.responseHandler.sendText('Format: /reminder 30m Pesan atau /reminder 2h30m Pesan', msg.chatId);
      return true;
    }
    const durationMs = (Number((match[1].match(/(\d+)h/i) || [])[1] || 0) * 3600000)
      + (Number((match[1].match(/(\d+)m/i) || [])[1] || 0) * 60000);
    if (!durationMs || durationMs > 365 * 86400000) {
      await processor.responseHandler.sendText('Waktu reminder tidak valid atau melebihi satu tahun.', msg.chatId);
      return true;
    }
    const id = processor.db.createReminder({
      chatId: msg.chatId, requesterId: senderId, message: match[2],
      dueAt: new Date(Date.now() + durationMs).toISOString(),
      sourceEventId: eventId
    });
    await processor.responseHandler.sendText(`Reminder #${id} tersimpan. Reminder tetap ada setelah restart.`, msg.chatId);
    return true;
  }

  return false;
}

module.exports = { handleSlashCommand };
