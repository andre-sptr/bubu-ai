const { DOC_TYPE_LABELS, parseInlineMarkdownTokens, stripInlineMarkdown } = require('./markdown-inline');

async function buildDocxBuffer({ title, content, documentType = 'general', subtitle = '', author = 'Bubu AI' }) {
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
  if (subtitle) {
    children.push(new Paragraph({
      text: stripInlineMarkdown(subtitle),
      alignment: AlignmentType.CENTER,
      spacing: { after: 260 }
    }));
  }

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
        default: new Header({
          children: [new Paragraph({
            children: [new TextRun({ text: 'BUBU AI  |  ' + label, color: '777777', size: 16 })],
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D9E2F3' } }
          })]
        })
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              new TextRun({ text: 'Dibuat dengan Bubu AI  •  Halaman ', color: '888888', size: 16 }),
              new TextRun({ children: [PageNumber.CURRENT], color: '888888', size: 16 })
            ]
          })]
        })
      },
      children
    }]
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildDocxBuffer };
