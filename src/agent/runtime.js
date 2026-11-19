const crypto = require('node:crypto');
const { classifyTask } = require('./model-router');
const { formatApprovalPrompt } = require('./approval-manager');
const {
  SYSTEM_PROMPT,
  buildAttachmentEvidenceMessage,
  buildAgentMessages
} = require('./prompt-builder');

function parseArguments(raw) {
  try { return JSON.parse(raw || '{}'); }
  catch { throw new Error('Tool arguments were not valid JSON'); }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableTaskId(sourceEventId, fallbackText) {
  const digest = crypto.createHash('sha256')
    .update(sourceEventId || `${Date.now()}-${crypto.randomUUID()}-${fallbackText}`)
    .digest('hex').slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function timeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

class AgentRuntime {
  constructor({ provider, router, tools, db, config, logger }) {
    this.provider = provider;
    this.router = router;
    this.tools = tools;
    this.db = db;
    this.config = config;
    this.logger = logger;
  }

  async run({ text, chatId, requesterId, scope, history = [], memories = [], projects = [], captionContext = null, voiceInstruction = null, attachmentEvidence = null, quoteContext = null, sourceEventId = null, incomingMessageId = null }) {
    const taskId = stableTaskId(sourceEventId, text);
    const existingTask = this.db.getTask(taskId);
    if (existingTask?.status === 'completed') {
      const savedText = existingTask.result_text || '';
      if (savedText) this.db.queueTaskResponse(taskId, savedText);
      return { taskId, task: classifyTask(text), tier: existingTask.model_tier, text: savedText, toolCalls: existingTask.tool_calls || 0, replayed: true };
    }
    if (existingTask?.status === 'awaiting_approval') {
      const pending = this.db.getPendingApprovalForTask(taskId);
      const pendingText = pending
        ? `Tindakan masih menunggu persetujuan. Balas /approve ${pending.id} atau /deny ${pending.id}.`
        : 'Tindakan sedang menunggu pemeriksaan status persetujuan.';
      this.db.queueTaskResponse(taskId, pendingText);
      return {
        taskId, task: classifyTask(text), tier: existingTask.model_tier,
        text: pendingText,
        toolCalls: existingTask.tool_calls || 0, awaitingApproval: true, replayed: true
      };
    }
    if (existingTask?.status === 'uncertain') {
      const notice = 'Status tindakan sebelumnya belum dapat dipastikan. Bubu tidak akan mengulang tindakan otomatis untuk mencegah duplikasi. Periksa statusnya terlebih dahulu.';
      this.db.queueTaskResponse(taskId, notice);
      return { taskId, task: classifyTask(text), tier: existingTask.model_tier, text: notice, toolCalls: existingTask.tool_calls || 0, uncertain: true, replayed: true };
    }
    if (existingTask?.status === 'cancelled') {
      const notice = 'Task sebelumnya sudah dibatalkan atau persetujuannya kedaluwarsa. Kirim instruksi baru jika ingin memulai kembali.';
      this.db.queueTaskResponse(taskId, notice);
      return { taskId, task: classifyTask(text), tier: existingTask.model_tier, text: notice, toolCalls: existingTask.tool_calls || 0, replayed: true };
    }
    const orphanedApproval = this.db.getPendingApprovalForTask(taskId);
    if (orphanedApproval) {
      const message = formatApprovalPrompt({
        id: orphanedApproval.id,
        toolName: orphanedApproval.tool_name,
        args: orphanedApproval.arguments
      });
      this.db.updateTask(taskId, { status: 'awaiting_approval', result_text: message });
      this.db.queueTaskResponse(taskId, message);
      return {
        taskId, task: classifyTask(text), tier: existingTask?.model_tier,
        text: message, awaitingApproval: true, replayed: true
      };
    }

    const task = classifyTask([text, captionContext, voiceInstruction].filter(Boolean).join('\n'));
    const hasVisualImages = Array.isArray(attachmentEvidence?.visualImages) && attachmentEvidence.visualImages.length > 0;
    const selected = this.router.select(
      task,
      hasVisualImages ? { needsTools: true, needsVision: true } : { needsTools: true }
    );
    const context = { taskId, chatId, requesterId, scope, incomingMessageId };
    this.db.createTask({ id: taskId, sourceEventId, chatId, requesterId, scope, requestText: text });
    if (existingTask?.status === 'failed') {
      this.db.updateTask(taskId, { status: 'running', error: null });
    }

    const pendingApprovals = this.db.getPendingApprovalsForChat
      ? this.db.getPendingApprovalsForChat(chatId)
      : [];
    const recentDocuments = typeof this.db.listDocuments === 'function'
      ? (this.db.listDocuments({
          scope,
          ownerId: scope === 'personal' ? requesterId : null,
          chatId: scope === 'group' ? chatId : null,
          limit: 10
        }) || []).map(({ id, filename, mime_type, created_at }) => ({
          documentId: id,
          filename,
          mimeType: mime_type,
          createdAt: created_at
        }))
      : [];

    const attachmentMessage = buildAttachmentEvidenceMessage(attachmentEvidence, { includeVisual: true });
    const messages = buildAgentMessages({
      text,
      scope,
      history,
      memories,
      projects,
      pendingApprovals,
      recentDocuments,
      captionContext,
      voiceInstruction,
      attachmentMessage,
      quoteContext
    });

    let calls = 0;
    let step = this.db.countTaskSteps(taskId);
    const consecutiveSchemaErrorsByTool = new Map();
    let visionFallbackApplied = false;
    const started = Date.now();
    const deadline = started + this.config.agent.taskTimeoutMs;

    try {
      for (let round = 0; round < this.config.agent.maxRounds; round++) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new Error('Agent task timed out');
        const requestStarted = Date.now();
        this.logger.debug({
          taskId, round: round + 1, maxRounds: this.config.agent.maxRounds,
          tier: selected.tier, model: selected.model, messageCount: messages.length
        }, 'Agent model request started');
        let completion;
        try {
          completion = await timeout(this.provider.chat({
            model: selected.model,
            messages,
            tools: this.tools.definitions(scope),
            maxTokens: this.config.agent.maxOutputTokens || 4096
          }), remainingMs, 'Model request');
        } catch (providerError) {
          const status = providerError?.status || providerError?.statusCode || providerError?.response?.status;
          const canFallbackToOcr = hasVisualImages &&
            !visionFallbackApplied &&
            (status === 400 || status === 413 || status === 415 || status === 422 || /visual|image_url|multimodal/i.test(providerError.message || ''));
          if (!canFallbackToOcr) throw providerError;
          visionFallbackApplied = true;
          this.logger.warn({
            taskId,
            model: selected.model,
            error: providerError.message
          }, 'Provider rejected visual input; falling back to labeled OCR/text evidence');
          const fallbackAttachmentMessage = buildAttachmentEvidenceMessage(attachmentEvidence, {
            includeVisual: false,
            forceOcrFallback: true
          });
          const idx = messages.indexOf(attachmentMessage);
          if (idx !== -1 && fallbackAttachmentMessage) {
            messages[idx] = fallbackAttachmentMessage;
          }
          const retryRemainingMs = deadline - Date.now();
          if (retryRemainingMs <= 0) throw new Error('Agent task timed out');
          completion = await timeout(this.provider.chat({
            model: selected.model,
            messages,
            tools: this.tools.definitions(scope),
            maxTokens: this.config.agent.maxOutputTokens || 4096
          }), retryRemainingMs, 'Model request');
        }

        this.db.logModelUsage({
          taskId, modelId: completion.model, tier: selected.tier,
          usage: completion.usage, latencyMs: Date.now() - requestStarted, outcome: 'success'
        });

        const assistantMessage = completion.message;
        const roundToolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
        const responseMeta = {
          taskId,
          round: round + 1,
          finishReason: completion.finishReason || null,
          inputTokens: completion.usage?.prompt_tokens ?? null,
          outputTokens: completion.usage?.completion_tokens ?? null,
          toolCount: roundToolCalls.length,
          toolNames: roundToolCalls.map((item) => item.function?.name || 'unknown')
        };
        this.logger.info?.(responseMeta, 'Agent model response received');
        if (['length', 'max_tokens', 'max_output_tokens'].includes(
          String(completion.finishReason || '').toLowerCase()
        )) {
          this.logger.warn({
            ...responseMeta,
            maxOutputTokens: this.config.agent.maxOutputTokens || 4096
          }, 'Model output reached token limit; tool arguments may be incomplete');
        }
        for (const item of roundToolCalls) {
          const rawArgs = String(item.function?.arguments ?? '');
          let argumentKeys = [];
          let argumentsValidJson = true;
          try {
            const parsed = JSON.parse(rawArgs || '{}');
            argumentKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
              ? Object.keys(parsed) : [];
          } catch {
            argumentsValidJson = false;
          }
          if (!argumentsValidJson || argumentKeys.length === 0) {
            this.logger.warn({
              taskId,
              round: round + 1,
              toolName: item.function?.name || 'unknown',
              argumentBytes: Buffer.byteLength(rawArgs),
              argumentsValidJson,
              argumentKeys
            }, 'Model returned empty or malformed tool arguments');
          }
        }
        if (roundToolCalls.length === 0) {
          const answer = String(assistantMessage.content || '').trim()
            || 'Maaf, Bubu belum menghasilkan jawaban. Silakan coba sekali lagi dengan instruksi yang lebih spesifik.';
          this.db.updateTask(taskId, {
            status: 'completed', result_text: answer,
            model_tier: selected.tier, tool_calls: calls
          });
          this.db.queueTaskResponse(taskId, answer);
          return { taskId, task, tier: selected.tier, model: completion.model, text: answer, toolCalls: calls };
        }

        messages.push(assistantMessage);
        for (const call of assistantMessage.tool_calls) {
          calls++;
          step++;
          if (calls > this.config.agent.maxToolCalls) {
            const notice = 'Bubu menghentikan proses karena batas pemanggilan tool tercapai. Belum semua langkah dapat diselesaikan. Silakan pecah permintaan menjadi beberapa bagian yang lebih kecil.';
            this.db.updateTask(taskId, {
              status: 'completed', result_text: notice,
              model_tier: selected.tier, tool_calls: calls - 1
            });
            this.db.queueTaskResponse(taskId, notice);
            this.logger.warn({ taskId, maxToolCalls: this.config.agent.maxToolCalls }, 'Agent tool-call limit reached');
            return { taskId, task, tier: selected.tier, model: completion.model, text: notice, toolCalls: calls - 1, toolLimitReached: true };
          }

          const name = call.function?.name;
          const toolKey = name || 'unknown';
          const tool = this.tools.get(name);
          const startedTool = Date.now();
          let result;
          let currentToolSchemaErrors = 0;

          let idempotencyKey = null;
          if (!tool || !tool.scopes.includes(scope)) {
            result = { error: 'Tool is not available in this workspace' };
            consecutiveSchemaErrorsByTool.delete(toolKey);
          } else {
            try {
              const args = tool.schema.parse(parseArguments(call.function.arguments));
              idempotencyKey = crypto.createHash('sha256')
                .update(`${taskId}|${name}|${stableStringify(args)}`).digest('hex');
              const prior = this.db.beginToolExecution({ idempotencyKey, taskId, toolName: name });
              if (prior.state === 'completed') {
                result = prior.output;
              } else if (prior.state !== 'claimed') {
                if (prior.state === 'uncertain' && tool.risk === 'external') {
                  const notice = 'Status tindakan eksternal sebelumnya belum dapat dipastikan. Bubu menghentikan task dan tidak akan mengirim ulang otomatis untuk mencegah duplikasi.';
                  this.db.updateTask(taskId, { status: 'uncertain', error: prior.error || notice, model_tier: selected.tier, tool_calls: calls });
                  this.db.queueTaskResponse(taskId, notice);
                  return { taskId, task, tier: selected.tier, model: selected.model, text: notice, toolCalls: calls, uncertain: true };
                }
                result = { error: 'Previous execution status is uncertain; automatic replay is blocked.' };
              } else {
                try {
                  const toolBudget = Math.min(this.config.agent.toolTimeoutMs, Math.max(1, deadline - Date.now()));
                  result = await timeout(tool.execute(args, context), toolBudget, `Tool ${name}`);
                  this.db.completeToolExecution(idempotencyKey, result);
                } catch (error) {
                  const uncertain = tool.risk === 'external' && error?.deliveryStatus !== 'failed';
                  this.db.failToolExecution(idempotencyKey, error.message, uncertain);
                  if (uncertain) {
                    const notice = 'Pengiriman/permintaan eksternal mengalami hasil yang tidak pasti. Bubu tidak akan mengulang tindakan otomatis. Periksa WhatsApp sebelum mencoba lagi.';
                    this.db.updateTask(taskId, { status: 'uncertain', error: error.message, model_tier: selected.tier, tool_calls: calls });
                    this.db.queueTaskResponse(taskId, notice);
                    return { taskId, task, tier: selected.tier, model: completion.model, text: notice, toolCalls: calls, uncertain: true };
                  }
                  throw error;
                }
              }
              consecutiveSchemaErrorsByTool.delete(toolKey);
            } catch (error) {
              result = { error: error.message || 'Tool execution failed' };

              // Model-generated schema errors are not transient tool failures.
              // If the model repeats invalid calls for the same tool, stop the loop
              // and return a useful response instead of retrying the webhook forever.
              const isSchemaError = error?.name === 'ZodError' ||
                error?.message === 'Tool arguments were not valid JSON' ||
                /Tool arguments were not valid JSON|invalid_type|Required|Expected .*received|Unrecognized key|Expected (?:string|number|boolean|null|array|object|one of)|Invalid union/i.test(error?.message || '');
              if (isSchemaError) {
                currentToolSchemaErrors = (consecutiveSchemaErrorsByTool.get(toolKey) || 0) + 1;
                consecutiveSchemaErrorsByTool.set(toolKey, currentToolSchemaErrors);
              } else {
                consecutiveSchemaErrorsByTool.delete(toolKey);
              }
            }
          }

          this.db.addTaskStep({
            taskId, stepNo: step, toolName: name,
            input: { raw: call.function?.arguments || '' },
            output: result,
            status: result?.error ? 'failed' : 'completed',
            durationMs: Date.now() - startedTool
          });
          this.db.audit({
            chatId, actorId: requesterId, action: `tool:${toolKey}`,
            outcome: result?.error ? 'failed' : 'completed',
            details: { taskId, scope }
          });

          if (currentToolSchemaErrors >= 2) {
            const isDocTool = ['create_document', 'create_pdf', 'create_spreadsheet'].includes(name);
            const notice = isDocTool
              ? 'Bubu belum dapat membuat dokumen karena model mengirim parameter tool yang tidak lengkap berulang kali. Tidak ada file yang dibuat. Silakan ulangi permintaan dengan menyebutkan jenis dokumen dan informasi utamanya, atau coba beberapa saat lagi.'
              : `Bubu belum dapat menjalankan tindakan (${toolKey}) karena model mengirim parameter tool yang tidak lengkap berulang kali. Tidak ada tindakan yang dijalankan. Silakan ulangi permintaan dengan informasi yang lebih spesifik, atau coba beberapa saat lagi.`;
            this.db.updateTask(taskId, {
              status: 'completed', result_text: notice,
              model_tier: selected.tier, tool_calls: calls
            });
            this.db.queueTaskResponse(taskId, notice);
            this.logger.warn({
              taskId, toolName: name,
              repeatedInvalidToolCalls: currentToolSchemaErrors,
              argumentBytes: Buffer.byteLength(String(call.function?.arguments || '{}'))
            }, 'Stopping repeated invalid tool-call loop');
            return { taskId, task, tier: selected.tier, model: completion.model, text: notice, toolCalls: calls, toolValidationLoop: true };
          }

          if (result?.pendingApproval) {
            const message = result.prompt || `Tindakan menunggu persetujuan. Balas /approve ${result.approvalId} atau /deny ${result.approvalId}.`;
            this.db.updateTask(taskId, {
              status: 'awaiting_approval', model_tier: selected.tier,
              tool_calls: calls, result_text: message
            });
            this.db.queueTaskResponse(taskId, message);
            return { taskId, task, tier: selected.tier, model: completion.model, text: message, toolCalls: calls, awaitingApproval: true };
          }

          const serializedResult = JSON.stringify(result === undefined ? null : result) ?? 'null';
          const toolContent = serializedResult.slice(0, this.config.agent.maxToolResultChars);
          messages.push({ role: 'tool', tool_call_id: call.id, content: toolContent });
        }
      }

      // A tool may have completed successfully in the final planning round.
      // Give the model one tool-free opportunity to summarize those results.
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error('Agent task timed out before final response');
      const finalCompletion = await timeout(this.provider.chat({
        model: selected.model,
        messages: [
          ...messages,
          {
            role: 'system',
            content: 'You have reached the tool-planning limit. Do not call any more tools. Use the tool results already present in this conversation to provide the final answer. Be concise and state accurately what succeeded or failed.'
          }
        ],
        maxTokens: 1200
      }), remainingMs, 'Final response request');

      const finalAnswer = String(finalCompletion.message?.content || '').trim() ||
        'Bubu sudah menyelesaikan batas pemanggilan tool, tetapi belum menerima ringkasan akhir yang valid. Periksa status hasil tool sebelum mengulangi permintaan.';
      this.db.updateTask(taskId, {
        status: 'completed', result_text: finalAnswer,
        model_tier: selected.tier, tool_calls: calls
      });
      this.db.queueTaskResponse(taskId, finalAnswer);
      return { taskId, task, tier: selected.tier, model: finalCompletion.model || selected.model, text: finalAnswer, toolCalls: calls, finalizedAfterRoundLimit: true };
    } catch (error) {
      this.db.updateTask(taskId, {
        status: 'failed', error: error.message, model_tier: selected.tier, tool_calls: calls
      });
      this.logger.error({ taskId, err: error }, 'Agent task failed');
      throw error;
    } finally {
      this.db.audit({
        chatId, actorId: requesterId, action: 'agent_task_finished',
        outcome: 'finished', details: { taskId, elapsedMs: Date.now() - started, calls }
      });
    }
  }
}

module.exports = {
  AgentRuntime,
  SYSTEM_PROMPT,
  buildAttachmentEvidenceMessage,
  parseArguments,
  timeout,
  stableStringify,
  stableTaskId
};
