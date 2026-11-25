const crypto = require('node:crypto');
const { classifyTask } = require('./model-router');
const { formatApprovalPrompt } = require('./approval-manager');
const { REQUEST_TOOL_GROUP_NAME, ALL_TOOL_GROUPS } = require('./tool-registry');
const { resolveToolGroup } = require('../telemetry/pipeline-events');
const {
  SYSTEM_PROMPT,
  buildAttachmentEvidenceMessage,
  buildAgentMessages
} = require('./prompt-builder');

function isTransientProviderError(error) {
  if (!error) return false;
  const msg = String(error.message || '');
  if (msg === 'Agent task timed out' || msg === 'Agent task timed out before final response') return false;
  const status = Number(error.status || error.statusCode || error.response?.status);
  if ([400, 401, 403, 413, 415, 422].includes(status)) return false;
  if ([429, 500, 502, 503, 504, 529].includes(status)) return true;
  const code = String(error.code || '').toUpperCase();
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE'].includes(code)) return true;
  return /rate.?limit|overloaded|temporarily unavailable|service unavailable|bad gateway|gateway timeout/i.test(msg);
}

function isSchemaValidationError(error) {
  return error?.name === 'ZodError' ||
    error?.message === 'Tool arguments were not valid JSON' ||
    /Tool arguments were not valid JSON|invalid_type|Required|Expected .*received|Unrecognized key|Expected (?:string|number|boolean|null|array|object|one of)|Invalid union/i.test(error?.message || '');
}

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

function timeout(promise, ms, label, abortController = null) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        abortController?.abort();
        reject(new Error(`${label} timed out`));
      }, ms);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

class AgentRuntime {
  constructor({ provider, router, tools, db, config, logger, pipelineEvents = null }) {
    this.provider = provider;
    this.router = router;
    this.tools = tools;
    this.db = db;
    this.config = config;
    this.logger = logger;
    this.pipelineEvents = pipelineEvents;
  }

