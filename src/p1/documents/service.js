const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const ALLOWED = new Map([
  ['.pdf', ['application/pdf']],
  ['.docx', ['application/vnd.openxmlformats-officedocument.wordprocessingml.document']],
  ['.xlsx', ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']],
  ['.xlsm', ['application/vnd.ms-excel.sheet.macroEnabled.12', 'application/vnd.ms-excel.sheet.macroenabled.12']],
  ['.csv', ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel']],
  ['.txt', ['text/plain']]
]);

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

function runDocCommand(command, args, { input = null, timeoutMs = 90000, maxOutput = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`${command} timed out`));
    }, timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    child.stdout.on('data', (chunk) => {
      if (stdout.length + chunk.length > maxOutput) {
        child.kill('SIGKILL');
        finish(new Error(`${command} output exceeded limit`));
      } else {
        stdout = Buffer.concat([stdout, chunk]);
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 128 * 1024) {
        stderr = Buffer.concat([stderr, chunk]).subarray(0, 128 * 1024);
      }
    });
    child.on('error', (error) => finish(new Error(`${command} unavailable: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) finish(null, { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
      else finish(new Error(`${command} exited ${code}: ${stderr.toString('utf8').slice(-1200)}`));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function safeFilename(name) {
  const portable = String(name || 'document').replace(/\\/g, '/');
  const base = path.basename(portable).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 100);
  return base || 'document';
}

function documentExtensionFromMime(mimetype) {
  const mime = normalizeMimeType(mimetype);
  const map = {
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.ms-excel.sheet.macroenabled.12': '.xlsm',
    'text/csv': '.csv',
    'application/csv': '.csv',
    'application/vnd.ms-excel': '.csv',
    'text/plain': '.txt'
  };
  return map[mime] || '';
}

function validateExtension(filename, mimetype) {
  const ext = path.extname(filename).toLowerCase();
  const accepted = ALLOWED.get(ext);
  const mime = normalizeMimeType(mimetype);
  if (!accepted) throw new Error('Format dokumen belum didukung. Gunakan PDF, DOCX, XLSX, XLSM, CSV, atau TXT.');
  if (mime && !isGenericMime(mime) && !accepted.map((m) => m.toLowerCase()).includes(mime) &&
      !(ext === '.txt' && mime.startsWith('text/')) &&
      !(['.docx', '.xlsx', '.xlsm'].includes(ext) && mime === 'application/zip')) {
    throw new Error(`MIME type tidak sesuai dengan ekstensi ${ext}.`);
  }
  return ext;
}

function normalizeMediaUrl(mediaUrl, wahaBaseUrl) {
  if (typeof mediaUrl !== 'string' || !mediaUrl.trim()) {
    throw new Error('WAHA tidak menyediakan URL media yang valid.');
  }

  let base;
  let media;
  try {
    base = new URL(wahaBaseUrl);
    media = new URL(mediaUrl.trim(), base);
  } catch {
    throw new Error('Media URL atau WAHA base URL tidak valid.');
  }

  if (!['http:', 'https:'].includes(base.protocol) ||
      !['http:', 'https:'].includes(media.protocol)) {
    throw new Error('Media URL hanya boleh menggunakan HTTP atau HTTPS.');
  }
  if (media.username || media.password) {
    throw new Error('Media URL dengan kredensial tertanam ditolak.');
  }

  const localAliases = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);
  if (localAliases.has(media.hostname.toLowerCase())) {
    media = new URL(`${media.pathname}${media.search}`, base);
  }

  if (media.origin !== base.origin) {
    throw new Error('Media URL tidak berasal dari host WAHA yang dikonfigurasi.');
  }

  // Fragments are client-side only and must never be sent to WAHA.
  media.hash = '';
  return media;
}

function normalizeMimeType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function isGenericMime(value) {
  return ['', 'application/octet-stream', 'binary/octet-stream'].includes(
    normalizeMimeType(value)
  );
}

function validateResponseMime(declaredMime, responseMime, acceptedMimes, label) {
  const declared = normalizeMimeType(declaredMime);
  const received = normalizeMimeType(responseMime);
  const accepted = new Set((acceptedMimes || []).map((m) => m.toLowerCase()));

  if (declared && !isGenericMime(declared) && accepted.size && !accepted.has(declared) &&
      !(declared === 'application/zip' && ['.docx', '.xlsx', '.xlsm'].includes(label))) {
    throw new Error(`MIME type media tidak didukung untuk ${label}.`);
  }
  if (received && !isGenericMime(received) && accepted.size && !accepted.has(received)) {
    // application/zip is a common generic container MIME for OOXML files.
    if (!(received === 'application/zip' && ['.docx', '.xlsx', '.xlsm'].includes(label))) {
      throw new Error(`Content-Type unduhan tidak sesuai dengan ${label}.`);
    }
  }
  if (declared && received && !isGenericMime(declared) && !isGenericMime(received) &&
      declared !== received && !(received === 'application/zip' &&
        ['.docx', '.xlsx', '.xlsm'].includes(label))) {
    throw new Error('MIME type webhook berbeda dengan Content-Type hasil unduhan.');
  }
}

// ============================================================================
// Phase 3 Helpers: Structured DOCX XML, Page Chunking, Search, & Spreadsheets
// ============================================================================

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function readZipEntryFromBuffer(zipBuffer, targetEntryName) {
  const buf = Buffer.from(zipBuffer || []);
  let offset = 0;
  while (offset + 30 <= buf.length) {
    const signature = buf.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const flags = buf.readUInt16LE(offset + 6);
    const compression = buf.readUInt16LE(offset + 8);
    let compressedSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart > buf.length) break;
    const entryName = buf.subarray(nameStart, nameStart + nameLen).toString('utf8');

    // If bit 3 (data descriptor) is set and compressedSize is 0, locate next PK header
    if ((flags & 0x08) && compressedSize === 0) {
      let nextHeader = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), dataStart);
      if (nextHeader === -1) nextHeader = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), dataStart);
      if (nextHeader !== -1 && nextHeader >= dataStart + 12) {
        compressedSize = nextHeader - dataStart;
      }
    }

    const dataEnd = dataStart + compressedSize;
    if (entryName === targetEntryName && dataEnd <= buf.length) {
      const rawData = buf.subarray(dataStart, dataEnd);
      if (compression === 0) return rawData.toString('utf8');
      if (compression === 8) return zlib.inflateRawSync(rawData).toString('utf8');
      return null;
    }
    if (compressedSize === 0 && (flags & 0x08)) break;
    offset = dataEnd;
  }
  return null;
}

function extractParagraphTextFromXml(pXml) {
  const runs = [];
  const tokenRegex = /<w:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br(?:\s+[^>]*)?\/>/g;
  let match;
  while ((match = tokenRegex.exec(pXml)) !== null) {
    if (match[1] !== undefined) runs.push(decodeXmlEntities(match[1]));
    else if (match[0].startsWith('<w:tab')) runs.push('\t');
    else runs.push('\n');
  }
  return runs.join('').trim();
}

function extractStructuredDocxFromXml(xml) {
  if (!xml || typeof xml !== 'string') return '';
  const bodyMatch = xml.match(/<w:body[^>]*>([\s\S]*?)<\/w:body>/);
  const bodyXml = bodyMatch ? bodyMatch[1] : xml;

  const blocks = [];
  const blockRegex = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g;
  let match;
  while ((match = blockRegex.exec(bodyXml)) !== null) {
    const block = match[0];
    if (block.startsWith('<w:tbl')) {
      const rows = [];
      const rowRegex = /<w:tr\b[\s\S]*?<\/w:tr>/g;
      let rowMatch;
      while ((rowMatch = rowRegex.exec(block)) !== null) {
        const cells = [];
        const cellRegex = /<w:tc\b[\s\S]*?<\/w:tc>/g;
        let cellMatch;
        while ((cellMatch = cellRegex.exec(rowMatch[0])) !== null) {
          const cellParagraphs = [];
          const pRegex = /<w:p\b[\s\S]*?<\/w:p>/g;
          let pMatch;
          while ((pMatch = pRegex.exec(cellMatch[0])) !== null) {
            const pText = extractParagraphTextFromXml(pMatch[0]).replace(/\s+/g, ' ');
            if (pText) cellParagraphs.push(pText);
          }
          cells.push(cellParagraphs.join(' / ').replace(/\|/g, '\\|'));
        }
        if (cells.some(Boolean)) rows.push(cells);
      }
      if (rows.length > 0) {
        const colCount = Math.max(...rows.map((r) => r.length));
        const padRow = (r) => Array.from({ length: colCount }, (_, i) => r[i] ?? '');
        const header = padRow(rows[0]);
        const sep = header.map(() => '---');
        const tableLines = [
          `| ${header.join(' | ')} |`,
          `| ${sep.join(' | ')} |`,
          ...rows.slice(1).map((r) => `| ${padRow(r).join(' | ')} |`)
        ];
        blocks.push(tableLines.join('\n'));
      }
    } else {
      const text = extractParagraphTextFromXml(block);
      if (!text) continue;
      const styleMatch = block.match(/<w:pStyle\s+w:val="([^"]+)"/i);
      const style = styleMatch ? styleMatch[1].toLowerCase() : '';
      const isList = /<w:numPr\b/.test(block);
      if (style === 'title' || style === 'heading1' || style === 'heading 1') {
        blocks.push(`# ${text}`);
      } else if (style === 'heading2' || style === 'heading 2' || style === 'subtitle') {
        blocks.push(`## ${text}`);
      } else if (style.startsWith('heading')) {
        blocks.push(`### ${text}`);
      } else if (isList) {
        blocks.push(`- ${text}`);
      } else {
        blocks.push(text);
      }
    }
  }
  return blocks.join('\n\n').trim();
}

