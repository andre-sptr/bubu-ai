const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MODEL_RATES_PER_1M,
  getModelRates,
  estimateModelCostUsd
} = require('../../../src/utils/model-pricing');

test('getModelRates maps DeepSeek V4 Pro, DeepSeek Flash, and legacy models accurately', () => {
  assert.deepEqual(getModelRates('deepseek-v4-pro', 'balanced'), MODEL_RATES_PER_1M.deepseekPro);
  assert.deepEqual(getModelRates('deepseek-flash', 'vision'), MODEL_RATES_PER_1M.deepseekFlash);
  assert.deepEqual(getModelRates('deepseek-v4.1-flash-1017', 'vision'), MODEL_RATES_PER_1M.deepseekFlash);
  assert.deepEqual(getModelRates('claude-sonnet-5-5', 'balanced'), MODEL_RATES_PER_1M.sonnet);
  assert.deepEqual(getModelRates('gemini/gemini-3.1-pro-preview', 'summary'), MODEL_RATES_PER_1M.gemini);
  assert.deepEqual(getModelRates('', 'fast'), MODEL_RATES_PER_1M.fast);
  assert.deepEqual(getModelRates('', 'vision'), MODEL_RATES_PER_1M.vision);
});

test('estimateModelCostUsd computes expected USD cost for DeepSeek and legacy models', () => {
  const proCost = estimateModelCostUsd({
    modelId: 'deepseek-v4-pro',
    tier: 'reasoning',
    inputTokens: 1_000_000,
    outputTokens: 500_000
  });
  assert.equal(Number(proCost.toFixed(4)), 3.3);

  const flashCost = estimateModelCostUsd({
    modelId: 'deepseek-flash',
    tier: 'vision',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000
  });
  assert.equal(Number(flashCost.toFixed(4)), 1.5);

  const legacyCost = estimateModelCostUsd({
    modelId: 'claude-sonnet-5-5',
    tier: 'balanced',
    inputTokens: 500_000,
    outputTokens: 100_000
  });
  assert.equal(Number(legacyCost.toFixed(4)), 3.0);
});
