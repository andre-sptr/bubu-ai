const DEFAULT_USD_TO_IDR = 16500;

const MODEL_RATES_PER_1M = Object.freeze({
  haiku: Object.freeze({ in: 0.80, out: 4.00 }),
  sonnet: Object.freeze({ in: 3.00, out: 15.00 }),
  opus: Object.freeze({ in: 15.00, out: 75.00 }),
  gemini: Object.freeze({ in: 1.25, out: 10.00 }),
  deepseekPro: Object.freeze({ in: 1.32, out: 3.96 }),
  deepseekFlash: Object.freeze({ in: 0.30, out: 1.20 }),
  gpt54Nano: Object.freeze({ in: 0.15, out: 0.60 }),
  gpt54Mini: Object.freeze({ in: 0.40, out: 1.60 }),
  gpt54: Object.freeze({ in: 2.50, out: 15.00 }),
  fast: Object.freeze({ in: 1.32, out: 3.96 }),
  balanced: Object.freeze({ in: 1.32, out: 3.96 }),
  coding: Object.freeze({ in: 1.32, out: 3.96 }),
  vision: Object.freeze({ in: 0.30, out: 1.20 }),
  reasoning: Object.freeze({ in: 1.32, out: 3.96 }),
  summary: Object.freeze({ in: 1.32, out: 3.96 })
});

function getModelRates(modelId = '', tier = '') {
  const id = String(modelId || '').toLowerCase();
  if (id.includes('deepseek') && id.includes('flash')) return MODEL_RATES_PER_1M.deepseekFlash;
  if (id.includes('deepseek')) return MODEL_RATES_PER_1M.deepseekPro;
  if (id.includes('gpt-5.4-nano')) return MODEL_RATES_PER_1M.gpt54Nano;
  if (id.includes('gpt-5.4-mini')) return MODEL_RATES_PER_1M.gpt54Mini;
  if (id.includes('gpt-5.4')) return MODEL_RATES_PER_1M.gpt54;
  if (id.includes('haiku')) return MODEL_RATES_PER_1M.haiku;
  if (id.includes('opus')) return MODEL_RATES_PER_1M.opus;
  if (id.includes('sonnet')) return MODEL_RATES_PER_1M.sonnet;
  if (id.includes('gemini')) return MODEL_RATES_PER_1M.gemini;
  const tierKey = String(tier || '').toLowerCase();
  return MODEL_RATES_PER_1M[tierKey] || MODEL_RATES_PER_1M.balanced;
}

function estimateModelCostUsd({ modelId = '', tier = '', inputTokens = 0, outputTokens = 0 } = {}) {
  const rates = getModelRates(modelId, tier);
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  return ((input * rates.in) + (output * rates.out)) / 1000000;
}

function estimateCostIdr(usd, usdToIdr = DEFAULT_USD_TO_IDR) {
  const amount = Number(usd) || 0;
  const rate = Number(usdToIdr) > 0 ? Number(usdToIdr) : DEFAULT_USD_TO_IDR;
  return Math.round(amount * rate);
}

module.exports = {
  DEFAULT_USD_TO_IDR,
  MODEL_RATES_PER_1M,
  getModelRates,
  estimateModelCostUsd,
  estimateCostIdr
};
