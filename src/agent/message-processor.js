const { normalizeJid } = require('../config/env');
const { classifyTask } = require('./model-router');
const { ResponseHandler } = require('../channels/response-handler');
const path = require('node:path');
const { normalizeMediaUrl } = require('../p1/documents/service');

function eventKey(message) {
  const crypto = require('node:crypto');
  const identity = message.eventId
    ? `${message.chatId}|${message.eventId}`
    : `${message.chatId}|${message.senderId}|${message.text}|${JSON.stringify(message.raw || {})}`;
  return crypto.createHash('sha256').update(identity).digest('hex');
}

function hasBotMention(message, botJid = '') {
  if (/\bbubu\b/i.test(String(message.text || ''))) return true;
  if (!botJid) return false;

  const normalize = (value) => normalizeJid(String(value || '').replace(/^@/, ''));
  const expected = normalize(botJid);
  if (!expected) return false;

  const expectedNumber = expected.split('@')[0].split(':')[0];
  for (const mention of message.mentions || []) {
    const normalized = normalize(mention);
    if (normalized === expected) return true;
    const mentionedNumber = normalized.split('@')[0].split(':')[0];
    if (expectedNumber && mentionedNumber === expectedNumber) return true;
  }

  // Some webhook versions expose the rendered @number in body but omit
  // structured mention metadata.
  return expectedNumber.length >= 8 &&
    String(message.text || '').includes(`@${expectedNumber}`);
}

class MessageProcessor {
  constructor({ config, db, waha, responseHandler = null, agent, approvalManager, provider, router, documentService, memoryService, mediaService, logger }) {
    Object.assign(this, { config, db, waha, agent, approvalManager, provider, router, documentService, memoryService, mediaService, logger });
    this.responseHandler = responseHandler || new ResponseHandler({ waha, mediaService, config, logger });

  }

  async sendConfiguredResponse(text, chatId, mode) {
    return this.responseHandler.sendAssistantResponse(text, chatId, mode);
  }

  getChatOutputMode(chatId) {
    return this.db.getChatOutputMode({
      chatId,
      requesterId: this.config.ownerJid,
      defaultMode: this.config.media.voiceReplyDefault ? 'both' : 'text'
    });
  }

  async sendMediaNotice(text, chatId) {
    const mode = this.getChatOutputMode(chatId);
    try {
      return await this.responseHandler.sendAssistantResponse(text, chatId, mode);
    } catch (error) {
      // Never fall back to text when the chat explicitly requires voice-only.
      // A notification delivery failure must not cause the original media
      // validation event to be replayed.
      this.logger.warn({
        chatId,
        mode,
        error: error.message
      }, 'Unable to deliver media notice in the configured response mode');
      return null;
    }
  }

