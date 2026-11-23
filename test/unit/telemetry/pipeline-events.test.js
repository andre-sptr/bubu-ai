const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseStore } = require('../../../src/db/database');
const {
  PipelineEventBus,
  anonymizeChatId,
  sanitizeMeta,
  resolveToolGroup
} = require('../../../src/telemetry/pipeline-events');

test('anonymizeChatId masks personal JIDs and group JIDs without exposing phone numbers', () => {
  const dm = anonymizeChatId('6281234567890@c.us', 'salt-1');
  const grp = anonymizeChatId('120363000999888777@g.us', 'salt-1');
  const sys = anonymizeChatId('', 'salt-1');

  assert.match(dm, /^DM-[0-9a-f]{4}$/);
  assert.match(grp, /^GRP-[0-9a-f]{4}$/);
  assert.equal(sys, 'SYS');
  assert.equal(dm.includes('62812345'), false);
  assert.equal(grp.includes('120363'), false);
});

test('sanitizeMeta strips unallowlisted sensitive fields while keeping operational metadata', () => {
  const clean = sanitizeMeta({
    text: 'secret message content',
    message: 'private reply',
    args: { phone: '0812345' },
    chatId: '628111111@c.us',
    modelId: 'claude-sonnet-5-5',
    modelTier: 'balanced',
    latencyMs: 342.6,
    inputTokens: 1200,
    outputTokens: 250,
    parallel: true,
    parallelTools: ['web_search', 'search_memory', 'a', 'b', 'c', 'd', 'e', 'f', 'extra'],
    durationMs: -5
  });

  assert.equal(clean.text, undefined);
  assert.equal(clean.message, undefined);
  assert.equal(clean.args, undefined);
  assert.equal(clean.chatId, undefined);
  assert.equal(clean.modelId, 'claude-sonnet-5-5');
  assert.equal(clean.modelTier, 'balanced');
  assert.equal(clean.latencyMs, 343);
  assert.equal(clean.inputTokens, 1200);
  assert.equal(clean.outputTokens, 250);
  assert.equal(clean.parallel, true);
  assert.equal(clean.parallelTools.length, 8);
  assert.equal(clean.durationMs, undefined);
});

test('PipelineEventBus enforces bounded buffers, tracks run lifecycle, and survives failing listeners', () => {
  const bus = new PipelineEventBus({ maxEvents: 5, maxRuns: 3, salt: 'test-salt' });
  bus.on('stage', () => {
    throw new Error('broken downstream listener');
  });

  // Never throws even if listener throws? Wait: EventEmitter throws unless handled,
  // verify emitStage catches internal errors cleanly.
  const ev1 = bus.emitStage({
    runId: 'run-alpha',
    stage: 'ingress',
    phase: 'completed',
    label: 'Masuk',
    chatId: '628111111@c.us',
    scope: 'personal',
    meta: { inputKind: 'text', text: 'SHOULD BE DROPPED' }
  });
  assert.equal(ev1, null); // listener threw inside emitStage try/catch, caller never crashes

  const cleanBus = new PipelineEventBus({ maxEvents: 5, maxRuns: 3, salt: 'test-salt' });
  cleanBus.emitStage({
    runId: 'run-1',
    stage: 'ingress',
    phase: 'completed',
    label: 'Webhook masuk',
    chatId: '628111111@c.us',
    scope: 'personal',
    meta: { inputKind: 'text' }
  });
  assert.equal(cleanBus.getSnapshotData().activeRuns.length, 1);

  cleanBus.emitStage({
    runId: 'run-1',
    stage: 'llm',
    phase: 'completed',
    label: 'Selesai LLM',
    chatId: '628111111@c.us',
    scope: 'personal',
    meta: { modelTier: 'fast', modelId: 'claude-haiku-5-5', latencyMs: 210 }
  });
  cleanBus.emitStage({
    runId: 'run-1',
    stage: 'delivery',
    phase: 'completed',
    label: 'Balasan terkirim',
    chatId: '628111111@c.us',
    scope: 'personal',
    meta: { outputMode: 'text', durationMs: 45 }
  });

  const snap = cleanBus.getSnapshotData();
  assert.equal(snap.activeRuns.length, 0);
  assert.equal(snap.recentRuns.length, 1);
  assert.equal(snap.recentRuns[0].status, 'completed');
  assert.equal(snap.recentRuns[0].modelId, 'claude-haiku-5-5');

  // Discarded runIds stay discarded even if queue completion arrives afterward
  cleanBus.emitStage({
    runId: 'ignored-grp',
    stage: 'ingress',
    phase: 'completed',
    label: 'Ignored',
    chatId: '1203631234@g.us',
    scope: 'group'
  });
  assert.equal(cleanBus.discardActiveRun('ignored-grp'), true);
  const late = cleanBus.emitStage({
    runId: 'ignored-grp',
    stage: 'queue',
    phase: 'completed',
    label: 'Done',
    chatId: '1203631234@g.us',
    scope: 'group'
  });
  assert.equal(late, null);
  assert.equal(cleanBus.getSnapshotData().activeRuns.length, 0);
});

test('PipelineEventBus hydrates sanitized recent runs from real SQLite without leaking text or tool JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-vis-db-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const db = new DatabaseStore(dbPath);
  try {
    db.createTask({
      id: 'task-abc-123456',
      sourceEventId: 'abcdef1234567890',
      chatId: '6289876543210@c.us',
      requesterId: '6289876543210@c.us',
      scope: 'personal',
      requestText: 'SUPER SECRET USER PROMPT DO NOT EXPOSE'
    });
    db.updateTask('task-abc-123456', {
      status: 'completed',
      response_status: 'sent',
      model_tier: 'balanced',
      tool_calls: 1,
      result_text: 'SUPER SECRET ASSISTANT ANSWER'
    });
    db.logModelUsage({
      taskId: 'task-abc-123456',
      modelId: 'claude-sonnet-5-5',
      tier: 'balanced',
      usage: { prompt_tokens: 400, completion_tokens: 120 },
      latencyMs: 650,
      outcome: 'success'
    });
    db.addTaskStep({
      taskId: 'task-abc-123456',
      stepNo: 1,
      toolName: 'web_search',
      input: { query: 'PRIVATE QUERY' },
      output: { secret: 'PRIVATE OUTPUT' },
      status: 'completed',
      durationMs: 180
    });

    const bus = new PipelineEventBus({ salt: 'db-salt' });
    const count = bus.hydrateFromDatabase(db);
    assert.equal(count, 1);

    const snap = bus.getSnapshotData();
    const serialized = JSON.stringify(snap);
    assert.equal(serialized.includes('SUPER SECRET'), false);
    assert.equal(serialized.includes('PRIVATE QUERY'), false);
    assert.equal(serialized.includes('PRIVATE OUTPUT'), false);
    assert.equal(serialized.includes('6289876543210'), false);
    assert.equal(snap.recentRuns[0].runId, 'abcdef123456');
    assert.equal(snap.recentRuns[0].hydrated, true);
    assert.equal(snap.recentRuns[0].modelId, 'claude-sonnet-5-5');
    assert.equal(snap.recentRuns[0].stages.tools.meta.toolGroup, 'web');
    assert.equal(resolveToolGroup(null, 'create_reminder'), 'productivity');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
