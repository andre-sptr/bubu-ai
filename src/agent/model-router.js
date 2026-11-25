const TASK_TO_TIER = Object.freeze({
  greeting: 'fast',
  simple_question: 'fast',
  general_chat: 'balanced',
  tool_action: 'balanced',
  summarize: 'summary',
  reasoning: 'reasoning',
  coding: 'coding',
  agent: 'reasoning',
  vision: 'vision'
});

const DEFAULT_ATTACHMENT_PROMPTS = [
  /^tolong baca dan jelaskan dokumen yang saya kirim\.?(?:\s+|$)/i,
  /^tolong jalankan instruksi yang saya sampaikan melalui voice note ini\.?(?:\s+|$)/i
];

function classifyTask(text = '') {
  let s = String(text).toLowerCase().trim();
  for (const pattern of DEFAULT_ATTACHMENT_PROMPTS) {
    if (pattern.test(s)) {
      s = s.replace(pattern, '').trim();
    }
  }
  const isShortGreeting = s.length <= 40 &&
    !/[.?!].*\S/.test(s) &&
    !s.endsWith('?') &&
    !/\b(rangkum|ringkas|summari[sz]e|resume|debug|bug|kode|coding|analisis|evaluasi|bandingkan|buatkan|carikan|tolong)\b/.test(s) &&
    (
      /^(hai|halo|hello|hi|pagi|siang|sore|malam|selamat\s+(?:pagi|siang|sore|malam))(?:\b|[!,.\s]*$)/.test(s) ||
      /^(?:(?:terima\s*kasih|terimakasih|makasih)(?:\s+banyak)?|thanks|thank\s+you|thx|ok|oke|okay|siap|mantap|sip|noted|(?:wow\s+)?keren)(?:\s+(?:bubu|ya|kak|bro|makasih|siap|oke))?[!,.\s]*$/i.test(s)
    );
  if (isShortGreeting) return 'greeting';
  if (/\b(rangkum|ringkas|summari[sz]e|resume)\b/.test(s)) return 'summarize';
  if (/\b(debug|bug|kode|coding|program|javascript|python|error log)\b/.test(s)) return 'coding';
  if (
    /\b(carikan|cari|riset|analisis|baca|periksa|cek|bandingkan|buatkan|buat|susun|rekap)\b.+\b(lalu|kemudian|setelah itu|dan kirim|dan buat|dan simpan|dan rangkum)\b/.test(s) ||
    /\b(multi[- ]?step|beberapa langkah|rencana lengkap|riset mendalam)\b/.test(s)
  ) {
    return 'agent';
  }
  if (/\b(lalu|kemudian|setelah itu|kerjakan|jalankan|tolong.*kirim|kirimkan|ingatkan|jadwalkan)\b/.test(s)) {
    return 'tool_action';
  }
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

  selectCandidates(task, { needsTools = false, needsVision = false } = {}) {
    const requestedTier = TASK_TO_TIER[task] || 'balanced';
    const preference = needsVision
      ? ['vision', 'balanced', requestedTier, 'summary', 'reasoning', 'coding', 'fast']
      : [requestedTier, 'balanced', 'summary', 'fast', 'reasoning', 'coding'];
    const candidates = [];
    const seenModelIds = new Set();
    for (const tier of [...new Set(preference)]) {
      const candidate = this.modelConfig[tier];
      if (!candidate?.id) continue;
      if (needsTools && candidate.supportsTools === false) continue;
      if (needsVision && candidate.supportsVision === false) continue;
      if (seenModelIds.has(candidate.id)) continue;
      seenModelIds.add(candidate.id);
      candidates.push({ tier, model: candidate.id, supportsTools: candidate.supportsTools !== false });
    }
    if (!candidates.length) {
      throw new Error(needsTools
        ? `No configured Sumopod model has tool calling enabled for task ${task}`
        : `No configured Sumopod model available for task ${task}`);
    }
    return candidates;
  }

  select(task, { needsTools = false, needsVision = false } = {}) {
    return this.selectCandidates(task, { needsTools, needsVision })[0];
  }
}

module.exports = { ModelRouter, classifyTask, TASK_TO_TIER };