async function extractStructuredDocxText(buffer, mammothLib = null) {
  try {
    const xml = readZipEntryFromBuffer(buffer, 'word/document.xml');
    if (xml) {
      const structured = extractStructuredDocxFromXml(xml);
      if (structured) return structured;
    }
  } catch {
    // Fall back to mammoth if custom XML zip reader fails
  }
  const mammoth = mammothLib || require('mammoth');
  const parsed = await mammoth.extractRawText({ buffer });
  return String(parsed.value || '').trim();
}

function splitDocumentIntoPages(extractedText, { defaultPageChars = 3000 } = {}) {
  const raw = String(extractedText || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];

  const pageMarkerRegex = /^---\s*\[((?:HALAMAN|BAGIAN)\s+(\d+)[^\]]*)\]\s*---\s*$/gim;
  const matches = [...raw.matchAll(pageMarkerRegex)];
  if (matches.length > 0) {
    const pages = [];
    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      const next = matches[i + 1];
      const contentStart = current.index + current[0].length;
      const contentEnd = next ? next.index : raw.length;
      const content = raw.slice(contentStart, contentEnd).trim();
      pages.push({
        pageNumber: Number(current[2]) || (i + 1),
        label: current[1].trim(),
        isOcr: /OCR/i.test(current[1]),
        content
      });
    }
    return pages;
  }

  const sheetMarkerRegex = /^SHEET:\s*(.+)$/gim;
  const sheetMatches = [...raw.matchAll(sheetMarkerRegex)];
  if (sheetMatches.length > 0) {
    const pages = [];
    for (let i = 0; i < sheetMatches.length; i++) {
      const current = sheetMatches[i];
      const next = sheetMatches[i + 1];
      const contentStart = current.index;
      const contentEnd = next ? next.index : raw.length;
      pages.push({
        pageNumber: i + 1,
        label: `SHEET: ${current[1].trim()}`,
        isOcr: false,
        content: raw.slice(contentStart, contentEnd).trim()
      });
    }
    return pages;
  }

  if (raw.length <= defaultPageChars) {
    return [{ pageNumber: 1, label: 'Halaman 1', isOcr: false, content: raw }];
  }

  const pages = [];
  const paragraphs = raw.split(/\n{2,}/);
  let currentChunk = '';
  let pageNo = 1;
  for (const para of paragraphs) {
    if (currentChunk && (currentChunk.length + para.length + 2) > defaultPageChars) {
      pages.push({
        pageNumber: pageNo,
        label: `Bagian ${pageNo}`,
        isOcr: false,
        content: currentChunk.trim()
      });
      pageNo++;
      currentChunk = para;
    } else {
      currentChunk = currentChunk ? `${currentChunk}\n\n${para}` : para;
    }
  }
  if (currentChunk.trim()) {
    pages.push({
      pageNumber: pageNo,
      label: `Bagian ${pageNo}`,
      isOcr: false,
      content: currentChunk.trim()
    });
  }
  return pages;
}

function readDocumentPages(extractedText, { page = null, startPage = null, endPage = null, maxChars = 15000 } = {}) {
  const pages = splitDocumentIntoPages(extractedText);
  if (!pages.length) {
    return {
      totalPages: 0,
      returnedPages: [],
      pageLabels: [],
      hasMorePages: false,
      text: ''
    };
  }

  let start = 1;
  let end = pages.length;
  if (Number.isInteger(page) && page >= 1) {
    start = page;
    end = page;
  } else if (Number.isInteger(startPage) || Number.isInteger(endPage)) {
    start = Math.max(1, Number(startPage || 1));
    end = Math.min(pages.length, Math.max(start, Number(endPage || pages.length)));
  }

  const candidates = pages.filter((p) => p.pageNumber >= start && p.pageNumber <= end);
  const selected = [];
  let charTotal = 0;
  const boundedMaxChars = Math.min(50000, Math.max(1000, Number(maxChars) || 15000));
  for (const item of candidates) {
    const formatted = pages.length > 1
      ? `--- [${item.label}] ---\n${item.content}`
      : item.content;
    if (selected.length > 0 && charTotal + formatted.length > boundedMaxChars) {
      break;
    }
    selected.push({ ...item, formatted });
    charTotal += formatted.length;
  }

  const lastReturnedPage = selected.length ? selected[selected.length - 1].pageNumber : 0;
  const hasMorePages = lastReturnedPage < pages.length;
  const text = selected.map((s) => s.formatted).join('\n\n').slice(0, boundedMaxChars);

  return {
    totalPages: pages.length,
    returnedPages: selected.map((s) => s.pageNumber),
    pageLabels: selected.map((s) => s.label),
    hasMorePages,
    text
  };
}

function tokenizeSearchQuery(query) {
  const normalized = String(query || '').toLowerCase().trim();
  if (!normalized) return [];
  const rawTokens = normalized.split(/[^\p{L}\p{N}_.-]+/u).filter(Boolean);
  const filtered = rawTokens.filter((token) => token.length >= 2 || /\d/.test(token));
  return [...new Set(filtered.length ? filtered : rawTokens)];
}

function buildSnippetAroundMatch(text, terms, fullPhrase, snippetChars = 600) {
  const content = String(text || '');
  if (!content) return '';
  const lower = content.toLowerCase();

  let bestIndex = -1;
  if (fullPhrase && fullPhrase.length >= 3) {
    bestIndex = lower.indexOf(fullPhrase);
  }
  if (bestIndex === -1) {
    // Find window with highest density of distinct matched terms
    const positions = [];
    for (const term of terms) {
      let idx = lower.indexOf(term);
      while (idx !== -1) {
        positions.push({ idx, term });
        idx = lower.indexOf(term, idx + term.length);
      }
    }
    if (positions.length > 0) {
      positions.sort((a, b) => a.idx - b.idx);
      let maxDistinct = 0;
      bestIndex = positions[0].idx;
      for (let i = 0; i < positions.length; i++) {
        const windowEnd = positions[i].idx + Math.floor(snippetChars * 0.7);
        const distinct = new Set();
        for (let j = i; j < positions.length && positions[j].idx <= windowEnd; j++) {
          distinct.add(positions[j].term);
        }
        if (distinct.size > maxDistinct) {
          maxDistinct = distinct.size;
          bestIndex = positions[i].idx;
        }
      }
    }
  }

  if (bestIndex === -1) {
    return content.slice(0, snippetChars);
  }

  const lead = Math.floor(snippetChars * 0.35);
  const start = Math.max(0, bestIndex - lead);
  const end = Math.min(content.length, start + snippetChars);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < content.length ? '...' : '';
  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

function searchDocumentSnippets(input, query, { limit = 5, maxSnippets = 3, snippetChars = 600 } = {}) {
  const terms = tokenizeSearchQuery(query);
  const fullPhrase = String(query || '').toLowerCase().trim();

  // Mode 1: Single document text string -> returns { totalPages, snippets, excerpt }
  if (typeof input === 'string') {
    const pages = splitDocumentIntoPages(input);
    if (!terms.length || !pages.length) {
      return { totalPages: pages.length, snippets: [], excerpt: '' };
    }
    const scoredPages = [];
    for (const page of pages) {
      const pageLower = page.content.toLowerCase();
      const matchedInPage = terms.filter((t) => pageLower.includes(t));
      if (!matchedInPage.length) continue;
      let pageScore = matchedInPage.length * 3;
      if (fullPhrase.length >= 3 && pageLower.includes(fullPhrase)) {
        pageScore += 5;
      }
      const snippet = buildSnippetAroundMatch(page.content, matchedInPage, fullPhrase, snippetChars);
      scoredPages.push({
        pageNumber: page.pageNumber,
        pageLabel: page.label,
        score: pageScore,
        matchedTerms: matchedInPage,
        snippet,
      });
    }
    scoredPages.sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber);
    const snippets = scoredPages.slice(0, Math.max(1, Number(maxSnippets) || 3));
    const excerpt = snippets
      .map((s) => (pages.length > 1 ? `[${s.pageLabel}] ${s.snippet}` : s.snippet))
      .join('\n\n');
    return {
      totalPages: pages.length,
      snippets,
      excerpt,
    };
  }

  // Mode 2: Array of document rows -> returns ranked document matches
  if (!terms.length) return [];
  const rows = Array.isArray(input) ? input : [];
  const scoredDocs = [];
  for (const row of rows) {
    const filenameLower = String(row.filename || '').toLowerCase();
    const pages = splitDocumentIntoPages(row.extracted_text || '');
    const filenameMatches = terms.filter((t) => filenameLower.includes(t));

    let bestPage = null;
    let bestPageScore = 0;
    let bestPageMatchedTerms = [];
    let totalDocScore = filenameMatches.length * 2;
    const allMatchedTerms = new Set(filenameMatches);
    const pageSnippets = [];

    for (const page of pages) {
      const pageLower = page.content.toLowerCase();
      const matchedInPage = terms.filter((t) => pageLower.includes(t));
      if (!matchedInPage.length) continue;
      for (const t of matchedInPage) allMatchedTerms.add(t);

      let pageScore = matchedInPage.length * 3;
      if (fullPhrase.length >= 3 && pageLower.includes(fullPhrase)) {
        pageScore += 5;
      }
      totalDocScore += matchedInPage.length;
      const pageSnippetText = buildSnippetAroundMatch(page.content, matchedInPage, fullPhrase, snippetChars);
      pageSnippets.push({
        pageNumber: page.pageNumber,
        pageLabel: page.label,
        score: pageScore,
        matchedTerms: matchedInPage,
        snippet: pageSnippetText,
      });
      if (pageScore > bestPageScore) {
        bestPageScore = pageScore;
        bestPage = page;
        bestPageMatchedTerms = matchedInPage;
      }
    }

    if (totalDocScore <= 0) continue;
    pageSnippets.sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber);
    const topSnippets = pageSnippets.slice(0, Math.max(1, Number(maxSnippets) || 3));
    const targetPage = bestPage || pages[0] || { pageNumber: 1, label: 'Halaman 1', content: String(row.extracted_text || '') };
    const snippet = buildSnippetAroundMatch(
      targetPage.content,
      bestPageMatchedTerms.length ? bestPageMatchedTerms : terms,
      fullPhrase,
      snippetChars
    );
    const { extracted_text, ...rest } = row;
    scoredDocs.push({
      ...rest,
      score: bestPageScore + filenameMatches.length * 2,
      pageNumber: targetPage.pageNumber,
      pageLabel: targetPage.label,
      matchedPages: topSnippets.map((s) => s.pageNumber),
      totalPages: pages.length,
      snippets: topSnippets,
      matchedTerms: [...allMatchedTerms],
      excerpt: pages.length > 1 ? `[${targetPage.label}] ${snippet}` : snippet
    });
  }

  return scoredDocs
    .sort((a, b) => b.score - a.score || String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, Math.max(1, Math.min(Number(limit) || 5, 20)));
}

