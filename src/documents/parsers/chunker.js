const { splitDocumentIntoPages } = require('./page-search');

function splitPageContentIntoChunks(pageText, { chunkChars = 1200, overlapChars = 180, maxRemaining = 60 } = {}) {
  const clean = String(pageText || '').replace(/\u0000/g, '').trim();
  if (!clean || maxRemaining <= 0) return [];
  const limit = Math.max(200, Number(chunkChars) || 1200);
  const overlap = Math.min(Math.floor(limit / 2), Math.max(0, Number(overlapChars) || 0));

  if (clean.length <= limit) return [clean];

  const chunks = [];
  let start = 0;
  while (start < clean.length && chunks.length < maxRemaining) {
    let end = Math.min(clean.length, start + limit);
    if (end < clean.length) {
      const minSplit = start + Math.floor(limit * 0.55);
      const paraBreak = clean.lastIndexOf('\n\n', end);
      const lineBreak = clean.lastIndexOf('\n', end);
      const sentenceBreak = Math.max(
        clean.lastIndexOf('. ', end),
        clean.lastIndexOf('? ', end),
        clean.lastIndexOf('! ', end)
      );
      const wordBreak = clean.lastIndexOf(' ', end);

      if (paraBreak >= minSplit) {
        end = paraBreak;
      } else if (lineBreak >= minSplit) {
        end = lineBreak;
      } else if (sentenceBreak >= minSplit) {
        end = sentenceBreak + 1;
      } else if (wordBreak >= minSplit) {
        end = wordBreak;
      }
    }

    const slice = clean.slice(start, end).trim();
    if (slice) chunks.push(slice);
    if (end >= clean.length) break;

    const nextStart = Math.max(start + 1, end - overlap);
    start = nextStart;
  }
  return chunks;
}

function chunkDocumentText(extractedText, { chunkChars = 1200, overlapChars = 180, maxChunks = 60 } = {}) {
  const text = String(extractedText || '').replace(/\u0000/g, '').trim();
  if (!text) return [];
  const cap = Math.max(1, Math.min(200, Number(maxChunks) || 60));
  const pages = splitDocumentIntoPages(text);
  const out = [];
  let chunkIndex = 0;

  for (const page of pages) {
    if (out.length >= cap) break;
    const pieces = splitPageContentIntoChunks(page.content, {
      chunkChars,
      overlapChars,
      maxRemaining: cap - out.length
    });
    for (const piece of pieces) {
      if (out.length >= cap) break;
      out.push({
        chunkIndex: chunkIndex++,
        pageNumber: page.pageNumber || 1,
        content: piece
      });
    }
  }
  return out;
}

module.exports = { chunkDocumentText };
