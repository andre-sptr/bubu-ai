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