function detectCsvDelimiter(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (!lines.length) return ',';
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestScore = -1;
  for (const delim of candidates) {
    const counts = lines.map((line) => {
      let inQuotes = false;
      let count = 0;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') inQuotes = !inQuotes;
        else if (!inQuotes && ch === delim) count++;
      }
      return count;
    });
    const minCount = Math.min(...counts);
    const total = counts.reduce((a, b) => a + b, 0);
    const score = minCount > 0 ? total * 2 : total;
    if (score > bestScore && total > 0) {
      bestScore = score;
      best = delim;
    }
  }
  return best;
}

function parseCsvText(rawText, { delimiter = 'auto' } = {}) {
  const clean = String(rawText || '').replace(/^\uFEFF/, '').replace(/\u0000/g, '').replace(/\r\n/g, '\n');
  const delim = delimiter === 'auto' ? detectCsvDelimiter(clean) : delimiter;
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const next = clean[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\r' && next === '\n') {
      row.push(field.trim());
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      field = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field.trim());
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    if (row.some((c) => c !== '')) rows.push(row);
  }
  return { delimiter: delim, rows };
}

function parseSpreadsheetNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  let str = String(value).trim();
  if (!str) return null;

  // Check accounting negative format "(1.250)"
  let negative = false;
  if (/^\(.*\)$/.test(str)) {
    negative = true;
    str = str.slice(1, -1).trim();
  }
  // Strip common currency prefixes/suffixes and percent symbol
  str = str.replace(/^(?:rp\.?|idr|usd|\$|€|£)\s*/i, '').replace(/\s*(?:%|idr|rp)$/i, '').trim();
  if (!str || !/^[-+]?\d[\d.,]*$/.test(str)) return null;

  if (str.startsWith('-')) {
    negative = !negative;
    str = str.slice(1);
  } else if (str.startsWith('+')) {
    str = str.slice(1);
  }

  const dotCount = (str.match(/\./g) || []).length;
  const commaCount = (str.match(/,/g) || []).length;

  let normalized = str;
  if (dotCount > 0 && commaCount > 0) {
    const lastDot = str.lastIndexOf('.');
    const lastComma = str.lastIndexOf(',');
    if (lastComma > lastDot) {
      // Indonesian/European: 1.250.000,50
      normalized = str.replace(/\./g, '').replace(',', '.');
    } else {
      // International: 1,250,000.50
      normalized = str.replace(/,/g, '');
    }
  } else if (dotCount > 1) {
    // Multiple dots: 1.250.000
    normalized = str.replace(/\./g, '');
  } else if (commaCount > 1) {
    // Multiple commas: 1,250,000
    normalized = str.replace(/,/g, '');
  } else if (commaCount === 1 && dotCount === 0) {
    const parts = str.split(',');
    if (parts[1].length === 3 && parts[0].length >= 1 && parts[0] !== '0') {
      // Ambiguous 1,250 -> treat as 1250 if integer thousands, or decimal if 0,5
      normalized = str.replace(',', '');
    } else {
      normalized = str.replace(',', '.');
    }
  } else if (dotCount === 1 && commaCount === 0) {
    const parts = str.split('.');
    // In Indonesian finance tables, 150.000 or 25.000 with exactly 3 trailing zeros is thousands
    if (parts[1].length === 3 && parts[0].length >= 1 && parts[0] !== '0' && parts[1] === '000') {
      normalized = str.replace('.', '');
    }
  }

  const num = Number(normalized);
  if (!Number.isFinite(num)) return null;
  return negative ? -num : num;
}

function parseSheetsFromExtractedText(extractedText) {
  const raw = String(extractedText || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];

  const lines = raw.split('\n');
  const hasSheetHeader = lines.some((line) => /^SHEET:\s*.+/i.test(line.trim()));
  if (hasSheetHeader) {
    const sheets = [];
    let current = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const sheetMatch = trimmed.match(/^SHEET:\s*(.+)$/i);
      if (sheetMatch) {
        current = { name: sheetMatch[1].trim(), rows: [] };
        sheets.push(current);
        continue;
      }
      if (!current) {
        current = { name: 'Sheet1', rows: [] };
        sheets.push(current);
      }
      const rowMatch = trimmed.match(/^\d+:\s*(.*)$/);
      const content = rowMatch ? rowMatch[1] : trimmed;
      const cells = content.split(/\s*\|\s*/).map((c) => c.trim());
      current.rows.push(cells);
    }
    return sheets;
  }

  const parsedCsv = parseCsvText(raw);
  return [{ name: 'Data', rows: parsedCsv.rows, delimiter: parsedCsv.delimiter }];
}

function roundStat(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : null;
}

