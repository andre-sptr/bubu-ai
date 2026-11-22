const { DOC_TYPE_LABELS, parseInlineMarkdownTokens, stripInlineMarkdown } = require('./markdown-inline');

const UNICODE_TRANSLITERATIONS = new Map([
  ['\u2018', "'"],
  ['\u2019', "'"],
  ['\u201A', ','],
  ['\u201C', '"'],
  ['\u201D', '"'],
  ['\u201E', '"'],
  ['\u2013', '-'],
  ['\u2014', '-'],
  ['\u2015', '-'],
  ['\u2212', '-'],
  ['\u2022', '*'],
  ['\u25CF', '*'],
  ['\u25CB', 'o'],
  ['\u2026', '...'],
  ['\u2713', '[v]'],
  ['\u2714', '[v]'],
  ['\u2705', '[v]'],
  ['\u2717', '[x]'],
  ['\u2718', '[x]'],
  ['\u2715', '[x]'],
  ['\u2716', '[x]'],
  ['\u274C', '[x]'],
  ['\u2192', '->'],
  ['\u2190', '<-'],
  ['\u2194', '<->'],
  ['\u21D2', '=>'],
  ['\u21D0', '<='],
  ['\u2264', '<='],
  ['\u2265', '>='],
  ['\u2260', '!='],
  ['\u2248', '~'],
  ['\u00B1', '+/-'],
  ['\u00D7', 'x'],
  ['\u00F7', '/'],
  ['\u20AC', 'EUR'],
  ['\u00A3', 'GBP'],
  ['\u00A5', 'JPY'],
  ['\u00A9', '(c)'],
  ['\u00AE', '(R)'],
  ['\u2122', '(TM)'],
  ['\u00B0', ' deg']
]);

