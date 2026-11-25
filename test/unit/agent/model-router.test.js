const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyTask, ModelRouter } = require('../../../src/agent/model-router');

test('greeting routes to fast tier', () => assert.equal(classifyTask('Halo Bubu'), 'greeting'));
test('summary routes to summary tier', () => assert.equal(classifyTask('Tolong rangkum ini'), 'summarize'));
test('coding request routes to coding tier', () => assert.equal(classifyTask('Debug kode JavaScript'), 'coding'));
test('multi-step request routes to agent tier', () => assert.equal(classifyTask('Carikan jurnal lalu buat ringkasan'), 'agent'));
test('router selects benchmark-informed tier without per-model validation flags', () => {
  const router = new ModelRouter({
    fast: { id: 'gemini-fast' },
    balanced: { id: 'gemini-general' },
    reasoning: { id: 'claude-opus' }
  });
  assert.deepEqual(router.select('greeting', { needsTools: true }), {
    tier: 'fast', model: 'gemini-fast', supportsTools: true
  });
  assert.equal(router.select('agent', { needsTools: true }).model, 'claude-opus');
});
test('router startup readiness only requires configured model IDs', () => {
  assert.throws(() => new ModelRouter({}).assertReady(), /No Sumopod model/);
  assert.doesNotThrow(() => new ModelRouter({ balanced: { id: 'x' } }).assertReady());
});

test('long or multi-sentence prompts starting with Halo do not route to fast greeting tier', () => {
  assert.equal(classifyTask('Halo!'), 'greeting');
  assert.equal(
    classifyTask('Halo, tolong bantu analisis arsitektur database untuk proyek kita minggu depan'),
    'reasoning'
  );
  assert.equal(
    classifyTask('Halo Bubu. Bagaimana progres proyek yang kita bahas kemarin sore ya.'),
    'general_chat'
  );
  assert.equal(classifyTask('Halo! Tolong rangkum catatan rapat.'), 'summarize');
});

test('router skips tiers whose supportsTools is explicitly false when needsTools is true', () => {
  const router = new ModelRouter({
    fast: { id: 'no-tools-fast', supportsTools: false },
    balanced: { id: 'sonnet-balanced', supportsTools: true }
  });
  assert.deepEqual(router.select('greeting', { needsTools: true }), {
    tier: 'balanced', model: 'sonnet-balanced', supportsTools: true
  });
});

test('default attachment boilerplate prompts do not force reasoning/agent tier', () => {
  assert.equal(classifyTask('Tolong baca dan jelaskan dokumen yang saya kirim.'), 'general_chat');
  assert.equal(
    classifyTask('Tolong jalankan instruksi yang saya sampaikan melalui voice note ini.\nApakah kamu mengerti yang aku katakan?'),
    'simple_question'
  );
  assert.equal(
    classifyTask('Tolong jalankan instruksi yang saya sampaikan melalui voice note ini.\nHalo Bubu'),
    'greeting'
  );
  assert.equal(
    classifyTask('Tolong jalankan instruksi yang saya sampaikan melalui voice note ini.\nTolong rangkum catatan rapat ini'),
    'summarize'
  );
  assert.equal(
    classifyTask('Tolong jalankan instruksi yang saya sampaikan melalui voice note ini.\nTolong kirim pesan ke Budi'),
    'tool_action'
  );
  assert.equal(classifyTask('Tolong kirim dokumen laporan ke Budi'), 'tool_action');
  assert.equal(classifyTask('Carikan berita AI terbaru lalu kirim ringkasannya ke grup'), 'agent');
});

test('Stage 2: router selectCandidates returns ordered deduplicated fallback models', () => {
  const router = new ModelRouter({
    fast: { id: 'claude-haiku-5-5', supportsTools: true, supportsVision: false },
    balanced: { id: 'claude-sonnet-5-5', supportsTools: true, supportsVision: true },
    coding: { id: 'claude-sonnet-5-5', supportsTools: true, supportsVision: false },
    summary: { id: 'gemini/gemini-3.1-pro-preview', supportsTools: true, supportsVision: false },
    reasoning: { id: 'claude-opus-5-5', supportsTools: true, supportsVision: false },
    vision: { id: 'claude-sonnet-5-5', supportsTools: true, supportsVision: true }
  });

  const singleAction = classifyTask('Tolong kirim pesan pengingat ke Budi');
  assert.equal(singleAction, 'tool_action');
  assert.equal(router.select(singleAction, { needsTools: true }).model, 'claude-sonnet-5-5');

  const candidates = router.selectCandidates('tool_action', { needsTools: true });
  assert.deepEqual(
    candidates.map((c) => c.model),
    ['claude-sonnet-5-5', 'gemini/gemini-3.1-pro-preview', 'claude-haiku-5-5', 'claude-opus-5-5']
  );

  const visionCandidates = router.selectCandidates('reasoning', { needsTools: true, needsVision: true });
  assert.deepEqual(visionCandidates.map((c) => c.model), ['claude-sonnet-5-5']);
});

test('short thank-you and acknowledgement messages route to fast greeting tier while action commands do not', () => {
  assert.equal(classifyTask('Terimakasih'), 'greeting');
  assert.equal(classifyTask('Terima kasih banyak!'), 'greeting');
  assert.equal(classifyTask('Makasih ya'), 'greeting');
  assert.equal(classifyTask('Wow keren'), 'greeting');
  assert.equal(classifyTask('Oke siap'), 'greeting');
  assert.notEqual(classifyTask('Oke, tolong buatkan laporan PDF sekarang'), 'greeting');
  assert.notEqual(classifyTask('Makasih, sekarang carikan harga server terbaru'), 'greeting');
});
