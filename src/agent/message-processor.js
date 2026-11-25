const crypto = require('node:crypto');
const path = require('node:path');
const { normalizeJid } = require('../config/env');
const { ResponseHandler } = require('../channels/response-handler');
const { normalizeIncoming } = require('../channels/waha/normalizer');
const { normalizeMediaUrl } = require('../utils/media-http');
const { detectMediaKind } = require('../media/media-validator');
const { classifyTask } = require('./model-router');
const { extractSlashCommand, handleSlashCommand, isRecognizedSlashCommand } = require('./command-handler');

function eventKey(message) {
  const identity = message.eventId
    ? `${message.chatId}|${message.eventId}`
    : `${message.chatId}|${message.senderId}|${message.text}|${JSON.stringify(message.raw || {})}`;
  return crypto.createHash('sha256').update(identity).digest('hex');
}

function hasBotMention(message, botJidOrList = '') {
  if (/\bbubu\b/i.test(String(message?.text || ''))) return true;
  const rawList = Array.isArray(botJidOrList) ? botJidOrList : [botJidOrList];
  const normalize = (value) => normalizeJid(String(value || '').replace(/^@/, ''));
  const candidates = [...new Set(rawList.map(normalize).filter(Boolean))];
  if (candidates.length === 0) return false;

  const mentions = (message?.mentions || []).map(normalize).filter(Boolean);
  const text = String(message?.text || '');

  for (const expected of candidates) {
    const expectedNumber = expected.split('@')[0].split(':')[0];
    for (const normalized of mentions) {
      if (normalized === expected) return true;
      const mentionedNumber = normalized.split('@')[0].split(':')[0];
      if (expectedNumber && mentionedNumber === expectedNumber) return true;
    }

    // Some webhook versions expose the rendered @number in body but omit
    // structured mention metadata.
    const minLen = expected.endsWith('@lid') ? 6 : 8;
    if (expectedNumber.length >= minLen && text.includes(`@${expectedNumber}`)) {
      return true;
    }
  }
  return false;
}