function escapePdfString(value) {
  let mapped = '';
  for (const ch of String(value ?? '')) {
    if (ch === '\u200B' || ch === '\u200C' || ch === '\u200D' || ch === '\uFE0E' || ch === '\uFE0F') {
      continue;
    }
    const replacement = UNICODE_TRANSLITERATIONS.get(ch);
    if (replacement !== undefined) {
      mapped += replacement;
    } else {
      mapped += ch;
    }
  }
  const safe = mapped
    // Keep WinAnsi / Latin-1 printable range for standard Type1 PDF fonts
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ')
    .replace(/ {2,}/g, ' ');
  return safe
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function splitOversizedToken(token, maxChars) {
  const str = String(token ?? '');
  const limit = Math.max(1, Math.floor(Number(maxChars) || 1));
  if (str.length <= limit) return [str];

  const chunks = [];
  let start = 0;
  const minSplit = Math.max(1, Math.floor(limit * 0.5));
  while (start < str.length) {
    if (str.length - start <= limit) {
      chunks.push(str.slice(start));
      break;
    }
    const slice = str.slice(start, start + limit);
    let splitLen = limit;
    for (let i = slice.length - 1; i >= minSplit; i--) {
      if ('/-_?&=.:'.includes(slice[i])) {
        splitLen = i + 1;
        break;
      }
    }
    chunks.push(str.slice(start, start + splitLen));
    start += splitLen;
  }
  return chunks;
}

function wrapTextToWidth(text, maxChars) {
  const limit = Math.max(1, Math.floor(Number(maxChars) || 1));
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [''];
  if (clean.length <= limit) return [clean];
  const words = clean.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const pieces = word.length > limit ? splitOversizedToken(word, limit) : [word];
    for (const piece of pieces) {
      if (!current) {
        current = piece;
      } else if (current.length + 1 + piece.length <= limit) {
        current += ` ${piece}`;
      } else {
        lines.push(current);
        current = piece;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

function wrapCellLines(text, maxChars, maxLines = 4) {
  const lineLimit = Math.max(1, Math.floor(Number(maxLines) || 4));
  const charLimit = Math.max(1, Math.floor(Number(maxChars) || 1));
  const lines = wrapTextToWidth(text, charLimit);
  if (lines.length <= lineLimit) return lines;
  const kept = lines.slice(0, lineLimit);
  const last = kept[lineLimit - 1];
  if (charLimit <= 3) {
    kept[lineLimit - 1] = '.'.repeat(charLimit);
  } else if (last.length + 3 <= charLimit) {
    kept[lineLimit - 1] = `${last}...`;
  } else {
    kept[lineLimit - 1] = `${last.slice(0, Math.max(1, charLimit - 3)).trimEnd()}...`;
  }
  return kept;
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
  const generatedDate = new Date().toISOString().slice(0, 10);
  addTextLine(`${label}  |  ${generatedDate}`, { font: 'F2', size: 9, color: '0.27 0.45 0.77', leading: 18 });
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

      const maxCellChars = Math.max(6, Math.floor((colWidth - 8) / 5.4));
      const measuredRows = tableRows.map((row) => {
        const wrappedCells = row.map((cell) => wrapCellLines(String(cell ?? ''), maxCellChars, 4));
        const maxCellLines = Math.max(1, ...wrappedCells.map((lines) => lines.length));
        const rowHeight = Math.max(20, maxCellLines * 11 + 8);
        return { wrappedCells, rowHeight };
      });

      const renderTableRow = ({ wrappedCells, rowHeight }, { isHeader = false, isStriped = false } = {}) => {
        const rowTop = cursorY + 11;
        const rowBottom = rowTop - rowHeight;
        if (isHeader) {
          currentOps.push('0.12 0.31 0.47 rg');
          currentOps.push(`${marginX} ${rowBottom.toFixed(2)} ${contentWidth.toFixed(2)} ${rowHeight} re f`);
        } else if (isStriped) {
          currentOps.push('0.96 0.97 0.99 rg');
          currentOps.push(`${marginX} ${rowBottom.toFixed(2)} ${contentWidth.toFixed(2)} ${rowHeight} re f`);
        }
        currentOps.push('0.82 0.86 0.92 RG 0.5 w');
        currentOps.push(`${marginX} ${rowBottom.toFixed(2)} ${contentWidth.toFixed(2)} ${rowHeight} re S`);
        for (let c = 1; c < colCount; c++) {
          const divX = (marginX + c * colWidth).toFixed(2);
          currentOps.push(`${divX} ${rowBottom.toFixed(2)} m ${divX} ${rowTop.toFixed(2)} l S`);
        }

        for (let c = 0; c < colCount; c++) {
          const cellX = marginX + c * colWidth + 5;
          const cellLines = wrappedCells[c] || [''];
          currentOps.push(isHeader ? '1 1 1 rg' : '0.13 0.13 0.13 rg');
          for (let lineIdx = 0; lineIdx < cellLines.length; lineIdx++) {
            const lineY = rowTop - 14 - lineIdx * 11;
            currentOps.push(
              `BT /${isHeader ? 'F2' : 'F1'} 9 Tf ${cellX.toFixed(2)} ${lineY.toFixed(2)} Td (${escapePdfString(cellLines[lineIdx])}) Tj ET`
            );
          }
        }
        cursorY -= rowHeight;
      };

      const headerRow = measuredRows[0];
      const minTableStartSpace = headerRow.rowHeight + (measuredRows[1]?.rowHeight || 0) + 4;
      ensureSpace(minTableStartSpace);
      renderTableRow(headerRow, { isHeader: true });

      for (let r = 1; r < measuredRows.length; r++) {
        const rowData = measuredRows[r];
        if (cursorY - (rowData.rowHeight + 4) < bottomY) {
          startNewPage();
          renderTableRow(headerRow, { isHeader: true });
        }
        renderTableRow(rowData, { isHeader: false, isStriped: r % 2 === 1 });
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

module.exports = {
  escapePdfString,
  splitOversizedToken,
  wrapTextToWidth,
  wrapCellLines,
  buildPdf14Buffer
};
