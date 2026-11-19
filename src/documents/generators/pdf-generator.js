const { DOC_TYPE_LABELS, parseInlineMarkdownTokens, stripInlineMarkdown } = require('./markdown-inline');

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
  wrapTextToWidth,
  buildPdf14Buffer
};
