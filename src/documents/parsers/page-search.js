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
  const hasMorePages = candidates.length > 0 && lastReturnedPage < pages.length;
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
        snippet
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
      excerpt
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
        snippet: pageSnippetText
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

module.exports = {
  splitDocumentIntoPages,
  readDocumentPages,
  tokenizeSearchQuery,
  buildSnippetAroundMatch,
  searchDocumentSnippets
};