class MessageProcessor {
  constructor({ config, db, waha, responseHandler = null, sessionMonitor = null, agent, approvalManager, provider, router, documentService, memoryService, mediaService, logger, pipelineEvents = null }) {
    Object.assign(this, { config, db, waha, sessionMonitor, agent, approvalManager, provider, router, documentService, memoryService, mediaService, logger, pipelineEvents });
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

  buildMediaAttachmentEvidence(processed, fallbackFilename, maxExtractChars = 30000) {
    const limit = maxExtractChars || 30000;
    const extractedText = String(processed.extractedText || '').slice(0, limit);
    return {
      kind: processed.kind,
      filename: processed.filename || fallbackFilename,
      extractedText,
      ...(processed.ocrText !== undefined ? { ocrText: String(processed.ocrText || '').slice(0, limit) } : {}),
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
  }

  async process(payload, meta = null) {
    const msg = normalizeIncoming(payload);
    if (msg.botId || msg.botLid) {
      this.sessionMonitor?.updateBotIdentity?.({ id: msg.botId, lid: msg.botLid });
    }
    msg.chatId = normalizeJid(msg.chatId);
    if (!msg.chatId || (!msg.text && !msg.hasMedia && !msg.quote?.present && !msg.quote?.rejected) || msg.fromMe) return;
    if (msg.chatId.endsWith('@broadcast') || msg.chatId.endsWith('@newsletter')) return;
    if (msg.eventType && msg.eventType !== 'message') return;

    const rawChatId = msg.chatId;
    const rawSenderId = normalizeJid(msg.senderId);
    const initialEventId = eventKey({ ...msg, chatId: rawChatId, senderId: rawSenderId });
    const runId = String(meta?.eventId || initialEventId).slice(0, 12);

    const isGroup = msg.chatId.endsWith('@g.us');
    if (isGroup && this.config.groupPolicy !== 'all') {
      this.pipelineEvents?.discardActiveRun?.(runId);
      return;
    }

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
      if (msg.isSticker && !currentMessageText) {
        this.pipelineEvents?.discardActiveRun?.(runId);
        return;
      }
      const snap = typeof this.sessionMonitor?.snapshot === 'function'
        ? this.sessionMonitor.snapshot()
        : null;
      const botIdentities = [this.config.botJid, snap?.botJid, snap?.botLid, msg.botId, msg.botLid].filter(Boolean);
      const hasMention = hasBotMention(msg, botIdentities);
      const isCommand = isRecognizedSlashCommand(text);
      const mediaOnly = msg.hasMedia && !msg.isSticker && !currentMessageText;
      const mediaMayTriggerWithoutMention = mediaOnly && !this.config.groupMediaRequireMention;

      if (this.config.groupRequireMention &&
          !hasMention && !isCommand && !mediaMayTriggerWithoutMention) {
        let passiveContent = currentMessageText;
        if (msg.hasMedia && !msg.isSticker) {
          const stubKind = detectMediaKind(msg.media?.filename || msg.media?.fileName || '', msg.media?.mimetype || '');
          const labelMap = {
            image: 'gambar',
            audio: msg.media?.isPtt ? 'voice note' : 'audio',
            video: 'video',
            document: 'dokumen'
          };
          const label = labelMap[stubKind] || 'media';
          const fname = msg.media?.filename || msg.media?.fileName;
          const stub = fname ? `[Mengirim ${label}: ${fname}]` : `[Mengirim ${label}]`;
          passiveContent = currentMessageText ? `${stub} ${currentMessageText}` : stub;
        }
        const passiveSender = msg.pushName && rawSenderId
          ? `${msg.pushName} (${rawSenderId})`
          : (msg.pushName || rawSenderId || null);
        if (this.config.groupPassiveHistory && passiveContent && typeof this.db?.addGroupPassiveMessage === 'function') {
          try {
            this.db.addGroupPassiveMessage({
              chatId: msg.chatId,
              senderId: passiveSender,
              messageId: msg.eventId || null,
              content: passiveContent,
              maxBuffer: this.config.groupPassiveBufferSize || 40
            });
          } catch (err) {
            this.logger?.warn?.({ chatId: msg.chatId, error: err?.message }, 'Failed to buffer passive group message');
          }
        }
        this.pipelineEvents?.discardActiveRun?.(runId);
        return; // Ordinary group conversation remains quiet; media-only messages follow their separate policy.
      }
    }

    let senderId = normalizeJid(msg.senderId);
    if (senderId.endsWith('@lid') && typeof this.waha?.resolveLid === 'function') {
      try {
        senderId = normalizeJid(await this.waha.resolveLid(senderId));
      } catch (error) {
        this.logger.warn({ senderId, error: error.message }, 'Unable to resolve sender LID');
        if (!isGroup) throw error;
      }
    }
    if (!isGroup && msg.chatId.endsWith('@lid')) {
      if (senderId && !senderId.endsWith('@lid')) {
        msg.chatId = senderId;
      } else if (typeof this.waha?.resolveLid === 'function') {
        const resolvedChat = normalizeJid(await this.waha.resolveLid(msg.chatId));
        if (resolvedChat) msg.chatId = resolvedChat;
      }
    }

    const owner = senderId === this.config.ownerJid;
    const scope = isGroup ? 'group' : (owner ? 'personal' : 'untrusted');

    // The personal assistant is owner-only. In groups, anyone may address Bubu.
    if (scope === 'untrusted') {
      this.pipelineEvents?.discardActiveRun?.(runId);
      return;
    }

    if (owner && rawSenderId.endsWith('@lid')) {
      this.sessionMonitor?.rememberOwnerLid?.(rawSenderId);
    }

    if (!owner) {
      const rate = this.db.consumeRateLimit(`${msg.chatId}:${senderId}`, {
        limit: this.config.agent.messageRateLimit,
        windowMs: this.config.agent.messageRateWindowMs
      });
      if (!rate.allowed) {
        this.logger.warn({ chatId: msg.chatId, senderId, retryAfterMs: rate.retryAfterMs }, 'Message rate limit reached');
        this.pipelineEvents?.emitStage?.({
          runId,
          stage: 'gate',
          phase: 'failed',
          label: 'Batas kecepatan pesan tercapai',
          chatId: msg.chatId,
          scope,
          meta: { errorCategory: 'rate_limit', terminal: true },
          runCompleted: true
        });
        return;
      }
    }

    // Acknowledge eligible messages and show live typing while Bubu works.
    // Presence failures must never prevent the actual AI task from running.
    if (typeof this.waha?.sendSeen === 'function') {
      try {
        const seenOpts = msg.eventId
          ? {
              messageIds: [msg.eventId],
              ...(isGroup && msg.senderId ? { participant: msg.senderId } : {})
            }
          : undefined;
        await (seenOpts
          ? this.waha.sendSeen(msg.chatId, seenOpts)
          : this.waha.sendSeen(msg.chatId));
      } catch (error) {
        this.logger.warn({ chatId: msg.chatId, error: error.message }, 'WAHA sendSeen failed');
      }
    }
    const typingKeepalive = typeof this.waha?.createTypingKeepalive === 'function'
      ? this.waha.createTypingKeepalive(msg.chatId, {
          intervalMs: this.config?.waha?.typingKeepaliveMs,
          logger: this.logger
        })
      : null;
    let typingStopped = false;
    const stopTypingOnce = async () => {
      if (typingStopped) return;
      typingStopped = true;
      if (typingKeepalive) {
        try {
          await typingKeepalive.stop();
        } catch (error) {
          this.logger.warn({ chatId: msg.chatId, error: error.message }, 'WAHA typing keepalive stop failed');
        }
      } else if (typeof this.waha?.stopTyping === 'function') {
        try {
          await this.waha.stopTyping(msg.chatId);
        } catch (error) {
          this.logger.warn({ chatId: msg.chatId, error: error.message }, 'WAHA stopTyping failed');
        }
      }
    };
    if (typingKeepalive) {
      try {
        await typingKeepalive.start();
      } catch (error) {
        this.logger.warn({ chatId: msg.chatId, error: error.message }, 'WAHA typing keepalive start failed');
      }
    } else if (typeof this.waha?.startTyping === 'function') {
      try {
        await this.waha.startTyping(msg.chatId);
      } catch (error) {
        this.logger.warn({ chatId: msg.chatId, error: error.message }, 'WAHA startTyping failed');
      }
    }

    const eventId = meta?.eventId || initialEventId;
    const inputKind = msg.hasMedia
      ? (msg.media?.isPtt ? 'voice_note' : 'media')
      : (quoteContext?.present ? 'quote' : 'text');
    this.pipelineEvents?.emitStage?.({
      runId,
      stage: 'gate',
      phase: 'completed',
      label: isGroup ? 'Lolos gerbang grup & presence aktif' : 'Terverifikasi DM pemilik & typing aktif',
      chatId: msg.chatId,
      scope,
      meta: { isGroup, inputKind }
    });
    const canProgressReact = Boolean(
      this.config?.waha?.progressReactions !== false &&
      msg.eventId &&
      typeof this.responseHandler?.sendReaction === 'function'
    );
    let progressReacted = false;
    let progressSettled = false;
    const reactProgress = async (emoji) => {
      if (!canProgressReact) return;
      try {
        await this.responseHandler.sendReaction(msg.chatId, msg.eventId, emoji);
      } catch (err) {
        this.logger?.warn?.({ chatId: msg.chatId, emoji, error: err?.message }, 'WAHA progress reaction failed');
      }
    };

    let runOutcome = 'completed';
    try {
      if (msg.hasMedia) {
        if (msg.isAnimatedSticker) {
          await this.sendMediaNotice(
            'Stiker animasi tidak dapat dibaca oleh Bubu. Kirim gambar statis (JPG/PNG) jika ada teks atau detail yang ingin dianalisis.',
            msg.chatId
          );
          return;
        }
        if (!msg.media?.url) {
          await this.sendMediaNotice(
            'Lampiran terdeteksi, tetapi WAHA tidak menyediakan media.url. Pastikan WAHA media download aktif.',
            msg.chatId
          );
          return;
        }
        try {
          const normalizedMediaUrl = normalizeMediaUrl(msg.media.url, this.config.waha.baseUrl);
          const mediaFilename = msg.media.filename || msg.media.fileName ||
            path.basename(normalizedMediaUrl.pathname);
          const mediaKind = detectMediaKind(mediaFilename, msg.media.mimetype);
          const mediaStarted = Date.now();
          if (mediaKind === 'document') {
            await reactProgress('⏳');
            progressReacted = true;
            this.pipelineEvents?.emitStage?.({
              runId,
              stage: 'multimodal',
              phase: 'started',
              label: 'Mengekstrak dokumen & OCR halaman',
              chatId: msg.chatId,
              scope,
              meta: { mediaKind: 'document' }
            });
            const doc = await this.documentService.ingestMedia({
              media: msg.media,
              scope,
              ownerId: scope === 'personal' ? senderId : null,
              chatId: scope === 'group' ? msg.chatId : null,
              sourceEventId: eventId
            });
            this.pipelineEvents?.emitStage?.({
              runId,
              stage: 'multimodal',
              phase: 'completed',
              label: 'Dokumen selesai diekstrak ke workspace',
              chatId: msg.chatId,
              scope,
              meta: {
                mediaKind: 'document',
                extractionMode: doc.extractionMode || 'text',
                durationMs: Date.now() - mediaStarted
              }
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
          } else if (['image', 'audio', 'video'].includes(mediaKind)) {
            if (!this.config.media.enabled || !this.mediaService) {
              await this.sendMediaNotice(
                'Pemrosesan gambar/audio/video sedang dinonaktifkan.',
                msg.chatId
              );
              return;
            }
            if (mediaKind === 'audio' || mediaKind === 'video') {
              await reactProgress('⏳');
              progressReacted = true;
            }
            this.pipelineEvents?.emitStage?.({
              runId,
              stage: 'multimodal',
              phase: 'started',
              label: mediaKind === 'audio'
                ? 'Transkripsi audio Whisper.cpp + Silero VAD'
                : mediaKind === 'video'
                  ? 'Ekstraksi frame video FFmpeg + audio STT'
                  : 'Normalisasi gambar & OCR Tesseract',
              chatId: msg.chatId,
              scope,
              meta: { mediaKind }
            });
            const processed = await this.mediaService.processIncoming({ media: msg.media });
            this.pipelineEvents?.emitStage?.({
              runId,
              stage: 'multimodal',
              phase: 'completed',
              label: `Pemrosesan media ${mediaKind} selesai`,
              chatId: msg.chatId,
              scope,
              meta: {
                mediaKind,
                ...(processed.visualMode ? { visualMode: processed.visualMode } : {}),
                ...(Array.isArray(processed.frames) ? { frameCount: processed.frames.length } : {}),
                durationMs: Date.now() - mediaStarted
              }
            });
            const extractedText = String(processed.extractedText || '').slice(
              0, this.config.documents.maxExtractChars || 30000
            );
            if (mediaKind === 'audio' && processed.noSpeech) {
              await this.sendMediaNotice(
                'Saya tidak mendeteksi ucapan pada audio tersebut. Silakan kirim ulang voice note yang berisi suara.',
                msg.chatId
              );
              if (progressReacted && !progressSettled) {
                progressSettled = true;
                await reactProgress('✅');
              }
              return;
            }
            if (mediaKind === 'audio' && msg.media.isPtt === true && extractedText) {
              voiceInstruction = extractedText;
              if (!text) text = 'Tolong jalankan instruksi yang saya sampaikan melalui voice note ini.';
              historyUserText = [historyUserText, extractedText].filter(Boolean).join('\n');
            } else {
              attachmentEvidence = this.buildMediaAttachmentEvidence(
                { ...processed, kind: processed.kind || mediaKind },
                mediaFilename,
                this.config.documents.maxExtractChars || 30000
              );
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
          let matchedDoc = null;
          if (quoteContext.quotedMessageId) {
            const candidateKeys = [
              quoteContext.quotedMessageId,
              eventKey({ chatId: msg.chatId, eventId: quoteContext.quotedMessageId }),
              ...(rawChatId && rawChatId !== msg.chatId
                ? [eventKey({ chatId: rawChatId, eventId: quoteContext.quotedMessageId })]
                : [])
            ];
            const keySet = new Set(candidateKeys);
            matchedDoc = workspaceDocs.find((d) =>
              d.source_event_id && keySet.has(d.source_event_id)
            ) || null;
            if (!matchedDoc && typeof this.db?.findDocumentBySourceEvent === 'function') {
              matchedDoc = this.db.findDocumentBySourceEvent({
                scope,
                ownerId: scope === 'personal' ? senderId : null,
                chatId: scope === 'group' ? msg.chatId : null,
                sourceEventIds: candidateKeys
              }) || null;
            }
          }
          if (!matchedDoc && workspaceDocs.length > 0) {
            const quotedTextLower = String(quoteContext.text || '').toLowerCase();
            const quotedMimeLower = String(quoteContext.mimeType || '').toLowerCase();
            const quotedTypeLower = String(quoteContext.type || '').toLowerCase();
            matchedDoc = workspaceDocs.find((d) =>
              d.filename && quotedTextLower && quotedTextLower.includes(String(d.filename).toLowerCase())
            );
            if (!matchedDoc && (quotedTypeLower === 'document' || quotedMimeLower.includes('pdf') || quotedMimeLower.includes('word') || quotedMimeLower.includes('sheet') || quotedMimeLower.includes('excel') || quotedMimeLower.includes('csv'))) {
              matchedDoc = workspaceDocs.find((d) =>
                quotedMimeLower && String(d.mime_type || '').toLowerCase() === quotedMimeLower
              ) || workspaceDocs[0];
            }
          }
          if (matchedDoc) {
            quoteContext.referencedDocument = {
              documentId: matchedDoc.id,
              filename: matchedDoc.filename,
              mimeType: matchedDoc.mime_type || null
            };
          }
        } catch (err) {
          this.logger?.warn?.({ chatId: msg.chatId, error: err.message }, 'Unable to resolve quoted workspace document');
        }
      }

      if (quoteContext?.present && !quoteContext?.rejected &&
          quoteContext.hasMedia && quoteContext.media?.url &&
          !msg.hasMedia && !quoteContext.isSticker && !quoteContext.referencedDocument) {
        try {
          const quotedMedia = quoteContext.media;
          const normalizedQuotedUrl = normalizeMediaUrl(quotedMedia.url, this.config.waha.baseUrl);
          const quotedFilename = quotedMedia.filename || quotedMedia.fileName ||
            path.basename(normalizedQuotedUrl.pathname);
          let quotedMediaKind = detectMediaKind(
            quotedFilename,
            quotedMedia.mimetype || quoteContext.mimeType || ''
          );
          if (quotedMediaKind === 'unknown' && ['image', 'audio', 'video', 'document'].includes(quoteContext.type)) {
            quotedMediaKind = quoteContext.type;
          }
          if (quotedMediaKind === 'document' && this.documentService) {
            const doc = await this.documentService.ingestMedia({
              media: {
                url: quotedMedia.url,
                filename: quotedFilename,
                mimetype: quotedMedia.mimetype || quoteContext.mimeType || ''
              },
              scope,
              ownerId: scope === 'personal' ? senderId : null,
              chatId: scope === 'group' ? msg.chatId : null,
              sourceEventId: quoteContext.quotedMessageId || eventId
            });
            quoteContext.referencedDocument = {
              documentId: doc.id,
              filename: doc.filename,
              mimeType: doc.mime_type || null
            };
            quoteContext.mediaLoaded = true;
            attachmentEvidence = {
              kind: 'document',
              ...(doc.id ? { documentId: doc.id } : {}),
              filename: doc.filename,
              mimeType: doc.mime_type,
              ...(doc.pageCount ? { pageCount: doc.pageCount } : {}),
              ...(doc.extractionMode ? { extractionMode: doc.extractionMode } : {}),
              extractedText: String(doc.extractedText || '').slice(0, this.config.documents.maxExtractChars)
            };
          } else if (['image', 'audio', 'video'].includes(quotedMediaKind) &&
              this.config.media?.enabled && this.mediaService) {
            const processed = await this.mediaService.processIncoming({ media: quotedMedia });
            if (quotedMediaKind !== 'audio' || !processed.noSpeech) {
              attachmentEvidence = this.buildMediaAttachmentEvidence(
                { ...processed, kind: processed.kind || quotedMediaKind },
                quotedFilename,
                this.config.documents.maxExtractChars || 30000
              );
              quoteContext.mediaLoaded = true;
            }
          }
        } catch (quotedErr) {
          const status = Number(quotedErr?.status || quotedErr?.response?.status || quotedErr?.cause?.status || 0);
          if (status === 404 || status === 410 || /expired|tidak ditemukan/i.test(String(quotedErr?.message || ''))) {
            quoteContext.mediaExpired = true;
          } else {
            quoteContext.mediaFetchFailed = true;
          }
          this.logger?.warn?.({
            chatId: msg.chatId,
            status: status || undefined,
            error: quotedErr?.message
          }, 'Unable to process quoted media');
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

      if (!msg.hasMedia) {
        this.pipelineEvents?.emitStage?.({
          runId,
          stage: 'multimodal',
          phase: 'bypassed',
          label: 'Pesan teks langsung melewati stasiun media',
          chatId: msg.chatId,
          scope,
          meta: { bypassed: true }
        });
      }

      if (await handleSlashCommand(this, { text, msg, senderId, owner, isGroup, scope, eventId })) {
        const slashCommand = extractSlashCommand(text) || 'command';
        this.pipelineEvents?.emitStage?.({
          runId,
          stage: 'context',
          phase: 'bypassed',
          label: 'Perintah slash melewati retrieval memori',
          chatId: msg.chatId,
          scope,
          meta: { bypassed: true, slashCommand }
        });
        this.pipelineEvents?.emitStage?.({
          runId,
          stage: 'llm',
          phase: 'bypassed',
          label: 'Perintah slash tidak memanggil model AI',
          chatId: msg.chatId,
          scope,
          meta: { bypassed: true, slashCommand }
        });
        this.pipelineEvents?.emitStage?.({
          runId,
          stage: 'tools',
          phase: 'bypassed',
          label: 'Tanpa tool loop agen',
          chatId: msg.chatId,
          scope,
          meta: { bypassed: true }
        });
        this.pipelineEvents?.emitStage?.({
          runId,
          stage: 'delivery',
          phase: 'completed',
          label: `Respons perintah ${slashCommand} terkirim`,
          chatId: msg.chatId,
          scope,
          meta: { slashCommand, outputMode: 'text' },
          runCompleted: true
        });
        return;
      }

      if (!this.config.agent.enabled) {
        await this.responseHandler.sendText('Bubu Agent sedang dinonaktifkan.', msg.chatId);
        this.pipelineEvents?.emitStage?.({
          runId,
          stage: 'delivery',
          phase: 'completed',
          label: 'Pemberitahuan status agen terkirim',
          chatId: msg.chatId,
          scope,
          meta: { outputMode: 'text' },
          runCompleted: true
        });
        return;
      }

      const history = this.db.getHistory(msg.chatId, scope, 16, eventId);
      this.db.addMessage({
        chatId: msg.chatId, scope, role: 'user',
        senderId, content: historyUserText || text, eventId
      });
      const memoryContext = {
        scope,
        ownerId: scope === 'personal' ? senderId : null,
        chatId: scope === 'group' ? msg.chatId : null
      };
      const taskClass = classifyTask(text);
      const isGreetingFastPath = !msg.hasMedia && !quoteContext && !captionContext && !voiceInstruction && taskClass === 'greeting';
      const passiveGroupMessages = isGroup &&
        this.config.groupPassiveHistory &&
        !isGreetingFastPath &&
        typeof this.db?.getGroupPassiveMessages === 'function'
        ? (this.db.getGroupPassiveMessages(msg.chatId, Math.min(20, this.config.groupPassiveBufferSize || 40)) || [])
        : [];
      if (!progressReacted && !isGreetingFastPath && ['agent', 'reasoning'].includes(taskClass)) {
        await reactProgress('⏳');
        progressReacted = true;
      }
      this.pipelineEvents?.emitStage?.({
        runId,
        stage: 'context',
        phase: 'started',
        label: isGreetingFastPath
          ? 'Jalur cepat sapaan (tanpa retrieval memori)'
          : 'Memuat riwayat chat, memori semantik, & proyek',
        chatId: msg.chatId,
        scope,
        meta: { isFastPath: isGreetingFastPath, taskClass }
      });
      const contextStarted = Date.now();
      const memories = !isGreetingFastPath
        ? (this.memoryService
            ? await this.memoryService.retrieve({ ...memoryContext, query: text, limit: 8 })
            : this.db.searchMemories({ ...memoryContext, query: text, limit: 6 }))
        : [];
      const projects = !isGreetingFastPath && this.memoryService
        ? await this.memoryService.projectContext({ ...memoryContext, query: text, limit: 5 })
        : [];
      this.pipelineEvents?.emitStage?.({
        runId,
        stage: 'context',
        phase: 'completed',
        label: isGreetingFastPath ? 'Konteks jalur cepat siap' : 'Konteks riwayat & memori semantik siap',
        chatId: msg.chatId,
        scope,
        meta: {
          isFastPath: isGreetingFastPath,
          taskClass,
          memoryCount: memories.length,
          projectCount: projects.length,
          durationMs: Date.now() - contextStarted
        }
      });

      const result = await this.agent.run({
        text, chatId: msg.chatId, requesterId: senderId, scope, history, memories, projects,
        captionContext, voiceInstruction, attachmentEvidence, quoteContext,
        ...(passiveGroupMessages.length > 0 ? { passiveGroupMessages } : {}),
        sourceEventId: eventId,
        incomingMessageId: msg.eventId || null
      });
      if (result?.awaitingApproval) {
        runOutcome = 'waiting_approval';
      }
      if (result.text) {
        const responseText = this.db.claimTaskResponse(result.taskId);
        if (responseText !== null) {
          try {
            const outputMode = this.db.getChatOutputMode({
              chatId: msg.chatId,
              requesterId: this.config.ownerJid,
              defaultMode: this.config.media.voiceReplyDefault ? 'both' : 'text'
            });

            const deliveryStarted = Date.now();
            this.pipelineEvents?.emitStage?.({
              runId,
              stage: 'delivery',
              phase: 'started',
              label: outputMode === 'text'
                ? 'Memformat & mengirim balasan teks WhatsApp'
                : 'Menyintesis suara Piper TTS & mengirim balasan',
              chatId: msg.chatId,
              scope,
              meta: {
                outputMode,
                ttsUsed: outputMode !== 'text',
                ...(result?.awaitingApproval ? { approvalStatus: 'awaiting_approval' } : {})
              }
            });

            const deliveryReceipt = isGroup && msg.eventId
              ? await this.responseHandler.sendAssistantResponse(responseText, msg.chatId, outputMode, {
                  replyTo: msg.eventId
                })
              : await this.responseHandler.sendAssistantResponse(responseText, msg.chatId, outputMode);
            const waMessageId = deliveryReceipt?.deliveries?.[0]?.messageId || deliveryReceipt?.messageId || null;
            const willCaptureMemory = Boolean(this.memoryService && !msg.hasMedia && !quoteContext && !isGreetingFastPath);

            this.db.finishTaskResponse(result.taskId, 'sent');
            this.pipelineEvents?.emitStage?.({
              runId,
              stage: 'delivery',
              phase: 'completed',
              label: outputMode === 'text'
                ? 'Balasan teks terkirim ke WhatsApp'
                : 'Balasan suara & teks terkirim ke WhatsApp',
              chatId: msg.chatId,
              scope,
              meta: {
                outputMode,
                ttsUsed: outputMode !== 'text',
                chunks: deliveryReceipt?.deliveries?.[0]?.chunks || 1,
                durationMs: Date.now() - deliveryStarted,
                ...(result?.awaitingApproval ? { approvalStatus: 'awaiting_approval' } : {})
              },
              runCompleted: !willCaptureMemory && !result?.awaitingApproval
            });
            if (progressReacted && !progressSettled) {
              progressSettled = true;
              await reactProgress('✅');
            }
            this.db.addMessage({
              chatId: msg.chatId, scope, role: 'assistant',
              content: responseText, eventId,
              ...(waMessageId ? { waMessageId } : {})
            });
            await stopTypingOnce();
            if (willCaptureMemory) {
              try {
                this.pipelineEvents?.emitStage?.({
                  runId,
                  stage: 'context',
                  phase: 'progress',
                  label: 'Menyimpan memori episodik pasca-percakapan',
                  chatId: msg.chatId,
                  scope,
                  meta: { postTurn: true }
                });
                this.db.saveMemoryEvent({
                  ...memoryContext,
                  eventType: 'conversation_turn',
                  summary: `${memoryEligibleText.slice(0, 500)} => ${responseText.slice(0, 500)}`,
                  sourceEventId: eventId
                });
                const captureResult = await this.memoryService.captureFromTurn({
                  ...memoryContext,
                  userText: memoryEligibleText,
                  assistantText: responseText,
                  sourceEventId: eventId
                });
                if (captureResult?.captured > 0) {
                  await this.memoryService.backfillEmbeddings?.({ ...memoryContext, limit: 2 });
                }
              } catch (memoryError) {
                this.logger.warn({ error: memoryError.message }, 'Memory capture failed');
              }
            }
          } catch (error) {
            this.db.finishTaskResponse(result.taskId, 'uncertain');
            this.pipelineEvents?.emitStage?.({
              runId,
              stage: 'delivery',
              phase: 'failed',
              label: 'Pengiriman balasan WhatsApp bermasalah',
              chatId: msg.chatId,
              scope,
              meta: { errorCategory: 'delivery_uncertain' }
            });
            throw error;
          }
        }
      }
      if (progressReacted && !progressSettled) {
        progressSettled = true;
        await reactProgress('✅');
      }
    } catch (error) {
      runOutcome = 'failed';
      if (progressReacted && !progressSettled) {
        progressSettled = true;
        await reactProgress('❌');
      }
      throw error;
    } finally {
      this.pipelineEvents?.finalizeRunIfActive?.(runId, runOutcome);
      await stopTypingOnce();
    }
  }
}

module.exports = { MessageProcessor, eventKey, hasBotMention };
