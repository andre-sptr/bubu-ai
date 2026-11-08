const TASK_TO_TIER = Object.freeze({
  greeting: 'fast',
  simple_question: 'fast',
  general_chat: 'balanced',
  summarize: 'summary',
  reasoning: 'reasoning',
  coding: 'coding',
  agent: 'reasoning',
  vision: 'vision'
});

function classifyTask(text = '') {
  const s = String(text).toLowerCase().trim();
  if (/^(hai|halo|hello|hi|pagi|siang|sore|malam)\b/.test(s)) return 'greeting';
  if (/\b(rangkum|ringkas|summari[sz]e|resume)\b/.test(s)) return 'summarize';
  if (/\b(debug|bug|kode|coding|program|javascript|python|error log)\b/.test(s)) return 'coding';
  if (/\b(lalu|kemudian|setelah itu|carikan.*dan|buatkan.*kemudian|kerjakan|jalankan|tolong.*kirim)\b/.test(s)) return 'agent';
  if (s.length > 700 || /\b(analisis mendalam|evaluasi|bandingkan|susun strategi|rancangan|arsitektur)\b/.test(s)) return 'reasoning';
  if (s.length < 100 && s.endsWith('?')) return 'simple_question';
  return 'general_chat';
}

class ModelRouter {
  constructor(modelConfig) { this.modelConfig = modelConfig; }

  assertReady() {
    const ready = Object.values(this.modelConfig).some((model) => model?.id);
    if (!ready) throw new Error('No Sumopod model is configured');
  }

  select(task, { needsTools = false, needsVision = false } = {}) {
    const requestedTier = TASK_TO_TIER[task] || 'balanced';
    const preference = needsVision
      ? ['vision', 'balanced', requestedTier, 'reasoning', 'coding', 'fast', 'summary']
      : [requestedTier, 'balanced', 'fast', 'reasoning', 'coding', 'summary'];
    for (const tier of [...new Set(preference)]) {
      const candidate = this.modelConfig[tier];
      if (!candidate?.id) continue;
      if (needsVision && candidate.supportsVision === false) continue;
      return { tier, model: candidate.id, supportsTools: true };
    }
    throw new Error(needsTools
      ? `No configured Sumopod model has tool calling enabled for task ${task}`
      : `No configured Sumopod model available for task ${task}`);
  }
}

module.exports = { ModelRouter, classifyTask, TASK_TO_TIER };
