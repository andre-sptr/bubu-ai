const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyTask, ModelRouter } = require('../../src/agent/model-router');

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
