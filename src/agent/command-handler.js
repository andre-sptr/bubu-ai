const { normalizeRecurrence, parseNextWallClockIso } = require('../utils/recurrence');

const MAX_RANGKUM_CHARS = 24000;
const MAX_REMINDER_CHARS = 500;

const RECOGNIZED_SLASH_COMMANDS = new Set([
  '/approve',
  '/deny',
  '/approvals',
  '/voice',
  '/help',
  '/status',
  '/reset',
  '/rangkum',
  '/reminder',
  '/polls',
  '/memory',
  '/queue',
  '/usage'
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

async function handleQueueCommand(processor, { trimmed, msg, owner }) {
  if (!owner) {
    await processor.responseHandler.sendText('Perintah /queue hanya dapat diakses oleh pemilik Bubu.', msg.chatId);
    return true;
  }

  const parts = trimmed.split(/\s+/);
  const sub = (parts[1] || 'status').toLowerCase();
  const arg = parts[2] || '';

  if (sub === 'status') {
    const workerStats = typeof processor.worker?.getStats === 'function'
      ? processor.worker.getStats()
      : null;
    const queueStats = workerStats?.queue || (typeof processor.db?.getQueueStats === 'function'
      ? processor.db.getQueueStats()
      : null);
    const telemetry = typeof processor.db?.getTelemetrySummary === 'function'
      ? processor.db.getTelemetrySummary({ windowHours: 24 })
      : null;

    if (!queueStats && !telemetry && !workerStats) {
      await processor.responseHandler.sendText('Statistik antrean belum tersedia.', msg.chatId);
      return true;
    }

    const lines = ['*Status Antrean & Telemetri Bubu*'];
    if (workerStats) {
      lines.push(`Worker: ${workerStats.healthy ? 'sehat' : 'berhenti'} (${workerStats.activeCount}/${workerStats.maxConcurrentJobs} slot aktif)`);
    }
    if (queueStats) {
      lines.push(
        `Antrean — Pending: ${queueStats.pendingCount ?? 0} | Processing: ${queueStats.processingCount ?? 0} | Failed: ${queueStats.failedCount ?? 0} | Dead: ${queueStats.deadCount ?? 0} | Completed: ${queueStats.completedCount ?? 0}`
      );
      if (queueStats.oldestPendingAt) {
        lines.push(`Pending tertua: ${queueStats.oldestPendingAt}`);
      }
    }
    if (telemetry) {
      lines.push(
        `Telemetri (${telemetry.windowHours}j) — Calls: ${telemetry.totalCalls ?? 0} (sukses ${telemetry.successCalls ?? 0}) | Tokens: ${telemetry.totalInputTokens ?? 0} in / ${telemetry.totalOutputTokens ?? 0} out | Avg latency: ${telemetry.avgLatencyMs ?? 0} ms`
      );
      const tierEntries = Object.entries(telemetry.byTier || {});
      if (tierEntries.length > 0) {
        const tierSummary = tierEntries
          .map(([tier, info]) => {
            const calls = typeof info === 'object' ? (info?.calls ?? 0) : Number(info || 0);
            return `${tier}=${calls}`;
          })
          .join(', ');
        lines.push(`Tier: ${tierSummary}`);
      }
      if (Number.isFinite(telemetry.estimatedCostUsd)) {
        const usdStr = Number(telemetry.estimatedCostUsd).toFixed(4);
        const idrStr = Number(telemetry.estimatedCostIdr || 0).toLocaleString('id-ID');
        lines.push(`Estimasi biaya (${telemetry.windowHours}j): ~$${usdStr} (~Rp ${idrStr})`);
      }
    }
    lines.push('Perintah: /queue status, /queue dead, /queue retry <eventId>, /queue prune.');
    await processor.responseHandler.sendText(lines.join('\n'), msg.chatId);
    return true;
  }

  if (sub === 'dead') {
    if (typeof processor.db?.listDeadEvents !== 'function') {
      await processor.responseHandler.sendText('Daftar dead-letter queue belum tersedia.', msg.chatId);
      return true;
    }
    const items = processor.db.listDeadEvents({ limit: 10 }) || [];
    if (!items.length) {
      await processor.responseHandler.sendText('Tidak ada event di dead-letter queue.', msg.chatId);
      return true;
    }
    const lines = items.slice(0, 10).map((item) => {
      const err = String(item.last_error || 'unknown').replace(/\s+/g, ' ').slice(0, 100);
      return `• ${item.event_id} | chat: ${item.chat_id} | prio: ${item.priority ?? 5} | attempts: ${item.attempts} | ${err}`;
    });
    await processor.responseHandler.sendText(
      `*Dead-Letter Queue (${items.length})*\n${lines.join('\n')}\nGunakan /queue retry <eventId> untuk mencoba ulang.`,
      msg.chatId
    );
    return true;
  }

  if (sub === 'retry') {
    if (!arg) {
      await processor.responseHandler.sendText('Format: /queue retry <eventId>', msg.chatId);
      return true;
    }
    if (typeof processor.db?.requeueDeadEvent !== 'function') {
      await processor.responseHandler.sendText('Fitur retry antrean belum tersedia.', msg.chatId);
      return true;
    }
    const res = processor.db.requeueDeadEvent(arg);
    if (res?.requeued) {
      await processor.responseHandler.sendText(
        `Event ${res.eventId || arg} berhasil dimasukkan kembali ke antrean (pending).`,
        msg.chatId
      );
      return true;
    }
    const reasonMessages = {
      delivery_uncertain: `Event ${arg} ditolak untuk retry otomatis karena berstatus delivery_uncertain (risiko duplikasi pengiriman WhatsApp). Periksa chat secara manual.`,
      not_dead_or_failed: `Event ${arg} tidak dalam status dead/failed sehingga tidak dapat di-retry.`,
      not_found: `Event ${arg} tidak ditemukan di antrean.`
    };
    const msgText = reasonMessages[res?.reason] || `Event ${arg} tidak dapat di-retry: ${res?.reason || 'unknown'}.`;
    await processor.responseHandler.sendText(msgText, msg.chatId);
    return true;
  }

  if (sub === 'prune') {
    if (typeof processor.db?.pruneHistoryAndQueue !== 'function') {
      await processor.responseHandler.sendText('Fitur pembersihan riwayat antrean belum tersedia.', msg.chatId);
      return true;
    }
    const res = processor.db.pruneHistoryAndQueue();
    const lines = [
      'Pembersihan antrean & riwayat selesai.',
      `Completed events dihapus: ${res?.deletedCompletedEvents ?? 0}`,
      `Dead events dihapus: ${res?.deletedDeadEvents ?? 0}`,
      `Model usage dihapus: ${res?.deletedModelUsage ?? 0}`,
      `Audit logs dihapus: ${res?.deletedAuditLogs ?? 0}`
    ];
    if (res?.deletedTasks) lines.push(`Tasks dihapus: ${res.deletedTasks}`);
    if (res?.deletedApprovals) lines.push(`Approvals dihapus: ${res.deletedApprovals}`);
    await processor.responseHandler.sendText(lines.join('\n'), msg.chatId);
    return true;
  }

  await processor.responseHandler.sendText(
    'Format: /queue status, /queue dead, /queue retry <eventId>, atau /queue prune.',
    msg.chatId
  );
  return true;
}

function parseUsageWindowHours(arg = '') {
  const clean = String(arg || '').trim().toLowerCase();
  if (!clean) return 24;
  const match = clean.match(/^(\d{1,3})\s*(h|j|jam|hours?|d|hari|days?)$/);
  if (!match) return 24;
  const num = Number(match[1]);
  const hours = match[2].startsWith('d') || match[2] === 'hari' ? num * 24 : num;
  return Math.max(1, Math.min(720, hours || 24));
}

async function handleUsageCommand(processor, { trimmed, msg, owner }) {
  if (!owner) {
    await processor.responseHandler.sendText('Perintah /usage hanya dapat diakses oleh pemilik Bubu.', msg.chatId);
    return true;
  }
  if (typeof processor.db?.getTelemetrySummary !== 'function') {
    await processor.responseHandler.sendText('Statistik pemakaian LLM belum tersedia.', msg.chatId);
    return true;
  }
  const parts = trimmed.split(/\s+/);
  const windowHours = parseUsageWindowHours(parts[1] || '');
  const usdToIdr = processor.config?.telemetry?.usdToIdr || 16500;
  const summary = processor.db.getTelemetrySummary({ windowHours, usdToIdr });

  const usd = Number(summary?.estimatedCostUsd || 0);
  const idr = Number(summary?.estimatedCostIdr ?? Math.round(usd * usdToIdr));
  const lines = [
    `*Ringkasan Pemakaian LLM (${summary.windowHours} jam terakhir)*`,
    `Total calls: ${summary.totalCalls ?? 0} (sukses ${summary.successCalls ?? 0} | gagal ${summary.failedCalls ?? Math.max(0, (summary.totalCalls || 0) - (summary.successCalls || 0))})`,
    `Token: ${(summary.totalInputTokens ?? 0).toLocaleString('id-ID')} input / ${(summary.totalOutputTokens ?? 0).toLocaleString('id-ID')} output`,
    `Rata-rata latensi: ${summary.avgLatencyMs ?? 0} ms`,
    `Estimasi biaya: ~$${usd.toFixed(4)} USD (~Rp ${idr.toLocaleString('id-ID')})`
  ];

  const tierEntries = Object.entries(summary.byTier || {});
  if (tierEntries.length > 0) {
    lines.push('', '*Rincian per Tier:*');
    for (const [tier, info] of tierEntries) {
      const costInfo = summary.costByTier?.[tier];
      const costSuffix = costInfo ? ` | ~$${Number(costInfo.estimatedCostUsd || 0).toFixed(4)}` : '';
      lines.push(
        `• ${tier}: ${info.calls ?? 0} calls (${info.inputTokens ?? 0} in / ${info.outputTokens ?? 0} out)${costSuffix}`
      );
    }
  }

  await processor.responseHandler.sendText(lines.join('\n'), msg.chatId);
  return true;
}

function formatLocalTimestamp(iso, timezone = 'Asia/Jakarta') {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return String(iso || '-');
    return d.toLocaleString('id-ID', {
      timeZone: timezone || 'Asia/Jakarta',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return String(iso || '-');
  }
}

function getPendingApprovals(processor, chatId) {
  if (typeof processor.db?.listPendingApprovalsDetailed === 'function') {
    return processor.db.listPendingApprovalsDetailed(chatId) || [];
  }
  if (typeof processor.db?.getPendingApprovalsForChat === 'function') {
    return processor.db.getPendingApprovalsForChat(chatId) || [];
  }
  return [];
}

function formatApprovalSummaryLine(item, timezone = 'Asia/Jakarta') {
  const target = item.arguments?.targetId ? ` -> ${item.arguments.targetId}` : '';
  const detail = item.arguments?.filename
    ? ` (${item.arguments.filename})`
    : item.arguments?.question
      ? ` ("${String(item.arguments.question).slice(0, 40)}")`
      : item.arguments?.message
        ? ` ("${String(item.arguments.message).replace(/\s+/g, ' ').slice(0, 40)}")`
        : '';
  const exp = item.expires_at ? ` | kedaluwarsa: ${formatLocalTimestamp(item.expires_at, timezone)}` : '';
  return `• *${item.id}* — ${item.tool_name}${target}${detail}${exp}`;
}

async function handleApprovalsCommand(processor, { msg, owner, isGroup }) {
  if (!owner || isGroup) {
    await processor.responseHandler.sendText('Daftar persetujuan hanya dapat diakses pemilik melalui DM pribadi.', msg.chatId);
    return true;
  }
  const pending = getPendingApprovals(processor, msg.chatId);
  if (!pending.length) {
    await processor.responseHandler.sendText('Tidak ada persetujuan yang sedang menunggu saat ini.', msg.chatId);
    return true;
  }
  const tz = processor.config?.appTimezone || 'Asia/Jakarta';
  const lines = pending.map((item) => formatApprovalSummaryLine(item, tz));
  const hint = pending.length === 1
    ? 'Balas /approve atau /deny (tanpa ID) atau sertakan ID.'
    : 'Balas /approve <id> atau /deny <id>.';
  await processor.responseHandler.sendText(
    `*Persetujuan Tertunda (${pending.length})*\n${lines.join('\n')}\n\n${hint}`,
    msg.chatId
  );
  return true;
}

function parseDurationTokenMs(token) {
  const match = String(token || '').trim().match(/^(\d+h(?:\d+m)?|\d+m)$/i);
  if (!match) return null;
  const hours = Number((token.match(/(\d+)h/i) || [])[1] || 0);
  const mins = Number((token.match(/(\d+)m/i) || [])[1] || 0);
  const ms = hours * 3600000 + mins * 60000;
  return ms > 0 ? ms : null;
}

function formatPollResultBlock(poll) {
  const header = `*${poll.question}* (${poll.totalVoters} pemilih)`;
  const optionsLines = (poll.tally || []).map((entry) => `  • ${entry.option}: ${entry.votes} suara`);
  const idLine = poll.pollMessageId ? `  ID: ${poll.pollMessageId}` : '';
  return [header, ...optionsLines, ...(idLine ? [idLine] : [])].join('\n');
}

async function handlePollsCommand(processor, { trimmed, msg, scope }) {
  if (typeof processor.db?.listPolls !== 'function' && typeof processor.db?.getPollResults !== 'function') {
    await processor.responseHandler.sendText('Data polling belum tersedia.', msg.chatId);
    return true;
  }
  const parts = trimmed.split(/\s+/);
  const pollId = parts[1] ? parts[1].trim() : '';
  if (pollId && typeof processor.db?.getPollResults === 'function') {
    const res = processor.db.getPollResults({ pollMessageId: pollId, chatId: msg.chatId, scope });
    if (!res?.found) {
      await processor.responseHandler.sendText(`Polling ${pollId} tidak ditemukan di chat ini.`, msg.chatId);
      return true;
    }
    await processor.responseHandler.sendText(`*Hasil Polling*\n${formatPollResultBlock(res)}`, msg.chatId);
    return true;
  }

  const polls = typeof processor.db?.listPolls === 'function'
    ? (processor.db.listPolls({ chatId: msg.chatId, scope, limit: 5 }) || [])
    : [];
  if (!polls.length) {
    await processor.responseHandler.sendText('Belum ada polling tercatat di workspace ini.', msg.chatId);
    return true;
  }
  const blocks = polls.map((poll) => formatPollResultBlock(poll));
  await processor.responseHandler.sendText(`*Daftar & Hasil Polling*\n\n${blocks.join('\n\n')}`, msg.chatId);
  return true;
}

async function handleSlashCommand(processor, { text, msg, senderId, owner, isGroup, scope, eventId }) {
  const trimmed = String(text || '').trim();
  const cmd = extractSlashCommand(trimmed);
  if (!cmd) return false;

  if (cmd === '/approvals') {
    return handleApprovalsCommand(processor, { msg, owner, isGroup });
  }

  if (cmd === '/polls') {
    return handlePollsCommand(processor, { trimmed, msg, scope });
  }

  if (cmd === '/approve' || cmd === '/deny') {
    if (!owner || isGroup) {
      await processor.responseHandler.sendText('Persetujuan hanya dapat dilakukan pemilik melalui DM pribadi.', msg.chatId);
      return true;
    }
    let [, id] = trimmed.split(/\s+/);
    if (!id) {
      const pending = getPendingApprovals(processor, msg.chatId);
      if (pending.length === 1) {
        id = pending[0].id;
      } else if (pending.length > 1) {
        const tz = processor.config?.appTimezone || 'Asia/Jakarta';
        const lines = pending.map((item) => formatApprovalSummaryLine(item, tz));
        await processor.responseHandler.sendText(
          `*Ada ${pending.length} persetujuan aktif*\n${lines.join('\n')}\n\nPilih dengan: /approve <id> atau /deny <id>.`,
          msg.chatId
        );
        return true;
      } else {
        await processor.responseHandler.sendText('Tidak ada persetujuan aktif. Format: /approve <id> atau /deny <id>.', msg.chatId);
        return true;
      }
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
      '*Bubu v2 — Perintah*\n/help — Bantuan\n/status — Status layanan\n/reset — Reset riwayat chat\n/rangkum — Ringkas percakapan\n/reminder 30m pesan — Reminder sekali jalan atau berulang (/reminder list|cancel)\n/polls — Lihat daftar & hasil polling chat\n/memory status|list|sync — Kelola memori workspace\n/queue status|dead|retry|prune — Kelola antrean & telemetri (owner)\n/usage [24h|7d] — Ringkasan pemakaian token & estimasi biaya (owner)\n/approvals — Lihat persetujuan tertunda (owner)\n/voice on|off|both|status|reset — Mode output\n/approve ID — Setujui tindakan\n/deny ID — Tolak tindakan',
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
    const snap = typeof processor.sessionMonitor?.snapshot === 'function'
      ? processor.sessionMonitor.snapshot()
      : null;
    if (snap) {
      lines.push(`WAHA session (${snap.session}): ${snap.status}${snap.degraded ? ' [terdegradasi]' : ''}`);
    }
    const botJid = snap?.botJid || processor.config?.botJid || '';
    if (botJid) {
      lines.push(`Bot JID: ${botJid}`);
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
    const passiveMessages = isGroup &&
      processor.config?.groupPassiveHistory &&
      typeof processor.db?.getGroupPassiveMessages === 'function'
      ? (processor.db.getGroupPassiveMessages(msg.chatId, processor.config.groupPassiveBufferSize || 40) || [])
      : [];
    if (!history.length && !passiveMessages.length) {
      await processor.responseHandler.sendText('Belum ada riwayat percakapan untuk dirangkum.', msg.chatId);
      return true;
    }
    const historyLines = history
      .map((m) => `${m.role}${m.sender ? ` (${m.sender})` : ''}: ${String(m.content || '').slice(0, 1500)}`);
    const passiveLines = passiveMessages
      .map((m) => `[passive] (${m.sender || 'member'}): ${String(m.content || '').slice(0, 800)}`);
    const transcript = passiveLines.length > 0
      ? [
          '--- Percakapan Grup Pasif (Konteks Tambahan) ---',
          ...passiveLines,
          ...(historyLines.length > 0 ? ['--- Percakapan dengan Bubu ---', ...historyLines] : [])
        ].join('\n').slice(-MAX_RANGKUM_CHARS)
      : historyLines.join('\n').slice(-MAX_RANGKUM_CHARS);
    const selected = processor.router.select('summarize');
    const started = Date.now();
    const timeoutMs = processor.config?.agent?.taskTimeoutMs || 30000;
    const result = await withTimeout(
      processor.provider.chat({
        model: selected.model,
        maxTokens: Math.min(4096, processor.config?.agent?.maxOutputTokens || 4096),
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
    const timezone = processor.config?.appTimezone || 'Asia/Jakarta';
    const remainder = trimmed.replace(/^\/reminder\s*/i, '').trim();

    if (/^list\b/i.test(remainder)) {
      const reminders = processor.db.listReminders?.({
        chatId: msg.chatId,
        requesterId: senderId,
        status: 'pending',
        limit: 15
      }) || [];
      if (!reminders.length) {
        await processor.responseHandler.sendText('Belum ada reminder aktif.', msg.chatId);
        return true;
      }
      const lines = reminders.map((r) => {
        const rec = r.recurrence ? ` [${r.recurrence}]` : '';
        return `#${r.id}${rec} — ${formatLocalTimestamp(r.due_at, timezone)}: ${r.message}`;
      });
      await processor.responseHandler.sendText(`*Daftar Reminder Aktif*\n${lines.join('\n')}`, msg.chatId);
      return true;
    }

    const cancelMatch = remainder.match(/^cancel\s+(\d+)\s*$/i);
    if (cancelMatch) {
      const id = Number(cancelMatch[1]);
      const cancelled = Boolean(processor.db.cancelReminder?.({ id, chatId: msg.chatId, requesterId: senderId }));
      await processor.responseHandler.sendText(
        cancelled
          ? `Reminder #${id} dibatalkan.`
          : `Reminder #${id} tidak ditemukan atau sudah selesai/dibatalkan.`,
        msg.chatId
      );
      return true;
    }

    let recurrence = null;
    let dueAt = null;
    let reminderMessage = '';

    const recMatch = remainder.match(/^(daily|weekdays|weekly|monthly|every:\d{1,3}[mhd])\s+(.+)$/is);
    if (recMatch) {
      try {
        recurrence = normalizeRecurrence(recMatch[1]);
      } catch {
        recurrence = null;
      }
      const afterRec = recMatch[2].trim();
      const timeMatch = afterRec.match(/^([^\s]+)\s+(.+)$/s);
      const token = timeMatch?.[1] || '';
      const durMs = parseDurationTokenMs(token);
      const clockIso = parseNextWallClockIso(token, {
        timezone,
        weekdaysOnly: recurrence === 'weekdays'
      });

      if (timeMatch && durMs && durMs <= 365 * 86400000) {
        dueAt = new Date(Date.now() + durMs).toISOString();
        reminderMessage = timeMatch[2].trim();
      } else if (timeMatch && clockIso) {
        dueAt = clockIso;
        reminderMessage = timeMatch[2].trim();
      } else if (recurrence?.startsWith('every:')) {
        const intervalUnit = recurrence.slice(6);
        const intervalMs = parseDurationTokenMs(intervalUnit) ||
          (intervalUnit.endsWith('d') ? Number(intervalUnit.slice(0, -1)) * 86400000 : null);
        if (intervalMs && intervalMs <= 365 * 86400000) {
          dueAt = new Date(Date.now() + intervalMs).toISOString();
          reminderMessage = afterRec;
        }
      }
    } else {
      const oneTimeMatch = remainder.match(/^([^\s]+)\s+(.+)$/s);
      if (oneTimeMatch) {
        const token = oneTimeMatch[1];
        const durMs = parseDurationTokenMs(token);
        if (durMs) {
          if (durMs > 365 * 86400000) {
            await processor.responseHandler.sendText('Waktu reminder tidak valid atau melebihi satu tahun.', msg.chatId);
            return true;
          }
          dueAt = new Date(Date.now() + durMs).toISOString();
          reminderMessage = oneTimeMatch[2].trim();
        } else {
          const clockIso = parseNextWallClockIso(token, { timezone });
          if (clockIso) {
            dueAt = clockIso;
            reminderMessage = oneTimeMatch[2].trim();
          }
        }
      }
    }

    if (!dueAt || !reminderMessage) {
      await processor.responseHandler.sendText(
        'Format: /reminder 30m Pesan, /reminder 2h30m Pesan, /reminder 08:00 Pesan, /reminder daily 08:00 Pesan, /reminder list, atau /reminder cancel <id>',
        msg.chatId
      );
      return true;
    }
    if (reminderMessage.length > MAX_REMINDER_CHARS) {
      await processor.responseHandler.sendText(`Pesan reminder harus 1–${MAX_REMINDER_CHARS} karakter.`, msg.chatId);
      return true;
    }

    const id = processor.db.createReminder({
      chatId: msg.chatId,
      requesterId: senderId,
      message: reminderMessage,
      dueAt,
      ...(recurrence ? { recurrence } : {}),
      sourceEventId: eventId
    });
    const recNote = recurrence ? ` (berulang: ${recurrence})` : '';
    await processor.responseHandler.sendText(
      `Reminder #${id} tersimpan${recNote}. Jadwal: ${formatLocalTimestamp(dueAt, timezone)}. Reminder tetap ada setelah restart.`,
      msg.chatId
    );
    return true;
  }

  if (cmd === '/memory') {
    const [, rawSub] = trimmed.split(/\s+/, 2);
    const sub = (rawSub || 'status').toLowerCase();
    const memoryContext = {
      scope,
      ownerId: scope === 'personal' ? senderId : null,
      chatId: scope === 'group' ? msg.chatId : null
    };

    if (sub === 'status') {
      const stats = typeof processor.db?.getMemoryStats === 'function'
        ? processor.db.getMemoryStats(memoryContext)
        : {
            activeCount: typeof processor.db?.listMemories === 'function'
              ? (processor.db.listMemories({ ...memoryContext, status: 'active', limit: 50 }) || []).length
              : (typeof processor.db?.searchMemories === 'function'
                  ? (processor.db.searchMemories({ ...memoryContext, query: '', limit: 50 }) || []).length
                  : 0),
            projectCount: typeof processor.db?.listProjects === 'function'
              ? (processor.db.listProjects({ ...memoryContext, status: 'active', limit: 50 }) || []).length
              : 0,
            eventCount: typeof processor.db?.listMemoryEvents === 'function'
              ? (processor.db.listMemoryEvents({ ...memoryContext, limit: 50 }) || []).length
              : 0
          };
      const lines = [
        `*Status Memori Workspace (${scope})*`,
        `Memori aktif: ${stats.activeCount ?? 0}`,
        `Proyek aktif: ${stats.projectCount ?? 0}`,
        `Event episodik: ${stats.eventCount ?? 0}`
      ];
      if (stats.supersededCount !== undefined) lines.push(`Tergantikan: ${stats.supersededCount}`);
      if (stats.archivedCount !== undefined) lines.push(`Diarsipkan: ${stats.archivedCount}`);
      if (stats.unembeddedCount !== undefined) lines.push(`Belum ter-embedding: ${stats.unembeddedCount}`);
      lines.push('Perintah: /memory status, /memory list, /memory sync.');
      await processor.responseHandler.sendText(lines.join('\n'), msg.chatId);
      return true;
    }

    if (sub === 'list') {
      const items = typeof processor.db?.listMemories === 'function'
        ? (processor.db.listMemories({ ...memoryContext, status: 'active', limit: 10 }) || [])
        : (typeof processor.db?.searchMemories === 'function'
            ? (processor.db.searchMemories({ ...memoryContext, query: '', limit: 10 }) || [])
            : []);
      if (!items.length) {
        await processor.responseHandler.sendText('Belum ada memori aktif di workspace ini.', msg.chatId);
        return true;
      }
      const lines = items.slice(0, 10).map((m) => {
        const mType = m.memory_type || m.memoryType || m.kind || 'fact';
        const summary = m.title
          ? `${m.title}: ${String(m.content || '').slice(0, 100)}`
          : String(m.content || '').slice(0, 120);
        return `#${m.id} [${mType}] ${summary}`;
      });
      await processor.responseHandler.sendText(
        `*Memori Aktif Workspace (${scope})*\n${lines.join('\n')}`,
        msg.chatId
      );
      return true;
    }

    if (sub === 'sync') {
      if (!owner) {
        await processor.responseHandler.sendText('Sinkronisasi memori hanya dapat dilakukan oleh pemilik Bubu.', msg.chatId);
        return true;
      }
      let result;
      if (typeof processor.memoryService?.consolidateWorkspace === 'function') {
        result = await processor.memoryService.consolidateWorkspace({ ...memoryContext, backfillLimit: 10 });
      } else if (typeof processor.db?.consolidateWorkspaceMemories === 'function') {
        result = processor.db.consolidateWorkspaceMemories(memoryContext);
      } else {
        await processor.responseHandler.sendText('Layanan konsolidasi memori belum tersedia.', msg.chatId);
        return true;
      }
      const deduplicated = Number(result?.deduplicatedCount ?? result?.deduplicated ?? 0);
      const archived = Number(result?.archivedStaleCount ?? result?.archivedCount ?? result?.archived ?? 0);
      const backfilled = Number(result?.backfilledCount ?? result?.backfilled ?? result?.embeddedCount ?? 0);
      await processor.responseHandler.sendText(
        `Sinkronisasi memori workspace selesai.\nDeduplikasi: ${deduplicated}\nDiarsipkan (usang): ${archived}\nEmbedding diperbarui: ${backfilled}`,
        msg.chatId
      );
      return true;
    }

    await processor.responseHandler.sendText(
      'Format: /memory status, /memory list, atau /memory sync.',
      msg.chatId
    );
    return true;
  }

  if (cmd === '/queue') {
    return handleQueueCommand(processor, { trimmed, msg, owner });
  }

  if (cmd === '/usage') {
    return handleUsageCommand(processor, { trimmed, msg, owner });
  }

  return false;
}

module.exports = {
  RECOGNIZED_SLASH_COMMANDS,
  extractSlashCommand,
  isRecognizedSlashCommand,
  handleSlashCommand
};
