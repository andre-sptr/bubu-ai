const zlib = require('node:zlib');

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

module.exports = {
  decodeXmlEntities,
  readZipEntryFromBuffer,
  extractParagraphTextFromXml,
  extractStructuredDocxFromXml,
  extractStructuredDocxText
};
