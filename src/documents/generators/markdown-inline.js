const DOC_TYPE_LABELS = {
  business_proposal: 'PROPOSAL BISNIS',
  business_plan: 'BUSINESS PLAN',
  project_proposal: 'PROPOSAL PROYEK',
  report: 'LAPORAN',
  financial_report: 'LAPORAN KEUANGAN',
  market_research: 'RISET PASAR',
  sop: 'STANDARD OPERATING PROCEDURE',
  work_instruction: 'INSTRUKSI KERJA',
  meeting_minutes: 'NOTULEN RAPAT',
  memo: 'MEMO',
  formal_letter: 'SURAT RESMI',
  invoice: 'INVOICE',
  quotation: 'QUOTATION',
  project_plan: 'PROJECT PLAN',
  executive_summary: 'EXECUTIVE SUMMARY',
  general: 'DOKUMEN'
};

function parseInlineMarkdownTokens(text) {
  const input = String(text ?? '');
  if (!input) return [{ text: '', bold: false, italics: false, code: false }];

  const tokens = [];
  const pattern = /(\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`)/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(input)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({
        text: input.slice(lastIndex, match.index),
        bold: false,
        italics: false,
        code: false
      });
    }
    if (match[2] !== undefined) {
      tokens.push({ text: match[2], bold: true, italics: true, code: false });
    } else if (match[3] !== undefined) {
      tokens.push({ text: match[3], bold: true, italics: false, code: false });
    } else if (match[4] !== undefined) {
      tokens.push({ text: match[4], bold: false, italics: true, code: false });
    } else if (match[5] !== undefined) {
      tokens.push({ text: match[5], bold: false, italics: false, code: true });
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < input.length) {
    tokens.push({
      text: input.slice(lastIndex),
      bold: false,
      italics: false,
      code: false
    });
  }
  return tokens.length ? tokens : [{ text: input, bold: false, italics: false, code: false }];
}

function stripInlineMarkdown(text) {
  return parseInlineMarkdownTokens(text).map((t) => t.text).join('');
}

module.exports = {
  DOC_TYPE_LABELS,
  parseInlineMarkdownTokens,
  stripInlineMarkdown
};