  async run({ text, chatId, requesterId, scope, history = [], memories = [], projects = [], captionContext = null, voiceInstruction = null, attachmentEvidence = null, quoteContext = null, passiveGroupMessages = [], sourceEventId = null, incomingMessageId = null }) {
    const taskId = stableTaskId(sourceEventId, text);
    const runId = String(sourceEventId || taskId).slice(0, 12);
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

    const combinedText = [text, captionContext, voiceInstruction].filter(Boolean).join('\n');
    const task = classifyTask(combinedText);
    const hasVisualImages = Array.isArray(attachmentEvidence?.visualImages) && attachmentEvidence.visualImages.length > 0;
    let selected = this.router.select(
      task,
      hasVisualImages ? { needsTools: true, needsVision: true } : { needsTools: true }
    );
    const memoryToolsAvailable = Boolean(this.tools?.get?.('consolidate_memories'));
    let escalatedFromTier = null;
    const maybeEscalateTier = () => {
      if (selected.tier !== 'fast' || typeof this.router?.select !== 'function') return;
      try {
        const candidate = this.router.select('general_chat', {
          needsTools: true,
          needsVision: hasVisualImages
        });
        if (candidate?.model && candidate.tier && candidate.tier !== selected.tier) {
          escalatedFromTier = selected.tier;
          this.logger?.info?.({
            taskId,
            fromTier: selected.tier,
            toTier: candidate.tier,
            fromModel: selected.model,
            toModel: candidate.model
          }, 'Escalating agent model tier for follow-up tool synthesis');
          this.pipelineEvents?.emitStage?.({
            runId,
            stage: 'llm',
            phase: 'progress',
            label: 'Eskalasi tier model untuk sintesis tool',
            chatId,
            scope,
            meta: {
              escalatedFromTier: selected.tier,
              modelTier: candidate.tier,
              modelId: candidate.model
            }
          });
          selected = candidate;
        }
      } catch {
        // Keep fast tier when no higher tier supports tools/vision.
      }
    };
    const context = { taskId, chatId, requesterId, scope, incomingMessageId };
    this.db.createTask({ id: taskId, sourceEventId, chatId, requesterId, scope, requestText: text });
    if (existingTask?.status === 'failed') {
      this.db.updateTask(taskId, { status: 'running', error: null });
    }

    const pendingApprovals = this.db.getPendingApprovalsForChat
      ? this.db.getPendingApprovalsForChat(chatId)
      : [];
    const isGreetingFastPath = task === 'greeting' && !hasVisualImages && !attachmentEvidence && !quoteContext;
    const recentDocuments = !isGreetingFastPath && typeof this.db.listDocuments === 'function'
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
      quoteContext,
      passiveGroupMessages,
      timezone: this.config?.appTimezone || 'Asia/Jakarta'
    });

    const enabledToolGroups = new Set();
    const resolveRoundTools = (activeTask = task) => {
      if (typeof this.tools?.definitionsForContext === 'function') {
        return this.tools.definitionsForContext(scope, {
          task: activeTask,
          text: combinedText,
          quoteText: quoteContext?.text || '',
          hasAttachment: Boolean(attachmentEvidence),
          hasRecentDocuments: recentDocuments.length > 0,
          hasQuote: Boolean(quoteContext?.present),
          hasPendingApprovals: pendingApprovals.length > 0,
          enabledGroups: enabledToolGroups
        });
      }
      return this.tools.definitions(scope);
    };

    let calls = 0;
    let step = this.db.countTaskSteps(taskId);
    const consecutiveSchemaErrorsByTool = new Map();
    let visionFallbackApplied = false;
    const started = Date.now();
    const deadline = started + this.config.agent.taskTimeoutMs;

    const callModelWithFallback = async ({
      modelMessages,
      toolsDefs,
      maxTokens,
      label = 'Model request',
      timeoutMessage = 'Agent task timed out',
      taskForRouting = task,
      needsVision = false
    }) => {
      const candidates = [selected];
      const seenModels = new Set([selected.model]);
      if (typeof this.router?.selectCandidates === 'function') {
        try {
          const extras = this.router.selectCandidates(taskForRouting, {
            needsTools: Array.isArray(toolsDefs) && toolsDefs.length > 0,
            needsVision
          });
          for (const candidate of extras) {
            if (candidates.length >= 3) break;
            if (!candidate?.model || seenModels.has(candidate.model)) continue;
            seenModels.add(candidate.model);
            candidates.push(candidate);
          }
        } catch {
          // Keep primary candidate when fallback discovery fails.
        }
      }

      for (let idx = 0; idx < candidates.length; idx++) {
        const candidate = candidates[idx];
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new Error(timeoutMessage);
        const requestStarted = Date.now();
        const controller = new AbortController();
        try {
          const completion = await timeout(this.provider.chat({
            model: candidate.model,
            messages: modelMessages,
            ...(toolsDefs !== undefined ? { tools: toolsDefs } : {}),
            maxTokens,
            signal: controller.signal
          }), remainingMs, label, controller);
          if (candidate.model !== selected.model) {
            selected = candidate;
          }
          return { completion, requestStarted };
        } catch (error) {
          this.db.logModelUsage?.({
            taskId, modelId: candidate.model, tier: candidate.tier,
            usage: null, latencyMs: Date.now() - requestStarted, outcome: 'error'
          });
          const hasNext = idx < candidates.length - 1;
          if (!hasNext || !isTransientProviderError(error) || (deadline - Date.now()) <= 200) {
            throw error;
          }
          const nextCandidate = candidates[idx + 1];
          this.logger?.warn?.({
            taskId,
            fromModel: candidate.model,
            fromTier: candidate.tier,
            toModel: nextCandidate.model,
            toTier: nextCandidate.tier,
            error: error?.message
          }, 'Transient provider error; falling back to next model candidate');
          this.pipelineEvents?.emitStage?.({
            runId,
            stage: 'llm',
            phase: 'progress',
            label: 'Fallback ke kandidat model berikutnya',
            chatId,
            scope,
            meta: {
              fallbackFromModel: candidate.model,
              modelId: nextCandidate.model,
              modelTier: nextCandidate.tier
            }
          });
        }
      }
      throw new Error('No model candidate succeeded');
    };

    const runToolCall = async (call, completionModel) => {
      const name = call.function?.name;
      const toolKey = name || 'unknown';
      const startedTool = Date.now();
      let result;
      let isSchemaError = false;
      let earlyReturn = null;

      if (name === REQUEST_TOOL_GROUP_NAME) {
        try {
          const parsedArgs = parseArguments(call.function?.arguments);
          const groupName = typeof parsedArgs?.group === 'string' ? parsedArgs.group.trim() : '';
          if (!ALL_TOOL_GROUPS.includes(groupName)) {
            throw new Error(`Invalid union: group must be one of ${ALL_TOOL_GROUPS.join(', ')}`);
          }
          enabledToolGroups.add(groupName);
          const availableTools = typeof this.tools?.list === 'function'
            ? this.tools.list(scope).filter((t) => t.group === groupName && !t.aliasOf).map((t) => t.name)
            : [];
          result = { enabled: true, group: groupName, tools: availableTools };
        } catch (error) {
          result = { error: error.message || 'Invalid tool group request' };
          isSchemaError = isSchemaValidationError(error);
        }
        return {
          name,
          toolKey,
          durationMs: Date.now() - startedTool,
          result,
          isSchemaError,
          earlyReturn: null
        };
      }

      const tool = this.tools.get(name);
      let idempotencyKey = null;
      if (!tool || !tool.scopes.includes(scope)) {
        result = { error: 'Tool is not available in this workspace' };
      } else {
        try {
          const args = tool.schema.parse(parseArguments(call.function?.arguments));
          idempotencyKey = crypto.createHash('sha256')
            .update(`${taskId}|${name}|${stableStringify(args)}`).digest('hex');
          const prior = this.db.beginToolExecution({ idempotencyKey, taskId, toolName: name });
          if (prior.state === 'completed') {
            result = prior.output;
          } else if (prior.state !== 'claimed') {
            if (prior.state === 'uncertain' && tool.risk === 'external') {
              const notice = 'Status tindakan eksternal sebelumnya belum dapat dipastikan. Bubu menghentikan task dan tidak akan mengirim ulang otomatis untuk mencegah duplikasi.';
              earlyReturn = { type: 'uncertain', notice, error: prior.error || notice, model: selected.model };
            } else {
              result = { error: 'Previous execution status is uncertain; automatic replay is blocked.' };
            }
          } else {
            try {
              const toolBudget = Math.min(this.config.agent.toolTimeoutMs, Math.max(1, deadline - Date.now()));
              const toolController = new AbortController();
              result = await timeout(
                tool.execute(args, { ...context, signal: toolController.signal }),
                toolBudget,
                `Tool ${name}`,
                toolController
              );
              this.db.completeToolExecution(idempotencyKey, result);
            } catch (error) {
              const uncertain = tool.risk === 'external' && error?.deliveryStatus !== 'failed';
              this.db.failToolExecution(idempotencyKey, error.message, uncertain);
              if (uncertain) {
                const notice = 'Pengiriman/permintaan eksternal mengalami hasil yang tidak pasti. Bubu tidak akan mengulang tindakan otomatis. Periksa WhatsApp sebelum mencoba lagi.';
                earlyReturn = { type: 'uncertain', notice, error: error.message, model: completionModel };
              } else {
                throw error;
              }
            }
          }
        } catch (error) {
          result = { error: error.message || 'Tool execution failed' };
          isSchemaError = isSchemaValidationError(error);
        }
      }

      return {
        name,
        toolKey,
        durationMs: Date.now() - startedTool,
        result,
        isSchemaError,
        earlyReturn
      };
    };

    const isParallelizableReadOnlyCall = (call) => {
      const name = call?.function?.name;
      if (!name || name === REQUEST_TOOL_GROUP_NAME) return false;
      const tool = this.tools.get(name);
      return Boolean(tool && Array.isArray(tool.scopes) && tool.scopes.includes(scope) && tool.risk === 'low' && tool.readOnly === true);
    };

    const recordToolOutcome = ({ call, stepNo, outcome, completionModel }) => {
      const { name, toolKey, durationMs, result, isSchemaError, earlyReturn } = outcome;
      if (earlyReturn?.type === 'uncertain') {
        this.db.updateTask(taskId, {
          status: 'uncertain',
          error: earlyReturn.error,
          model_tier: selected.tier,
          tool_calls: calls
        });
        this.db.queueTaskResponse(taskId, earlyReturn.notice);
        return {
          taskId,
          task,
          tier: selected.tier,
          model: earlyReturn.model,
          text: earlyReturn.notice,
          toolCalls: calls,
          uncertain: true,
          memoryToolsAvailable,
          ...(escalatedFromTier ? { escalatedFromTier } : {})
        };
      }

      let currentToolSchemaErrors = 0;
      if (isSchemaError) {
        currentToolSchemaErrors = (consecutiveSchemaErrorsByTool.get(toolKey) || 0) + 1;
        consecutiveSchemaErrorsByTool.set(toolKey, currentToolSchemaErrors);
      } else {
        consecutiveSchemaErrorsByTool.delete(toolKey);
      }

      this.db.addTaskStep({
        taskId, stepNo, toolName: name,
        input: { raw: call.function?.arguments || '' },
        output: result,
        status: result?.error ? 'failed' : 'completed',
        durationMs
      });
      this.pipelineEvents?.emitStage?.({
        runId,
        stage: 'tools',
        phase: result?.pendingApproval ? 'waiting' : (result?.error ? 'failed' : 'completed'),
        label: result?.pendingApproval
          ? 'Menunggu persetujuan pemilik (/approve)'
          : (result?.error ? `Tool ${toolKey} gagal` : `Hasil tool ${toolKey} diterima`),
        chatId,
        scope,
        meta: {
          toolName: toolKey,
          toolGroup: resolveToolGroup(this.tools, name),
          durationMs,
          ...(result?.pendingApproval ? { pendingApproval: true } : {})
        }
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
        return {
          taskId,
          task,
          tier: selected.tier,
          model: completionModel,
          text: notice,
          toolCalls: calls,
          toolValidationLoop: true,
          memoryToolsAvailable,
          ...(escalatedFromTier ? { escalatedFromTier } : {})
        };
      }

      if (result?.pendingApproval) {
        const message = result.prompt || `Tindakan menunggu persetujuan. Balas /approve ${result.approvalId} atau /deny ${result.approvalId}.`;
        this.db.updateTask(taskId, {
          status: 'awaiting_approval', model_tier: selected.tier,
          tool_calls: calls, result_text: message
        });
        this.db.queueTaskResponse(taskId, message);
        return {
          taskId,
          task,
          tier: selected.tier,
          model: completionModel,
          text: message,
          toolCalls: calls,
          awaitingApproval: true,
          memoryToolsAvailable,
          ...(escalatedFromTier ? { escalatedFromTier } : {})
        };
      }

      const serializedResult = JSON.stringify(result === undefined ? null : result) ?? 'null';
      const toolContent = serializedResult.slice(0, this.config.agent.maxToolResultChars);
      messages.push({ role: 'tool', tool_call_id: call.id, content: toolContent });
      return null;
    };

    try {
      for (let round = 0; round < this.config.agent.maxRounds; round++) {
        if (round >= 1 && selected.tier === 'fast') {
          maybeEscalateTier();
        }
        if (deadline - Date.now() <= 0) throw new Error('Agent task timed out');
        const roundTask = round >= 1 && task === 'greeting' ? 'general_chat' : task;
        const roundTools = resolveRoundTools(roundTask);
        const maxTokens = this.config.agent.maxOutputTokens || 4096;
        this.logger.debug({
          taskId, round: round + 1, maxRounds: this.config.agent.maxRounds,
          tier: selected.tier, model: selected.model, messageCount: messages.length,
          toolSchemaCount: roundTools.length
        }, 'Agent model request started');
        this.pipelineEvents?.emitStage?.({
          runId,
          stage: 'llm',
          phase: 'started',
          label: `Memproses penalaran model Sumopod (Putaran ${round + 1})`,
          chatId,
          scope,
          meta: {
            taskClass: task,
            modelTier: selected.tier,
            modelId: selected.model,
            round: round + 1,
            maxRounds: this.config.agent.maxRounds,
            toolSchemaCount: roundTools.length
          }
        });
        let completion;
        let requestStarted = Date.now();
        try {
          const callRes = await callModelWithFallback({
            modelMessages: messages,
            toolsDefs: roundTools,
            maxTokens,
            label: 'Model request',
            timeoutMessage: 'Agent task timed out',
            taskForRouting: roundTask,
            needsVision: hasVisualImages && !visionFallbackApplied
          });
          completion = callRes.completion;
          requestStarted = callRes.requestStarted;
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
          const retryRes = await callModelWithFallback({
            modelMessages: messages,
            toolsDefs: roundTools,
            maxTokens,
            label: 'Model request',
            timeoutMessage: 'Agent task timed out',
            taskForRouting: roundTask,
            needsVision: false
          });
          completion = retryRes.completion;
          requestStarted = retryRes.requestStarted;
        }

        this.db.logModelUsage?.({
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
        this.pipelineEvents?.emitStage?.({
          runId,
          stage: 'llm',
          phase: roundToolCalls.length === 0 ? 'completed' : 'progress',
          label: roundToolCalls.length === 0 ? 'Jawaban final selesai disusun' : 'Model memilih pemanggilan tool',
          chatId,
          scope,
          meta: {
            modelTier: selected.tier,
            modelId: completion.model || selected.model,
            round: round + 1,
            latencyMs: Date.now() - requestStarted,
            inputTokens: completion.usage?.prompt_tokens ?? 0,
            outputTokens: completion.usage?.completion_tokens ?? 0,
            toolCount: roundToolCalls.length
          }
        });
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
          if (calls === 0) {
            this.pipelineEvents?.emitStage?.({
              runId,
              stage: 'tools',
              phase: 'bypassed',
              label: 'Tidak memerlukan eksekusi tool',
              chatId,
              scope,
              meta: { bypassed: true }
            });
          }
          const answer = String(assistantMessage.content || '').trim()
            || 'Maaf, Bubu belum menghasilkan jawaban. Silakan coba sekali lagi dengan instruksi yang lebih spesifik.';
          this.db.updateTask(taskId, {
            status: 'completed', result_text: answer,
            model_tier: selected.tier, tool_calls: calls
          });
          this.db.queueTaskResponse(taskId, answer);
          return {
            taskId,
            task,
            tier: selected.tier,
            model: completion.model,
            text: answer,
            toolCalls: calls,
            memoryToolsAvailable,
            ...(escalatedFromTier ? { escalatedFromTier } : {})
          };
        }

        messages.push(assistantMessage);
        let idx = 0;
        while (idx < roundToolCalls.length) {
          if (calls >= this.config.agent.maxToolCalls) {
            calls++;
            const notice = 'Bubu menghentikan proses karena batas pemanggilan tool tercapai. Belum semua langkah dapat diselesaikan. Silakan pecah permintaan menjadi beberapa bagian yang lebih kecil.';
            this.db.updateTask(taskId, {
              status: 'completed', result_text: notice,
              model_tier: selected.tier, tool_calls: calls - 1
            });
            this.db.queueTaskResponse(taskId, notice);
            this.logger.warn({ taskId, maxToolCalls: this.config.agent.maxToolCalls }, 'Agent tool-call limit reached');
            return {
              taskId,
              task,
              tier: selected.tier,
              model: completion.model,
              text: notice,
              toolCalls: calls - 1,
              toolLimitReached: true,
              memoryToolsAvailable,
              ...(escalatedFromTier ? { escalatedFromTier } : {})
            };
          }

          const batch = [];
          const seenSignatures = new Set();
          let cursor = idx;
          while (
            cursor < roundToolCalls.length &&
            calls + batch.length < this.config.agent.maxToolCalls &&
            isParallelizableReadOnlyCall(roundToolCalls[cursor])
          ) {
            const c = roundToolCalls[cursor];
            const sig = `${c.function?.name}|${String(c.function?.arguments || '')}`;
            if (seenSignatures.has(sig)) break;
            seenSignatures.add(sig);
            batch.push(c);
            cursor++;
          }

          if (batch.length >= 2) {
            const baseStep = step;
            calls += batch.length;
            step += batch.length;
            const batchNames = batch.map((c) => c.function?.name || 'unknown');
            const batchGroups = [...new Set(batchNames.map((n) => resolveToolGroup(this.tools, n)))];
            this.pipelineEvents?.emitStage?.({
              runId,
              stage: 'tools',
              phase: 'started',
              label: 'Menjalankan batch tool paralel (read-only)',
              chatId,
              scope,
              meta: {
                parallel: true,
                parallelTools: batchNames,
                toolGroups: batchGroups,
                toolGroup: batchGroups[0] || 'core',
                toolCount: batch.length
              }
            });
            const outcomes = await Promise.all(batch.map((c) => runToolCall(c, completion.model)));
            for (let b = 0; b < batch.length; b++) {
              const exitResult = recordToolOutcome({
                call: batch[b],
                stepNo: baseStep + b + 1,
                outcome: outcomes[b],
                completionModel: completion.model
              });
              if (exitResult) return exitResult;
            }
            idx += batch.length;
            continue;
          }

          const call = roundToolCalls[idx];
          calls++;
          step++;
          const singleToolName = call.function?.name || 'unknown';
          this.pipelineEvents?.emitStage?.({
            runId,
            stage: 'tools',
            phase: 'started',
            label: `Menjalankan tool ${singleToolName}`,
            chatId,
            scope,
            meta: {
              parallel: false,
              toolName: singleToolName,
              toolGroup: resolveToolGroup(this.tools, singleToolName)
            }
          });
          const outcome = await runToolCall(call, completion.model);
          const exitResult = recordToolOutcome({
            call,
            stepNo: step,
            outcome,
            completionModel: completion.model
          });
          if (exitResult) return exitResult;
          idx += 1;
        }

        if (selected.tier === 'fast') {
          maybeEscalateTier();
        }
      }

      // A tool may have completed successfully in the final planning round.
      // Give the model one tool-free opportunity to summarize those results.
      const finalRes = await callModelWithFallback({
        modelMessages: [
          ...messages,
          {
            role: 'system',
            content: 'You have reached the tool-planning limit. Do not call any more tools. Use the tool results already present in this conversation to provide the final answer. Be concise and state accurately what succeeded or failed.'
          }
        ],
        toolsDefs: undefined,
        maxTokens: 2400,
        label: 'Final response request',
        timeoutMessage: 'Agent task timed out before final response',
        taskForRouting: task === 'greeting' ? 'general_chat' : task,
        needsVision: false
      });
      const finalCompletion = finalRes.completion;
      const finalStarted = finalRes.requestStarted;

      this.db.logModelUsage?.({
        taskId,
        modelId: finalCompletion.model || selected.model,
        tier: selected.tier,
        usage: finalCompletion.usage || null,
        latencyMs: Date.now() - finalStarted,
        outcome: 'success'
      });

      const finalAnswer = String(finalCompletion.message?.content || '').trim() ||
        'Bubu sudah menyelesaikan batas pemanggilan tool, tetapi belum menerima ringkasan akhir yang valid. Periksa status hasil tool sebelum mengulangi permintaan.';
      this.db.updateTask(taskId, {
        status: 'completed', result_text: finalAnswer,
        model_tier: selected.tier, tool_calls: calls
      });
      this.db.queueTaskResponse(taskId, finalAnswer);
      return {
        taskId,
        task,
        tier: selected.tier,
        model: finalCompletion.model || selected.model,
        text: finalAnswer,
        toolCalls: calls,
        finalizedAfterRoundLimit: true,
        memoryToolsAvailable,
        ...(escalatedFromTier ? { escalatedFromTier } : {})
      };
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