  async process(payload) {
    const { normalizeIncoming } = require('../channels/waha/client');
    const msg = normalizeIncoming(payload);
    if (!msg.chatId || (!msg.text && !msg.hasMedia && !msg.quote?.present && !msg.quote?.rejected) || msg.fromMe) return;
    if (msg.chatId.endsWith('@broadcast') || msg.chatId.endsWith('@newsletter')) return;

    const isGroup = msg.chatId.endsWith('@g.us');
    if (isGroup && this.config.groupPolicy !== 'all') return;

    let senderId = normalizeJid(msg.senderId);
    if (senderId.endsWith('@lid')) {
      try { senderId = normalizeJid(await this.waha.resolveLid(senderId)); }
      catch (error) { this.logger.warn({ senderId, error: error.message }, 'Unable to resolve sender LID'); }
    }
    const owner = senderId === this.config.ownerJid;
    if (!owner) {
      const rate = this.db.consumeRateLimit(`${msg.chatId}:${senderId}`, {
        limit: this.config.agent.messageRateLimit,
        windowMs: this.config.agent.messageRateWindowMs
      });
      if (!rate.allowed) {
        this.logger.warn({ chatId: msg.chatId, senderId, retryAfterMs: rate.retryAfterMs }, 'Message rate limit reached');
        return;
      }
    }
    const scope = isGroup ? 'group' : (owner ? 'personal' : 'untrusted');

    // The personal assistant is owner-only. In groups, anyone may address Bubu.
    if (scope === 'untrusted') return;

    const bodyText = String(msg.bodyText || '').trim();
    const captionText = String(msg.captionText || '').trim();
    const currentMessageText = String(msg.text || '').trim();
    let text = bodyText || captionText || currentMessageText;
    const captionContext = bodyText && captionText && bodyText !== captionText
      ? captionText : null;
    const memoryEligibleText = currentMessageText;
    let historyUserText = currentMessageText;
    let attachmentEvidence = null;
    let voiceInstruction = null;
    const quoteContext = msg.quote?.present || msg.quote?.rejected ? msg.quote : null;
    if (isGroup) {
      const hasMention = hasBotMention(msg, this.config.botJid);
      const isCommand = text.startsWith('/');
      const mediaOnly = msg.hasMedia && !currentMessageText;
      const mediaMayTriggerWithoutMention = mediaOnly && !this.config.groupMediaRequireMention;

      if (this.config.groupRequireMention &&
          !hasMention && !isCommand && !mediaMayTriggerWithoutMention) {
        return; // Ordinary group conversation remains quiet; media-only messages follow their separate policy.
      }
    }

    // Acknowledge eligible messages and show live typing while Bubu works.
    // Presence failures must never prevent the actual AI task from running.
    if (typeof this.waha.sendSeen === 'function') {
      try {
        await this.waha.sendSeen(msg.chatId);
      } catch (error) {
        this.logger.warn({ chatId: msg.chatId, error: error.message }, 'WAHA sendSeen failed');
      }
    }
    if (typeof this.waha.startTyping === 'function') {
      try {
        await this.waha.startTyping(msg.chatId);
      } catch (error) {
        this.logger.warn({ chatId: msg.chatId, error: error.message }, 'WAHA startTyping failed');
      }
    }

    try {
    if (msg.hasMedia) {
      if (!msg.media?.url) {
        await this.sendMediaNotice(
          'Lampiran terdeteksi, tetapi WAHA tidak menyediakan media.url. Pastikan WAHA media download aktif.',
          msg.chatId
        );
        return;
      }
      try {
        const { detectMediaKind } = require('../p3/media/service');
        const normalizedMediaUrl = normalizeMediaUrl(msg.media.url, this.config.waha.baseUrl);
        const mediaFilename = msg.media.filename || msg.media.fileName ||
          path.basename(normalizedMediaUrl.pathname);
        const mediaKind = detectMediaKind(mediaFilename, msg.media.mimetype);
        if (mediaKind === 'document') {
          const doc = await this.documentService.ingestMedia({
            media: msg.media,
            scope,
            ownerId: scope === 'personal' ? senderId : null,
            chatId: scope === 'group' ? msg.chatId : null,
            sourceEventId: eventKey(msg)
          });
          attachmentEvidence = {
            kind: 'document',
            ...(doc.id ? { documentId: doc.id } : {}),
            filename: doc.filename,
            mimeType: doc.mime_type,
            ...(doc.pageCount ? { pageCount: doc.pageCount } : {}),
            ...(doc.extractionMode ? { extractionMode: doc.extractionMode } : {}),
            extractedText: String(doc.extractedText || '').slice(0, this.config.documents.maxExtractChars)
          };
          if (!text) text = 'Tolong baca dan jelaskan dokumen yang saya kirim.';
          historyUserText = historyUserText || '[Mengirim lampiran dokumen]';
        } else if (['image','audio','video'].includes(mediaKind)) {
          if (!this.config.media.enabled || !this.mediaService) {
            await this.sendMediaNotice(
              'Pemrosesan gambar/audio/video sedang dinonaktifkan.',
              msg.chatId
            );
            return;
          }
          const processed = await this.mediaService.processIncoming({media:msg.media});
          const extractedText = String(processed.extractedText || '').slice(
            0, this.config.documents.maxExtractChars || 30000
          );
          if (mediaKind === 'audio' && processed.noSpeech) {
            await this.sendMediaNotice(
              'Saya tidak mendeteksi ucapan pada audio tersebut. Silakan kirim ulang voice note yang berisi suara.',
              msg.chatId
            );
            return;
          }
          if (mediaKind === 'audio' && msg.media.isPtt === true && extractedText) {
            voiceInstruction = extractedText;
            if (!text) text = 'Tolong jalankan instruksi yang saya sampaikan melalui voice note ini.';
            historyUserText = [historyUserText, extractedText].filter(Boolean).join('\n');
          } else {
            attachmentEvidence = {
              kind: processed.kind || mediaKind,
              filename: processed.filename || mediaFilename,
              extractedText,
              ...(processed.ocrText !== undefined ? { ocrText: String(processed.ocrText || '').slice(0, this.config.documents.maxExtractChars || 30000) } : {}),
              ...(processed.visualMode ? { visualMode: processed.visualMode } : {}),
              ...(processed.visualFallbackReason ? { visualFallbackReason: processed.visualFallbackReason } : {}),
              ...(Array.isArray(processed.visualImages) && processed.visualImages.length ? { visualImages: processed.visualImages } : {}),
              ...(Array.isArray(processed.frames) ? { frames: processed.frames } : {}),
              ...(processed.durationSeconds !== undefined ? { durationSeconds: processed.durationSeconds } : {}),
              ...(processed.declaredDurationSeconds !== undefined ? { declaredDurationSeconds: processed.declaredDurationSeconds } : {}),
              ...(processed.samplingIntervalSeconds !== undefined ? { samplingIntervalSeconds: processed.samplingIntervalSeconds } : {}),
              ...(processed.temporalStatus ? { temporalStatus: processed.temporalStatus } : {}),
              ...(processed.partialOnly !== undefined ? { partialOnly: processed.partialOnly } : {}),
              ...(processed.transcript !== undefined ? { transcript: String(processed.transcript || '').slice(0, 30000) } : {})
            };
            if (!text) {
              text = mediaKind === 'audio'
                ? 'Tolong transkripsikan dan rangkum audio yang saya kirim.'
                : mediaKind === 'video'
                  ? 'Tolong rangkum informasi yang dapat diekstrak dari video ini.'
                  : 'Tolong baca dan jelaskan gambar ini.';
            }
            historyUserText = historyUserText || `[Mengirim lampiran ${processed.kind || mediaKind}]`;
          }
        } else {
          await this.sendMediaNotice(
            'Format media belum didukung. Kirim gambar, audio, video, PDF, DOCX, XLSX, CSV, atau TXT.',
            msg.chatId
          );
          return;
        }
      } catch (error) {
        // Let InboxWorker be the single owner of operational classification,
        // bounded retries, dead-letter transitions, and terminal notification.
        // Swallowing this error here would mark transient media failures complete.
        this.logger.warn({
          chatId: msg.chatId,
          error: error.message
        }, 'P3 media processing failed');
        throw error;
      }
    }

    if (quoteContext?.present && !quoteContext?.rejected && typeof this.db?.listDocuments === 'function') {
      try {
        const workspaceDocs = this.db.listDocuments({
          scope,
          ownerId: scope === 'personal' ? senderId : null,
          chatId: scope === 'group' ? msg.chatId : null,
          limit: 20
        }) || [];
        if (workspaceDocs.length > 0) {
          const quotedTextLower = String(quoteContext.text || '').toLowerCase();
          const quotedMimeLower = String(quoteContext.mimeType || '').toLowerCase();
          const quotedTypeLower = String(quoteContext.type || '').toLowerCase();
          let matchedDoc = workspaceDocs.find((d) =>
            d.filename && quotedTextLower && quotedTextLower.includes(String(d.filename).toLowerCase())
          );
          if (!matchedDoc && (quotedTypeLower === 'document' || quotedMimeLower.includes('pdf') || quotedMimeLower.includes('word') || quotedMimeLower.includes('sheet') || quotedMimeLower.includes('excel') || quotedMimeLower.includes('csv'))) {
            matchedDoc = workspaceDocs.find((d) =>
              quotedMimeLower && String(d.mime_type || '').toLowerCase() === quotedMimeLower
            ) || workspaceDocs[0];
          }
          if (matchedDoc) {
            quoteContext.referencedDocument = {
              documentId: matchedDoc.id,
              filename: matchedDoc.filename,
              mimeType: matchedDoc.mime_type || null
            };
          }
        }
      } catch (err) {
        this.logger?.warn?.({ chatId: msg.chatId, error: err.message }, 'Unable to resolve quoted workspace document');
      }
    }

    if (!text && quoteContext?.present) {
      text = 'Tolong jelaskan pesan yang saya kutip.';
      historyUserText = '[Membalas pesan kutipan]';
    } else if (!text && quoteContext?.rejected && !msg.hasMedia) {
      await this.sendConfiguredResponse(
        'Konteks pesan yang dibalas tidak dapat diverifikasi berasal dari chat ini, jadi Bubu tidak menggunakannya.',
        msg.chatId,
        this.getChatOutputMode(msg.chatId)
      );
      return;
    }

    if (text.startsWith('/approve ') || text.startsWith('/deny ')) {
      if (!owner || isGroup) {
        await this.responseHandler.sendText('Persetujuan hanya dapat dilakukan pemilik melalui DM pribadi.', msg.chatId);
        return;
      }
      const [command, id] = text.split(/\s+/);
      const result = await this.approvalManager.resolve({
        id, actorId: senderId, approved: command === '/approve'
      });
      const approvalReply = result.ok
        ? (result.sent ? `Persetujuan ${id} berhasil. File/pesan sudah dikirim.` : `Persetujuan ${id} berhasil dibatalkan.`)
        : `Persetujuan tidak dapat diproses: ${result.reason}.`;
      await this.responseHandler.sendText(approvalReply, msg.chatId);
      if (result.ok) {
        this.db.addMessage({
          chatId: msg.chatId,
          scope,
          role: 'assistant',
          content: approvalReply,
          eventId: eventKey(msg)
        });
      }
      return;
    }

    if (text.toLowerCase().startsWith('/voice')) {
      if (!owner) {
        await this.responseHandler.sendText('Pengaturan voice hanya dapat diubah oleh pemilik Bubu.', msg.chatId);
        return;
      }
      const command = text.trim().toLowerCase();
      const preferenceKey = { chatId: msg.chatId, requesterId: this.config.ownerJid };
      if (command === '/voice on' || command === '/voice both') {
        if (!this.config.media.enabled || !this.mediaService || !this.config.media.piperModelPath) {
          await this.responseHandler.sendText(
            'Voice reply belum siap. Pastikan MEDIA_INTELLIGENCE_ENABLED aktif, PIPER_MODEL_PATH terisi, serta Piper dan FFmpeg tersedia.',
            msg.chatId
          );
          return;
        }
        const mode = command === '/voice on' ? 'voice' : 'both';
        this.db.setChatOutputMode({ ...preferenceKey, mode });
        await this.sendConfiguredResponse(
          mode === 'voice'
            ? 'Mode voice-only aktif untuk chat ini. Bubu hanya akan mengirim voice note sebagai jawaban.'
            : 'Mode text + voice aktif untuk chat ini.',
          msg.chatId,
          mode
        );
        return;
      }
      if (command === '/voice off') {
        this.db.setChatOutputMode({ ...preferenceKey, mode: 'text' });
        await this.responseHandler.sendText('Mode text-only aktif untuk chat ini.', msg.chatId);
        return;
      }
      if (command === '/voice reset') {
        this.db.resetChatOutputMode(preferenceKey);
        const defaultMode = this.config.media.voiceReplyDefault ? 'both' : 'text';
        const labels = { text: 'text-only', voice: 'voice-only', both: 'text + voice' };
        await this.sendConfiguredResponse(
          `Preferensi khusus chat dihapus. Mode sekarang mengikuti default Bubu: ${labels[defaultMode]}.`,
          msg.chatId,
          defaultMode
        );
        return;
      }
      if (command === '/voice status' || command === '/voice') {
        const defaultMode = this.config.media.voiceReplyDefault ? 'both' : 'text';
        const preference = this.db.getChatOutputPreference({
          ...preferenceKey, defaultMode
        });
        const labels = { text: 'text-only', voice: 'voice-only', both: 'text + voice' };
        const source = preference.isCustom ? 'preferensi khusus chat' : 'default konfigurasi Bubu';
        await this.sendConfiguredResponse(
          `Mode output chat ini: ${labels[preference.mode] || labels.text}.\nSumber: ${source}.\nPerintah: /voice on, /voice off, /voice both, /voice status, /voice reset.`,
          msg.chatId,
          preference.mode
        );
        return;
      }
      await this.responseHandler.sendText(
        'Format: /voice on (voice-only), /voice off (text-only), /voice both (teks + suara), /voice status, /voice reset.',
        msg.chatId
      );
      return;
    }

    if (text === '/help') {
      await this.responseHandler.sendText(
        '*Bubu v2 — Perintah*\n/help — Bantuan\n/status — Status layanan\n/reset — Reset riwayat chat\n/rangkum — Ringkas percakapan\n/reminder 30m pesan — Reminder sekali jalan\n/voice on|off|both|status|reset — Mode output\n/approve ID — Setujui tindakan\n/deny ID — Tolak tindakan',
        msg.chatId
      );
      return;
    }

    if (text === '/status') {
      await this.responseHandler.sendText(`Bubu v2 aktif.\nMode: ${scope}\nModel routing: dynamic Sumopod\nWaktu: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`, msg.chatId);
      return;
    }

    if (text === '/reset') {
      if (!owner || isGroup) {
        await this.responseHandler.sendText('Reset riwayat hanya dapat dilakukan pemilik melalui DM.', msg.chatId);
        return;
      }
      this.db.clearMessages(msg.chatId);
      await this.responseHandler.sendText('Riwayat percakapan DM ini sudah direset.', msg.chatId);
      return;
    }

    if (text === '/rangkum') {
      const history = this.db.getHistory(msg.chatId, scope, 60);
      if (!history.length) {
        await this.responseHandler.sendText('Belum ada riwayat percakapan untuk dirangkum.', msg.chatId);
        return;
      }
      const selected = this.router.select('summarize');
      const result = await this.provider.chat({
        model: selected.model,
        messages: [
          { role: 'system', content: 'Ringkas percakapan dalam bahasa Indonesia. Pisahkan keputusan, informasi penting, dan tindak lanjut. Jangan mengarang.' },
          { role: 'user', content: history.map((m) => `${m.role}: ${m.content}`).join('\n') }
        ]
      });
      await this.responseHandler.sendText(String(result.message.content || '').trim(), msg.chatId);
      return;
    }

    if (text.startsWith('/reminder ')) {
      if (!owner || isGroup) {
        await this.responseHandler.sendText('Reminder personal hanya dapat dibuat pemilik melalui DM.', msg.chatId);
        return;
      }
      const match = text.match(/^\/reminder\s+((?:\d+h(?:\d+m)?|\d+m))\s+(.+)$/i);
      if (!match) {
        await this.responseHandler.sendText('Format: /reminder 30m Pesan atau /reminder 2h30m Pesan', msg.chatId);
        return;
      }
      const durationMs = (Number((match[1].match(/(\d+)h/i) || [])[1] || 0) * 3600000)
        + (Number((match[1].match(/(\d+)m/i) || [])[1] || 0) * 60000);
      if (!durationMs || durationMs > 365 * 86400000) {
        await this.responseHandler.sendText('Waktu reminder tidak valid atau melebihi satu tahun.', msg.chatId);
        return;
      }
      const id = this.db.createReminder({
        chatId: msg.chatId, requesterId: senderId, message: match[2],
        dueAt: new Date(Date.now() + durationMs).toISOString(),
        sourceEventId: eventKey(msg)
      });
      await this.responseHandler.sendText(`Reminder #${id} tersimpan. Reminder tetap ada setelah restart.`, msg.chatId);
      return;
    }

    if (!this.config.agent.enabled) {
      await this.responseHandler.sendText('Bubu Agent sedang dinonaktifkan.', msg.chatId);
      return;
    }

    const history = this.db.getHistory(msg.chatId, scope, 16, eventKey(msg));
    this.db.addMessage({
      chatId: msg.chatId, scope, role: 'user',
      senderId, content: historyUserText || text, eventId: eventKey(msg)
    });
    const memoryContext = {
      scope,
      ownerId: scope === 'personal' ? senderId : null,
      chatId: scope === 'group' ? msg.chatId : null
    };
    const memories = this.memoryService
      ? await this.memoryService.retrieve({ ...memoryContext, query: text, limit: 8 })
      : this.db.searchMemories({ ...memoryContext, query: text, limit: 6 });
    const projects = this.memoryService
      ? await this.memoryService.projectContext({ ...memoryContext, query: text, limit: 5 })
      : [];

    const result = await this.agent.run({
      text, chatId: msg.chatId, requesterId: senderId, scope, history, memories, projects,
      captionContext, voiceInstruction, attachmentEvidence, quoteContext,
      sourceEventId: eventKey(msg)
    });
    if (result.text) {
      // Claim a durable response slot before sending. If WAHA accepted a send but
      // the process crashed before the DB commit, recovery marks it uncertain
      // instead of blindly sending a duplicate reply.
      const responseText = this.db.claimTaskResponse(result.taskId);
      if (responseText !== null) {
        try {
          const outputMode = this.db.getChatOutputMode({
            chatId: msg.chatId,
            requesterId: this.config.ownerJid,
            defaultMode: this.config.media.voiceReplyDefault ? 'both' : 'text'
          });

          // Voice-only is fail-closed: never send a text answer if TTS or voice
          // delivery fails, because that would violate the chat's explicit mode.
          await this.responseHandler.sendAssistantResponse(responseText, msg.chatId, outputMode);

          this.db.finishTaskResponse(result.taskId, 'sent');
          this.db.addMessage({
            chatId: msg.chatId, scope, role: 'assistant',
            content: responseText, eventId: eventKey(msg)
          });
          if (this.memoryService && !msg.hasMedia && !quoteContext) {
            try {
              this.db.saveMemoryEvent({
                ...memoryContext,
                eventType: 'conversation_turn',
                summary: `${memoryEligibleText.slice(0,500)} => ${responseText.slice(0,500)}`,
                sourceEventId: eventKey(msg)
              });
              await this.memoryService.captureFromTurn({
                ...memoryContext,
                userText: memoryEligibleText,
                assistantText: responseText,
                sourceEventId: eventKey(msg)
              });
            } catch (memoryError) {
              this.logger.warn({ error: memoryError.message }, 'Memory capture failed');
            }
          }
        } catch (error) {
          this.db.finishTaskResponse(result.taskId, 'uncertain');
          throw error;
        }
      }
    }
    } finally {
      if (typeof this.waha.stopTyping === 'function') {
        try {
          await this.waha.stopTyping(msg.chatId);
        } catch (error) {
          this.logger.warn({ chatId: msg.chatId, error: error.message }, 'WAHA stopTyping failed');
        }
      }
    }
  }
}

module.exports = { MessageProcessor, eventKey, hasBotMention };