function computeNumericArrayStats(values) {
  if (!values.length) return null;
  const count = values.length;
  const sum = values.reduce((acc, v) => acc + v, 0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = sum / count;
  return {
    count,
    sum: roundStat(sum),
    avg: roundStat(avg),
    min: roundStat(min),
    max: roundStat(max)
  };
}

function resolveColumnIndex(headers, columnRef) {
  if (!columnRef) return -1;
  const ref = String(columnRef).trim();
  const exactIdx = headers.findIndex((h) => h.toLowerCase() === ref.toLowerCase());
  if (exactIdx !== -1) return exactIdx;
  const partialIdx = headers.findIndex((h) => h.toLowerCase().includes(ref.toLowerCase()));
  if (partialIdx !== -1) return partialIdx;
  if (/^\d+$/.test(ref)) {
    const oneBased = Number(ref) - 1;
    if (oneBased >= 0 && oneBased < headers.length) return oneBased;
  }
  return -1;
}

function analyzeSpreadsheetText(extractedText, {
  filename = '',
  question = null,
  sheetName = null,
  filterColumn = null,
  filterValue = null,
  groupByColumn = null,
  aggregateColumn = null,
  rowLimit = 50
} = {}) {
  const sheets = parseSheetsFromExtractedText(extractedText);
  if (!sheets.length) {
    return {
      filename,
      question,
      sheetNames: [],
      selectedSheet: null,
      totalRows: 0,
      filteredRows: 0,
      headers: [],
      columns: [],
      groupSummary: null,
      sampleRows: [],
      extractedRows: ''
    };
  }

  const sheetNames = sheets.map((s) => s.name);
  const targetSheet = (sheetName && sheets.find((s) => s.name.toLowerCase() === String(sheetName).trim().toLowerCase()))
    || (sheetName && sheets.find((s) => s.name.toLowerCase().includes(String(sheetName).trim().toLowerCase())))
    || sheets[0];

  const allRows = targetSheet.rows || [];
  const rawHeaders = allRows[0] || [];
  const maxCols = Math.max(rawHeaders.length, ...allRows.map((r) => r.length), 0);
  const headers = Array.from({ length: maxCols }, (_, idx) => String(rawHeaders[idx] || `Kolom_${idx + 1}`).trim() || `Kolom_${idx + 1}`);
  const dataRows = allRows.slice(1).map((r) => Array.from({ length: maxCols }, (_, idx) => String(r[idx] ?? '').trim()));

  let filteredDataRows = dataRows;
  if (filterColumn && filterValue !== null && filterValue !== undefined && String(filterValue).trim() !== '') {
    const colIdx = resolveColumnIndex(headers, filterColumn);
    if (colIdx !== -1) {
      const needle = String(filterValue).trim().toLowerCase();
      const needleNum = parseSpreadsheetNumber(filterValue);
      filteredDataRows = dataRows.filter((row) => {
        const cell = String(row[colIdx] ?? '').trim();
        if (cell.toLowerCase() === needle || cell.toLowerCase().includes(needle)) return true;
        if (needleNum !== null) {
          const cellNum = parseSpreadsheetNumber(cell);
          if (cellNum !== null && cellNum === needleNum) return true;
        }
        return false;
      });
    }
  }

  const columns = headers.map((headerName, colIdx) => {
    const nonEmpty = [];
    const numericValues = [];
    for (const row of filteredDataRows) {
      const val = String(row[colIdx] ?? '').trim();
      if (!val) continue;
      nonEmpty.push(val);
      const parsedNum = parseSpreadsheetNumber(val);
      if (parsedNum !== null) numericValues.push(parsedNum);
    }
    let inferredType = 'empty';
    if (nonEmpty.length > 0) {
      if (numericValues.length === nonEmpty.length) inferredType = 'numeric';
      else if (numericValues.length > 0) inferredType = 'mixed';
      else inferredType = 'text';
    }
    return {
      index: colIdx + 1,
      name: headerName,
      inferredType,
      nonEmptyCount: nonEmpty.length,
      numericStats: numericValues.length > 0 ? computeNumericArrayStats(numericValues) : null
    };
  });

  let groupSummary = null;
  if (groupByColumn) {
    const groupIdx = resolveColumnIndex(headers, groupByColumn);
    const aggIdx = aggregateColumn
      ? resolveColumnIndex(headers, aggregateColumn)
      : columns.findIndex((c) => c.inferredType === 'numeric');
    if (groupIdx !== -1) {
      const groups = new Map();
      for (const row of filteredDataRows) {
        const key = String(row[groupIdx] || '(Kosong)').trim() || '(Kosong)';
        if (!groups.has(key)) groups.set(key, { rowCount: 0, values: [] });
        const entry = groups.get(key);
        entry.rowCount++;
        if (aggIdx !== -1) {
          const num = parseSpreadsheetNumber(row[aggIdx]);
          if (num !== null) entry.values.push(num);
        }
      }
      groupSummary = [...groups.entries()].map(([key, entry]) => ({
        group: key,
        rowCount: entry.rowCount,
        aggregateColumn: aggIdx !== -1 ? headers[aggIdx] : null,
        stats: computeNumericArrayStats(entry.values)
      }));
    }
  }

  const boundedLimit = Math.min(200, Math.max(1, Number(rowLimit) || 50));
  const sampleRows = filteredDataRows.slice(0, boundedLimit).map((row, i) => ({
    rowNumber: i + 2,
    values: Object.fromEntries(headers.map((h, idx) => [h, row[idx] ?? '']))
  }));

  const summaryLines = [
    `SHEET AKTIF: ${targetSheet.name} (Total sheet: ${sheetNames.join(', ')})`,
    `BARIS DATA: ${filteredDataRows.length} dari ${dataRows.length} baris`,
    `KOLOM (${headers.length}): ${headers.join(' | ')}`,
    'STATISTIK NUMERIK DETERMINISTIK:',
    ...columns
      .filter((c) => c.numericStats)
      .map((c) => `- ${c.name}: count=${c.numericStats.count}, sum=${c.numericStats.sum}, avg=${c.numericStats.avg}, min=${c.numericStats.min}, max=${c.numericStats.max}`),
    ...(groupSummary ? [
      `RINGKASAN GROUP BY (${groupByColumn}):`,
      ...groupSummary.map((g) => `- ${g.group}: rows=${g.rowCount}${g.stats ? `, sum=${g.stats.sum}, avg=${g.stats.avg}, min=${g.stats.min}, max=${g.stats.max}` : ''}`)
    ] : []),
    'SAMPEL BARIS:',
    `1: ${headers.join(' | ')}`,
    ...filteredDataRows.slice(0, boundedLimit).map((r, i) => `${i + 2}: ${r.join(' | ')}`)
  ];

  return {
    filename,
    question: question || null,
    sheetNames,
    selectedSheet: targetSheet.name,
    totalRows: dataRows.length,
    filteredRows: filteredDataRows.length,
    headers,
    columns,
    groupSummary,
    sampleRows,
    extractedRows: summaryLines.join('\n')
  };
}

function compareDocumentTexts(docA, docB, { focus = '' } = {}) {
  const pagesA = splitDocumentIntoPages(docA.extracted_text || '');
  const pagesB = splitDocumentIntoPages(docB.extracted_text || '');

  const normalizeLines = (text) => String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^---\s*\[(?:HALAMAN|BAGIAN)/i.test(l));

  const linesA = normalizeLines(docA.extracted_text);
  const linesB = normalizeLines(docB.extracted_text);
  const setA = new Set(linesA);
  const setB = new Set(linesB);

  const onlyInFirst = linesA.filter((l) => !setB.has(l)).slice(0, 25);
  const onlyInSecond = linesB.filter((l) => !setA.has(l)).slice(0, 25);
  const commonCount = linesA.filter((l) => setB.has(l)).length;

  let focusSnippets = null;
  if (focus && String(focus).trim()) {
    const matchA = searchDocumentSnippets([docA], focus, { limit: 1, snippetChars: 500 })[0];
    const matchB = searchDocumentSnippets([docB], focus, { limit: 1, snippetChars: 500 })[0];
    focusSnippets = {
      focus: String(focus).trim(),
      firstExcerpt: matchA ? matchA.excerpt : String(docA.extracted_text || '').slice(0, 500),
      secondExcerpt: matchB ? matchB.excerpt : String(docB.extracted_text || '').slice(0, 500)
    };
  }

  const extA = path.extname(String(docA.filename || '')).toLowerCase();
  const extB = path.extname(String(docB.filename || '')).toLowerCase();
  const spreadsheetExts = new Set(['.xlsx', '.xlsm', '.csv']);
  let spreadsheetDelta = null;
  if (spreadsheetExts.has(extA) && spreadsheetExts.has(extB)) {
    const statsA = analyzeSpreadsheetText(docA.extracted_text, { filename: docA.filename, rowLimit: 5 });
    const statsB = analyzeSpreadsheetText(docB.extracted_text, { filename: docB.filename, rowLimit: 5 });
    const columnDeltas = [];
    for (const colA of statsA.columns) {
      if (!colA.numericStats) continue;
      const colB = statsB.columns.find((c) => c.name.toLowerCase() === colA.name.toLowerCase());
      if (colB?.numericStats) {
        columnDeltas.push({
          column: colA.name,
          firstSum: colA.numericStats.sum,
          secondSum: colB.numericStats.sum,
          sumDiff: roundStat(colB.numericStats.sum - colA.numericStats.sum),
          firstAvg: colA.numericStats.avg,
          secondAvg: colB.numericStats.avg
        });
      }
    }
    spreadsheetDelta = {
      firstRowCount: statsA.totalRows,
      secondRowCount: statsB.totalRows,
      columnDeltas
    };
  }

  return {
    firstDocument: {
      documentId: docA.id,
      filename: docA.filename,
      mimeType: docA.mime_type,
      pageCount: pagesA.length,
      lineCount: linesA.length
    },
    secondDocument: {
      documentId: docB.id,
      filename: docB.filename,
      mimeType: docB.mime_type,
      pageCount: pagesB.length,
      lineCount: linesB.length
    },
    summary: {
      commonLinesCount: commonCount,
      removedOrOnlyInFirstCount: linesA.filter((l) => !setB.has(l)).length,
      addedOrOnlyInSecondCount: linesB.filter((l) => !setA.has(l)).length
    },
    onlyInFirst,
    onlyInSecond,
    ...(focusSnippets ? { focusSnippets } : {}),
    ...(spreadsheetDelta ? { spreadsheetDelta } : {})
  };
}

// ============================================================================
// Phase 3 Rich Inline Markdown Parser & Native PDF 1.4 Generator
// ============================================================================

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

function escapePdfString(value) {
  const safe = String(value ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2022/g, '*')
    .replace(/\u2026/g, '...')
    // Keep WinAnsi / Latin-1 printable range for standard Type1 PDF fonts
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ');
  return safe
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrapTextToWidth(text, maxChars) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [''];
  if (clean.length <= maxChars) return [clean];
  const words = clean.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function buildPdf14Buffer({ title, content, documentType = 'general', subtitle = '', author = 'Bubu AI' }) {
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const marginX = 50;
  const topY = 780;
  const bottomY = 65;
  const contentWidth = pageWidth - marginX * 2;
  const label = DOC_TYPE_LABELS[documentType] || DOC_TYPE_LABELS.general;

  const pagesOps = [];
  let currentOps = [];
  let cursorY = topY;

  const startNewPage = () => {
    if (currentOps.length > 0) pagesOps.push(currentOps);
    currentOps = [];
    cursorY = topY;
    // Page header bar
    currentOps.push('0.45 0.45 0.45 rg');
    currentOps.push(`BT /F1 8 Tf ${marginX} 805 Td (${escapePdfString(`BUBU AI  |  ${label}`)}) Tj ET`);
    currentOps.push('0.85 0.89 0.95 RG 0.75 w');
    currentOps.push(`${marginX} 798 m ${pageWidth - marginX} 798 l S`);
    currentOps.push('0 0 0 rg');
  };

  const ensureSpace = (neededPt) => {
    if (cursorY - neededPt < bottomY) {
      startNewPage();
    }
  };

  const addTextLine = (text, { font = 'F1', size = 10.5, indent = 0, color = '0.13 0.13 0.13', leading = 15 } = {}) => {
    ensureSpace(leading);
    currentOps.push(`${color} rg`);
    currentOps.push(`BT /${font} ${size} Tf ${(marginX + indent).toFixed(2)} ${cursorY.toFixed(2)} Td (${escapePdfString(text)}) Tj ET`);
    cursorY -= leading;
  };

  startNewPage();

  // Title block on Page 1
  for (const line of wrapTextToWidth(stripInlineMarkdown(title), 52)) {
    addTextLine(line, { font: 'F2', size: 18, color: '0.12 0.31 0.47', leading: 23 });
  }
  if (subtitle) {
    for (const line of wrapTextToWidth(stripInlineMarkdown(subtitle), 68)) {
      addTextLine(line, { font: 'F3', size: 11, color: '0.35 0.35 0.35', leading: 16 });
    }
  }
  addTextLine(label, { font: 'F2', size: 9, color: '0.27 0.45 0.77', leading: 18 });
  cursorY -= 6;

  const rawLines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  let index = 0;
  while (index < rawLines.length) {
    const raw = rawLines[index];
    const trimmed = raw.trim();
    if (!trimmed) {
      cursorY -= 6;
      index++;
      continue;
    }

    // Markdown pipe table
    if (trimmed.startsWith('|') && index + 1 < rawLines.length && /^\|?[\s:|-]+\|?$/.test(rawLines[index + 1].trim())) {
      const parseCells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => stripInlineMarkdown(c.trim()));
      const headerCells = parseCells(raw);
      const colCount = Math.max(1, headerCells.length);
      const colWidth = contentWidth / colCount;
      index += 2;
      const tableRows = [headerCells];
      while (index < rawLines.length && rawLines[index].trim().startsWith('|')) {
        const rowCells = parseCells(rawLines[index]);
        tableRows.push(Array.from({ length: colCount }, (_, i) => rowCells[i] ?? ''));
        index++;
      }

      const rowHeight = 20;
      for (let r = 0; r < tableRows.length; r++) {
        ensureSpace(rowHeight + 4);
        const rowTop = cursorY + 11;
        const rowBottom = rowTop - rowHeight;
        if (r === 0) {
          currentOps.push('0.12 0.31 0.47 rg');
          currentOps.push(`${marginX} ${rowBottom.toFixed(2)} ${contentWidth.toFixed(2)} ${rowHeight} re f`);
        } else if (r % 2 === 1) {
          currentOps.push('0.96 0.97 0.99 rg');
          currentOps.push(`${marginX} ${rowBottom.toFixed(2)} ${contentWidth.toFixed(2)} ${rowHeight} re f`);
        }
        currentOps.push('0.82 0.86 0.92 RG 0.5 w');
        currentOps.push(`${marginX} ${rowBottom.toFixed(2)} ${contentWidth.toFixed(2)} ${rowHeight} re S`);

        const maxCellChars = Math.max(6, Math.floor(colWidth / 5.4));
        for (let c = 0; c < colCount; c++) {
          const cellX = marginX + c * colWidth + 5;
          const cellText = String(tableRows[r][c] ?? '').slice(0, maxCellChars);
          currentOps.push(r === 0 ? '1 1 1 rg' : '0.13 0.13 0.13 rg');
          currentOps.push(`BT /${r === 0 ? 'F2' : 'F1'} 9 Tf ${cellX.toFixed(2)} ${(rowBottom + 6).toFixed(2)} Td (${escapePdfString(cellText)}) Tj ET`);
        }
        cursorY -= rowHeight;
      }
      cursorY -= 8;
      continue;
    }

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      ensureSpace(14);
      currentOps.push('0.85 0.89 0.95 RG 0.75 w');
      currentOps.push(`${marginX} ${cursorY.toFixed(2)} m ${(pageWidth - marginX).toFixed(2)} ${cursorY.toFixed(2)} l S`);
      cursorY -= 12;
    } else if (/^###\s+/.test(trimmed)) {
      cursorY -= 4;
      for (const line of wrapTextToWidth(stripInlineMarkdown(trimmed.replace(/^###\s+/, '')), 74)) {
        addTextLine(line, { font: 'F2', size: 11.5, color: '0.18 0.33 0.55', leading: 16 });
      }
    } else if (/^##\s+/.test(trimmed)) {
      cursorY -= 6;
      for (const line of wrapTextToWidth(stripInlineMarkdown(trimmed.replace(/^##\s+/, '')), 68)) {
        addTextLine(line, { font: 'F2', size: 13, color: '0.12 0.31 0.47', leading: 18 });
      }
    } else if (/^#\s+/.test(trimmed)) {
      cursorY -= 8;
      for (const line of wrapTextToWidth(stripInlineMarkdown(trimmed.replace(/^#\s+/, '')), 62)) {
        addTextLine(line, { font: 'F2', size: 14.5, color: '0.12 0.31 0.47', leading: 20 });
      }
    } else if (/^[-*•]\s+/.test(trimmed)) {
      const itemText = stripInlineMarkdown(trimmed.replace(/^[-*•]\s+/, ''));
      const wrapped = wrapTextToWidth(itemText, 80);
      wrapped.forEach((line, idx) => {
        addTextLine(idx === 0 ? `*  ${line}` : `   ${line}`, { font: 'F1', size: 10.5, indent: 10, leading: 14.5 });
      });
    } else if (/^\d+[.)]\s+/.test(trimmed)) {
      const numPrefix = (trimmed.match(/^(\d+[.)])\s+/) || ['', '1.'])[1];
      const itemText = stripInlineMarkdown(trimmed.replace(/^\d+[.)]\s+/, ''));
      const wrapped = wrapTextToWidth(itemText, 78);
      wrapped.forEach((line, idx) => {
        addTextLine(idx === 0 ? `${numPrefix} ${line}` : `   ${line}`, { font: 'F1', size: 10.5, indent: 10, leading: 14.5 });
      });
    } else if (trimmed.startsWith('> ')) {
      const quoteText = stripInlineMarkdown(trimmed.slice(2));
      for (const line of wrapTextToWidth(quoteText, 78)) {
        addTextLine(line, { font: 'F3', size: 10, indent: 14, color: '0.38 0.38 0.38', leading: 14.5 });
      }
    } else {
      const tokens = parseInlineMarkdownTokens(trimmed);
      const isAllBold = tokens.length === 1 && tokens[0].bold;
      const isAllItalic = tokens.length === 1 && tokens[0].italics;
      const isAllCode = tokens.length === 1 && tokens[0].code;
      const font = isAllBold ? 'F2' : (isAllItalic ? 'F3' : (isAllCode ? 'F4' : 'F1'));
      for (const line of wrapTextToWidth(stripInlineMarkdown(trimmed), 84)) {
        addTextLine(line, { font, size: 10.5, leading: 15 });
      }
    }
    index++;
  }

  if (currentOps.length > 0) pagesOps.push(currentOps);
  const totalPages = Math.max(1, pagesOps.length);

  // Add footer with page numbers to every page
  pagesOps.forEach((ops, idx) => {
    ops.push('0.85 0.89 0.95 RG 0.5 w');
    ops.push(`${marginX} 48 m ${pageWidth - marginX} 48 l S`);
    ops.push('0.50 0.50 0.50 rg');
    ops.push(`BT /F1 8 Tf ${marginX} 35 Td (${escapePdfString(`Dibuat dengan ${author}  |  Halaman ${idx + 1} dari ${totalPages}`)}) Tj ET`);
  });

  // Assemble PDF 1.4 objects
  // Object 1: Catalog
  // Object 2: Pages
  // Object 3: Font F1 (Helvetica)
  // Object 4: Font F2 (Helvetica-Bold)
  // Object 5: Font F3 (Helvetica-Oblique)
  // Object 6: Font F4 (Courier)
  // Object 7: Info
  // Objects 8..: Page + Content stream pairs
  const objects = [];
  const addObject = (body) => {
    objects.push(body);
    return objects.length;
  };

  addObject('<< /Type /Catalog /Pages 2 0 R >>'); // 1
  addObject(''); // 2 placeholder for Pages
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); // 3
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'); // 4
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>'); // 5
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'); // 6
  addObject(`<< /Title (${escapePdfString(title)}) /Author (${escapePdfString(author)}) /Subject (${escapePdfString(label)}) /Creator (Bubu AI v2.4) >>`); // 7

  const pageObjectIds = [];
  for (const ops of pagesOps) {
    const streamContent = ops.join('\n');
    const streamBytes = Buffer.byteLength(streamContent, 'latin1');
    const contentObjId = addObject(`<< /Length ${streamBytes} >>\nstream\n${streamContent}\nendstream`);
    const pageObjId = addObject(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> ` +
      `/Contents ${contentObjId} 0 R >>`
    );
    pageObjectIds.push(pageObjId);
  }

  objects[1] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>`;

  const chunks = ['%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'];
  const offsets = [0];
  let byteOffset = Buffer.byteLength(chunks[0], 'latin1');

  for (let i = 0; i < objects.length; i++) {
    offsets.push(byteOffset);
    const objStr = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    chunks.push(objStr);
    byteOffset += Buffer.byteLength(objStr, 'latin1');
  }

  const xrefStart = byteOffset;
  const xrefLines = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f '
  ];
  for (let i = 1; i <= objects.length; i++) {
    xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n `);
  }
  const trailer = [
    ...xrefLines,
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>`,
    'startxref',
    String(xrefStart),
    '%%EOF\n'
  ].join('\n');
  chunks.push(trailer);

  return Buffer.from(chunks.join(''), 'latin1');
}

// ============================================================================
// DocumentService Class
// ============================================================================

class DocumentService {
  constructor({
    db,
    wahaConfig,
    storageDir,
    maxFileBytes = 15 * 1024 * 1024,
    maxExtractChars = 50000,
    ocrEnabled = true,
    maxPdfOcrPages = 10,
    pdfRenderDpi = 150,
    pdftoppmBin = 'pdftoppm',
    ghostscriptBin = 'gs',
    tesseractBin = 'tesseract',
    ffmpegBin = 'ffmpeg',
    httpClient = null,
    pdfParser = null,
    mammothLib = null,
    commandRunner = runDocCommand,
    logger = null
  }) {
    this.db = db;
    this.wahaConfig = wahaConfig;
    this.storageDir = storageDir;
    this.maxFileBytes = maxFileBytes;
    this.maxExtractChars = maxExtractChars;
    this.ocrEnabled = ocrEnabled;
    this.maxPdfOcrPages = maxPdfOcrPages;
    this.pdfRenderDpi = pdfRenderDpi;
    this.pdftoppmBin = pdftoppmBin;
    this.ghostscriptBin = ghostscriptBin;
    this.tesseractBin = tesseractBin;
    this.ffmpegBin = ffmpegBin;
    this.httpClient = httpClient;
    this.pdfParser = pdfParser;
    this.mammothLib = mammothLib;
    this.commandRunner = commandRunner;
    this.logger = logger;
    this.ocrBusy = false;
    try {
      fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES') && String(storageDir).startsWith('/tmp/')) {
        const fallbackDir = path.join(os.tmpdir(), path.basename(storageDir));
        fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
        this.storageDir = fallbackDir;
      } else {
        throw err;
      }
    }
  }

  async downloadMedia(mediaUrl, filename, mimetype) {
    const url = normalizeMediaUrl(mediaUrl, this.wahaConfig.baseUrl);
    let safeName = safeFilename(filename || `document${path.extname(url.pathname) || ''}`);
    if (!path.extname(safeName)) {
      const inferredExt = documentExtensionFromMime(mimetype) ||
        documentExtensionFromMime(url.searchParams.get('mimetype'));
      if (!inferredExt) throw new Error('Ekstensi dokumen tidak tersedia dan tidak dapat ditentukan dari MIME type.');
      safeName = `${safeName}${inferredExt}`;
    }
    const ext = validateExtension(safeName, mimetype);
    const accepted = ALLOWED.get(ext);
    const axios = this.httpClient || require('axios');
    const response = await axios.get(url.toString(), {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: this.maxFileBytes,
      maxBodyLength: this.maxFileBytes,
      maxRedirects: 0,
      headers: this.wahaConfig.apiKey ? { 'X-Api-Key': this.wahaConfig.apiKey } : {}
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Unduhan dokumen ditolak dengan HTTP ${response.status}. Redirect tidak diikuti.`);
    }
    const contentLength = Number(response.headers?.['content-length']);
    if (Number.isFinite(contentLength) && contentLength > this.maxFileBytes) {
      throw new Error('Ukuran dokumen melewati batas sebelum file disimpan.');
    }

    const responseMime = response.headers?.['content-type'] || '';
    validateResponseMime(mimetype, responseMime, accepted, ext);
    const buffer = Buffer.from(response.data);
    if (!buffer.length || buffer.length > this.maxFileBytes) throw new Error('Ukuran dokumen kosong atau melebihi batas.');
    if (ext === '.pdf' && buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('File tidak memiliki signature PDF yang valid.');
    }
    if (['.docx', '.xlsx', '.xlsm'].includes(ext) &&
        !(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
      throw new Error('File Office tidak memiliki signature ZIP/Office yang valid.');
    }
    if (['.csv', '.txt'].includes(ext) && buffer.includes(0)) {
      throw new Error('Dokumen teks mengandung byte NUL dan ditolak.');
    }

    const id = crypto.randomUUID();
    const folder = path.join(this.storageDir, id.slice(0, 2));
    await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
    const filePath = path.join(folder, `${id}${ext}`);
    try {
      await fsp.writeFile(filePath, buffer, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      await fsp.rm(filePath, { force: true }).catch(() => {});
      await fsp.rmdir(folder).catch(() => {});
      throw error;
    }
    return {
      id, filePath, buffer, fileSize: buffer.length,
      filename: safeName,
      mimeType: normalizeMimeType(mimetype) || normalizeMimeType(responseMime) || 'application/octet-stream',
      ext
    };
  }

  async parsePdfDigitalPages(buffer) {
    const parser = this.pdfParser || require('pdf-parse');
    const collectedPages = [];
    const options = {
      pagerender: async (pageData) => {
        if (!pageData || typeof pageData.getTextContent !== 'function') return '';
        const textContent = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
        let lastY = null;
        let pageText = '';
        for (const item of textContent.items || []) {
          const y = item.transform ? item.transform[5] : null;
          if (lastY === null || y === lastY) {
            pageText += item.str;
          } else {
            pageText += `\n${item.str}`;
          }
          lastY = y;
        }
        const cleaned = pageText.replace(/\u0000/g, '').trim();
        collectedPages.push(cleaned);
        return cleaned;
      }
    };

    const parsed = await parser(buffer, options);
    const rawText = String(parsed?.text || '').replace(/\u0000/g, '').trim();
    const numPages = Number(parsed?.numpages) || collectedPages.length || (rawText ? 1 : 0);

    if (collectedPages.length > 0) {
      return { pages: collectedPages, totalPages: Math.max(numPages, collectedPages.length), rawText };
    }
    if (rawText.includes('\f')) {
      const splitPages = rawText.split('\f').map((p) => p.trim());
      return { pages: splitPages, totalPages: Math.max(numPages, splitPages.length), rawText };
    }
    if (numPages > 1 && rawText) {
      // Split evenly into virtual pages if parser did not expose per-page callbacks
      const pages = splitDocumentIntoPages(rawText, { defaultPageChars: Math.max(1500, Math.ceil(rawText.length / numPages)) })
        .map((p) => p.content);
      return { pages, totalPages: numPages, rawText };
    }
    return { pages: rawText ? [rawText] : [], totalPages: numPages, rawText };
  }

  async renderPdfPagesToImages(pdfPath, workDir, maxPages) {
    const prefix = path.join(workDir, 'page');
    // 1. Try pdftoppm (poppler-utils)
    try {
      await this.commandRunner(this.pdftoppmBin, [
        '-jpeg',
        '-r', String(this.pdfRenderDpi),
        '-f', '1',
        '-l', String(maxPages),
        pdfPath,
        prefix
      ], { timeoutMs: 90000 });
    } catch (err) {
      this.logger?.debug?.({ error: err.message }, 'pdftoppm render failed; trying fallback renderer');
    }

    let files = (await fsp.readdir(workDir))
      .filter((f) => /^page[-_]?\d+\.jpe?g$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    // 2. Fallback to Ghostscript (gs)
    if (!files.length) {
      try {
        await this.commandRunner(this.ghostscriptBin, [
          '-dSAFER', '-dBATCH', '-dNOPAUSE',
          '-sDEVICE=jpeg',
          `-r${this.pdfRenderDpi}`,
          '-dFirstPage=1',
          `-dLastPage=${maxPages}`,
          `-sOutputFile=${path.join(workDir, 'page-%03d.jpg')}`,
          pdfPath
        ], { timeoutMs: 90000 });
        files = (await fsp.readdir(workDir))
          .filter((f) => /^page[-_]?\d+\.jpe?g$/i.test(f))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      } catch (err) {
        this.logger?.debug?.({ error: err.message }, 'Ghostscript render failed; trying FFmpeg fallback');
      }
    }

    // 3. Fallback to FFmpeg
    if (!files.length) {
      try {
        await this.commandRunner(this.ffmpegBin, [
          '-nostdin', '-y', '-i', pdfPath,
          '-vf', 'scale=min(1280\\,iw):-2',
          '-frames:v', String(maxPages),
          path.join(workDir, 'page-%03d.jpg')
        ], { timeoutMs: 90000 });
        files = (await fsp.readdir(workDir))
          .filter((f) => /^page[-_]?\d+\.jpe?g$/i.test(f))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      } catch (err) {
        this.logger?.warn?.({ error: err.message }, 'All PDF page image renderers failed');
      }
    }

    return files.slice(0, maxPages).map((f) => path.join(workDir, f));
  }

  async ocrPdfPages({ buffer, filePath = null, digitalPages = [], totalPages = 0 }) {
    if (this.ocrBusy) {
      throw new Error('Pemrosesan OCR dokumen sedang sibuk. Silakan coba kembali beberapa saat lagi.');
    }
    this.ocrBusy = true;
    let workDir = null;
    try {
      workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bubu-pdf-ocr-'));
      let pdfInputPath = filePath;
      if (!pdfInputPath || !fs.existsSync(pdfInputPath)) {
        pdfInputPath = path.join(workDir, 'input.pdf');
        await fsp.writeFile(pdfInputPath, buffer, { mode: 0o600 });
      }

      const maxPages = this.maxPdfOcrPages;
      const renderedImages = await this.renderPdfPagesToImages(pdfInputPath, workDir, maxPages);
      const count = Math.max(digitalPages.length, renderedImages.length);
      const combinedSections = [];

      for (let idx = 0; idx < count; idx++) {
        const pageNo = idx + 1;
        const digitalText = String(digitalPages[idx] || '').trim();
        if (digitalText.length >= 20) {
          combinedSections.push(`--- [HALAMAN ${pageNo} — TEKS ASLI] ---\n${digitalText}`);
          continue;
        }
        if (idx < renderedImages.length) {
          const imgPath = renderedImages[idx];
          try {
            const ocrResult = await this.commandRunner(this.tesseractBin, [
              imgPath, 'stdout', '-l', 'ind+eng', '--psm', '3'
            ], { timeoutMs: 60000, maxOutput: 500000 });
            const ocrText = String(ocrResult.stdout || '').trim();
            if (ocrText) {
              const merged = digitalText ? `${digitalText}\n${ocrText}` : ocrText;
              combinedSections.push(`--- [HALAMAN ${pageNo} — OCR SCAN] ---\n${merged}`);
              continue;
            }
          } catch (ocrErr) {
            this.logger?.warn?.({ pageNo, error: ocrErr.message }, 'PDF page OCR failed');
          }
        }
        if (digitalText) {
          combinedSections.push(`--- [HALAMAN ${pageNo} — TEKS ASLI] ---\n${digitalText}`);
        }
      }

      const declaredTotal = Math.max(totalPages, count);
      if (declaredTotal > maxPages && renderedImages.length > 0) {
        combinedSections.push(
          `[CATATAN OCR: Dokumen memiliki ${declaredTotal} halaman; pemindaian OCR dibatasi pada ${maxPages} halaman pertama untuk menjaga stabilitas resource server.]`
        );
      }
      return combinedSections.join('\n\n').trim();
    } finally {
      if (workDir) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
      this.ocrBusy = false;
    }
  }

  async extract({ buffer, ext, filePath = null }) {
    let text = '';
    if (ext === '.pdf') {
      let digital = { pages: [], totalPages: 0, rawText: '' };
      try {
        digital = await this.parsePdfDigitalPages(buffer);
      } catch (parseErr) {
        if (!this.ocrEnabled) throw parseErr;
        this.logger?.warn?.({ error: parseErr.message }, 'Digital PDF parsing failed; attempting OCR fallback');
      }

      const nonEmptyDigitalPages = digital.pages.filter((p) => String(p || '').trim().length >= 20);
      const needsOcr = this.ocrEnabled && (
        nonEmptyDigitalPages.length === 0 ||
        (digital.pages.slice(0, this.maxPdfOcrPages).some((p) => String(p || '').trim().length < 20))
      );

      if (needsOcr) {
        const ocrOutput = await this.ocrPdfPages({
          buffer,
          filePath,
          digitalPages: digital.pages,
          totalPages: digital.totalPages
        });
        text = ocrOutput;
      }

      if (!text && digital.pages.length > 0) {
        if (digital.pages.length === 1) {
          text = `--- [HALAMAN 1] ---\n${digital.pages[0]}`;
        } else {
          text = digital.pages
            .map((p, idx) => `--- [HALAMAN ${idx + 1}] ---\n${p}`)
            .join('\n\n');
        }
      } else if (!text && digital.rawText) {
        text = digital.rawText;
      }
    } else if (ext === '.docx') {
      text = await extractStructuredDocxText(buffer, this.mammothLib);
    } else if (ext === '.xlsx' || ext === '.xlsm') {
      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const sections = [];
      workbook.eachSheet((sheet) => {
        sections.push(`SHEET: ${sheet.name}`);
        sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
          sections.push(`${rowNumber}: ${row.values.slice(1).map((v) => {
            if (v && typeof v === 'object' && v.text) return v.text;
            if (v && typeof v === 'object' && v.result !== undefined) return v.result;
            return String(v ?? '');
          }).join(' | ')}`);
        });
      });
      text = sections.join('\n');
    } else if (ext === '.csv') {
      const rawCsv = buffer.toString('utf8').replace(/\u0000/g, '').trim();
      const parsedCsv = parseCsvText(rawCsv);
      if (parsedCsv.rows.length > 0) {
        text = [
          'SHEET: CSV',
          ...parsedCsv.rows.map((row, idx) => `${idx + 1}: ${row.join(' | ')}`)
        ].join('\n');
      } else {
        text = rawCsv;
      }
    } else if (ext === '.txt') {
      text = buffer.toString('utf8');
    }

    text = text.replace(/\u0000/g, '').trim();
    if (!text) throw new Error('Dokumen berhasil diunduh tetapi teks tidak dapat diekstrak. Dokumen mungkin berupa scan/gambar.');
    return text.slice(0, this.maxExtractChars);
  }

  async ingestMedia({ media, scope, ownerId, chatId, sourceEventId }) {
    if (!media?.url) throw new Error('WAHA tidak menyediakan media.url. Pastikan media download di WAHA aktif.');
    const normalizedUrl = normalizeMediaUrl(media.url, this.wahaConfig.baseUrl);
    const filename = media.filename || media.fileName ||
      `document${path.extname(normalizedUrl.pathname) || documentExtensionFromMime(media.mimetype)}`;
    const downloaded = await this.downloadMedia(normalizedUrl.toString(), filename, media.mimetype);
    try {
      const extractedText = await this.extract(downloaded);
      const pages = splitDocumentIntoPages(extractedText);
      const hasOcrPages = pages.some((p) => p.isOcr);
      const record = this.db.saveDocument({
        id: downloaded.id, scope, ownerId: scope === 'personal' ? ownerId : null,
        chatId: scope === 'group' ? chatId : null,
        filename: downloaded.filename, mimeType: downloaded.mimeType,
        filePath: downloaded.filePath, fileSize: downloaded.fileSize,
        extractedText, sourceEventId
      });
      if (record.id !== downloaded.id) await fsp.rm(downloaded.filePath, { force: true }).catch(() => {});
      return {
        ...record,
        extractedText: record.extracted_text || extractedText,
        pageCount: pages.length,
        hasOcrPages,
        extractionMode: hasOcrPages ? 'ocr_or_hybrid' : 'text'
      };
    } catch (error) {
      await fsp.rm(downloaded.filePath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async createDocx({ title, content, documentType = 'general', subtitle = '', author = 'Bubu AI' }) {
    const {
      Document, Paragraph, TextRun, HeadingLevel, Packer,
      Table, TableRow, TableCell, WidthType, AlignmentType,
      Header, Footer, PageNumber, BorderStyle, ShadingType
    } = require('docx');

    const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
    const children = [];
    const border = { style: BorderStyle.SINGLE, size: 1, color: 'D9E2F3' };
    const tableBorders = { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border };

    const buildInlineRuns = (text, baseOptions = {}) => {
      const tokens = parseInlineMarkdownTokens(text);
      return tokens.map((token) => new TextRun({
        text: String(token.text ?? ''),
        font: token.code ? 'Consolas' : (baseOptions.font || 'Aptos'),
        size: baseOptions.size || 22,
        bold: Boolean(baseOptions.bold || token.bold),
        italics: Boolean(baseOptions.italics || token.italics),
        color: baseOptions.color
      }));
    };

    const paragraph = (text, options = {}) => new Paragraph({
      spacing: { after: 120, line: 300 },
      ...options,
      children: buildInlineRuns(text, { font: 'Aptos', size: 22 })
    });
    const makeCell = (text, header = false) => new TableCell({
      width: { size: 100, type: WidthType.AUTO },
      shading: header ? { fill: '1F4E78', type: ShadingType.CLEAR } : undefined,
      margins: { top: 100, bottom: 100, left: 120, right: 120 },
      children: [new Paragraph({
        children: buildInlineRuns(text, {
          bold: header,
          color: header ? 'FFFFFF' : '222222',
          font: 'Aptos',
          size: 20
        })
      })]
    });

    children.push(new Paragraph({
      text: stripInlineMarkdown(title),
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 180 }
    }));
    if (subtitle) children.push(new Paragraph({
      text: stripInlineMarkdown(subtitle),
      alignment: AlignmentType.CENTER,
      spacing: { after: 260 }
    }));

    const label = DOC_TYPE_LABELS[documentType] || DOC_TYPE_LABELS.general;
    children.push(new Paragraph({
      children: [new TextRun({ text: label, bold: true, color: '4472C4', size: 18, font: 'Aptos' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 }
    }));

    let index = 0;
    while (index < lines.length) {
      const raw = lines[index];
      const trimmed = raw.trim();
      if (!trimmed) {
        children.push(new Paragraph({ text: '', spacing: { after: 80 } }));
        index++;
        continue;
      }

      // Markdown pipe table: header row, separator row, then data rows.
      if (trimmed.startsWith('|') && index + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[index + 1].trim())) {
        const parseCells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
        const headerCells = parseCells(raw);
        const normalizeCells = (cells) => Array.from(
          { length: headerCells.length },
          (_, cellIndex) => cells[cellIndex] ?? ''
        );
        index += 2;
        const rows = [new TableRow({ children: normalizeCells(headerCells).map((cell) => makeCell(cell, true)) })];
        while (index < lines.length && lines[index].trim().startsWith('|')) {
          rows.push(new TableRow({ children: normalizeCells(parseCells(lines[index])).map((cell) => makeCell(cell, false)) }));
          index++;
        }
        children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, borders: tableBorders }));
        children.push(new Paragraph({ text: '', spacing: { after: 100 } }));
        continue;
      }

      if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
        children.push(new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D9E2F3' } },
          spacing: { after: 180 }
        }));
      } else if (/^###\s+/.test(trimmed)) {
        children.push(new Paragraph({ text: stripInlineMarkdown(trimmed.replace(/^###\s+/, '')), heading: HeadingLevel.HEADING_3, spacing: { before: 160, after: 100 } }));
      } else if (/^##\s+/.test(trimmed)) {
        children.push(new Paragraph({ text: stripInlineMarkdown(trimmed.replace(/^##\s+/, '')), heading: HeadingLevel.HEADING_2, spacing: { before: 220, after: 120 } }));
      } else if (/^#\s+/.test(trimmed)) {
        children.push(new Paragraph({ text: stripInlineMarkdown(trimmed.replace(/^#\s+/, '')), heading: HeadingLevel.HEADING_1, spacing: { before: 260, after: 140 } }));
      } else if (/^[-*•]\s+/.test(trimmed)) {
        children.push(new Paragraph({
          children: buildInlineRuns(trimmed.replace(/^[-*•]\s+/, ''), { font: 'Aptos', size: 22 }),
          bullet: { indent: 360 },
          spacing: { after: 80 }
        }));
      } else if (/^\d+[.)]\s+/.test(trimmed)) {
        children.push(new Paragraph({
          children: buildInlineRuns(trimmed.replace(/^\d+[.)]\s+/, ''), { font: 'Aptos', size: 22 }),
          numbering: { reference: 'bubu-numbering', level: 0 },
          spacing: { after: 80 }
        }));
      } else if (trimmed.startsWith('> ')) {
        children.push(new Paragraph({
          children: buildInlineRuns(trimmed.slice(2), { italics: true, color: '666666', font: 'Aptos', size: 21 }),
          indent: { left: 360 },
          border: { left: { style: BorderStyle.SINGLE, size: 12, color: '4472C4' } },
          spacing: { after: 120 }
        }));
      } else {
        children.push(paragraph(trimmed));
      }
      index++;
    }

    const doc = new Document({
      creator: author,
      title: stripInlineMarkdown(title),
      subject: label,
      numbering: {
        config: [{
          reference: 'bubu-numbering',
          levels: [{
            level: 0,
            format: 'decimal',
            text: '%1.',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } }
          }]
        }]
      },
      sections: [{
        headers: {
          default: new Header({ children: [new Paragraph({
            children: [new TextRun({ text: 'BUBU AI  |  ' + label, color: '777777', size: 16 })],
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D9E2F3' } }
          })] })
        },
        footers: {
          default: new Footer({ children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              new TextRun({ text: 'Dibuat dengan Bubu AI  •  Halaman ', color: '888888', size: 16 }),
              new TextRun({ children: [PageNumber.CURRENT], color: '888888', size: 16 })
            ]
          })] })
        },
        children
      }]
    });
    return Packer.toBuffer(doc);
  }

  async createPdf({ title, content, documentType = 'general', subtitle = '', author = 'Bubu AI' }) {
    return buildPdf14Buffer({ title, content, documentType, subtitle, author });
  }

  async createXlsx({ title, headers = [], rows = [], formulas = {}, columnFormats = {}, sheets = [], freezeRows = 1 }) {
    const definitions = Array.isArray(sheets) && sheets.length
      ? sheets
      : [{ name: title || 'Data', headers, rows, formulas, columnFormats, freezeRows }];
    const cleanSheetName = (value) =>
      String(value || 'Data').replace(/[\\/*?:[\]]/g, ' ').trim().slice(0, 31) || 'Data';
    const normalizedNames = definitions.map((item) => cleanSheetName(item.name).toLowerCase());
    if (definitions.length > 12) throw new Error('Workbook maksimal memiliki 12 worksheet.');
    if (new Set(normalizedNames).size !== normalizedNames.length) {
      throw new Error('Nama worksheet harus unik (tidak membedakan huruf besar/kecil).');
    }
    const totalRows = definitions.reduce((sum, item) => sum + 1 + (item.rows?.length || 0), 0);
    if (totalRows > 5000) throw new Error('Workbook maksimal memiliki 5.000 baris data termasuk header.');

    const blockedFormulaFunctions = /\b(?:HYPERLINK|WEBSERVICE|RTD|DDE|CALL|REGISTER\.ID|EXEC)\s*\(/i;
    const externalWorkbookReference = /\[[^\]]+\]/;
    const ddeFormula = /\b(?:cmd|powershell|bash|sh)\s*\|/i;
    for (const definition of definitions) {
      for (const [cell, rawFormula] of Object.entries(definition.formulas || {})) {
        const formula = String(rawFormula || '').replace(/^=/, '').trim();
        if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/i.test(cell) || !formula || formula.length > 500 ||
            blockedFormulaFunctions.test(formula) || externalWorkbookReference.test(formula) ||
            ddeFormula.test(formula)) {
          throw new Error(`Formula ditolak atau alamat cell tidak valid pada ${cell}.`);
        }
      }
    }

    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Bubu AI';
    workbook.created = new Date();
    workbook.modified = new Date();
    workbook.calcProperties.fullCalcOnLoad = true;

    for (const definition of definitions) {
      const sheetName = cleanSheetName(definition.name);
      const sheet = workbook.addWorksheet(sheetName);
      const sheetHeaders = Array.isArray(definition.headers) ? definition.headers : [];
      const sheetRows = Array.isArray(definition.rows) ? definition.rows : [];
      if (sheetHeaders.length) sheet.addRow(sheetHeaders);
      for (const row of sheetRows) sheet.addRow(Array.isArray(row) ? row : [row]);

      const sheetFormulas = definition.formulas || {};
      for (const [cell, rawFormula] of Object.entries(sheetFormulas)) {
        if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/i.test(cell)) throw new Error(`Alamat formula tidak valid: ${cell}`);
        const formula = String(rawFormula || '').replace(/^=/, '').trim();
        if (!formula || formula.length > 500 ||
            blockedFormulaFunctions.test(formula) ||
            externalWorkbookReference.test(formula) || ddeFormula.test(formula)) {
          throw new Error(`Formula ditolak pada ${cell}.`);
        }
        sheet.getCell(cell).value = { formula };
      }

      if (sheet.rowCount > 0) {
        const headerRow = sheet.getRow(1);
        headerRow.height = 24;
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Aptos' };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
        headerRow.alignment = { vertical: 'middle', wrapText: true };
        sheet.views = [{ state: 'frozen', ySplit: Math.max(1, Math.min(20, Number(definition.freezeRows ?? freezeRows) || 1)) }];
        sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, sheet.columnCount) } };

        for (let col = 1; col <= sheet.columnCount; col++) {
          const column = sheet.getColumn(col);
          const values = column.values;
          const width = Math.max(12, ...values.map((value) => {
            if (value && typeof value === 'object' && value.formula) return 14;
            return String(value ?? '').length + 2;
          }));
          column.width = Math.min(42, width);
          const key = column.letter;
          if (definition.columnFormats?.[key]) {
            column.numFmt = String(definition.columnFormats[key]).slice(0, 80);
          }
        }
        for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex++) {
          sheet.getRow(rowIndex).alignment = { vertical: 'top', wrapText: true };
        }
      }
    }
    return workbook.xlsx.writeBuffer();
  }

  async persistGenerated({ buffer, filename, mimeType }) {
    const safe = safeFilename(filename);
    const ext = path.extname(safe).toLowerCase();
    if (!['.docx', '.xlsx', '.pdf'].includes(ext)) throw new Error('Generated file extension is not allowed');
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Generated document is empty or invalid.');
    if (buffer.length > this.maxFileBytes) throw new Error('Generated document exceeds MAX_DOCUMENT_BYTES.');
    const expectedMimeMap = {
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.pdf': 'application/pdf'
    };
    const expectedMime = expectedMimeMap[ext];
    if (mimeType && mimeType !== expectedMime) throw new Error('Generated document MIME type does not match its extension.');
    if (ext === '.pdf' && buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('Generated PDF does not have a valid %PDF- signature.');
    }
    const id = crypto.randomUUID();
    const folder = path.join(this.storageDir, 'generated');
    await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
    const filePath = path.join(folder, `${id}${ext}`);
    await fsp.writeFile(filePath, buffer, { mode: 0o600, flag: 'wx' });
    return { id, filePath, filename: safe, mimeType: expectedMime, fileSize: buffer.length };
  }

  async deleteWorkspaceDocument({ documentId, scope, ownerId = null, chatId = null, actorId = null }) {
    if (!this.db || typeof this.db.deleteDocument !== 'function') {
      throw new Error('Operasi penghapusan dokumen belum tersedia pada database.');
    }
    const deleted = this.db.deleteDocument(
      documentId,
      scope,
      scope === 'personal' ? ownerId : null,
      scope === 'group' ? chatId : null
    );
    if (!deleted) {
      throw new Error('Dokumen tidak ditemukan pada workspace ini.');
    }

    let fileRemoved = false;
    if (deleted.file_path) {
      const storageRoot = path.resolve(this.storageDir);
      const storedPath = path.resolve(deleted.file_path);
      const relativePath = path.relative(storageRoot, storedPath);
      if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
        await fsp.rm(storedPath, { force: true }).catch(() => {});
        fileRemoved = true;
      }
    }

    this.db.audit?.({
      chatId: chatId || ownerId || null,
      actorId: actorId || ownerId || null,
      action: 'delete_document',
      outcome: 'deleted',
      details: { documentId: deleted.id, filename: deleted.filename, scope, fileRemoved }
    });

    return {
      deleted: true,
      documentId: deleted.id,
      filename: deleted.filename,
      scope,
      fileRemoved
    };
  }
}

module.exports = {
  DocumentService,
  validateExtension,
  normalizeMediaUrl,
  normalizeMimeType,
  isGenericMime,
  validateResponseMime,
  documentExtensionFromMime,
  safeFilename,
  splitDocumentIntoPages,
  readDocumentPages,
  searchDocumentSnippets,
  parseCsvText,
  parseSpreadsheetNumber,
  analyzeSpreadsheetText,
  compareDocumentTexts,
  parseInlineMarkdownTokens,
  extractStructuredDocxText
};
