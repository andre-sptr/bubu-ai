const PLACEHOLDER_START = '\u0001BUBU_MD_';
const PLACEHOLDER_END = '\u0002';

function protect(value, stash) {
  const token = `${PLACEHOLDER_START}${stash.length}${PLACEHOLDER_END}`;
  stash.push(value);
  return token;
}

function restore(value, stash) {
  return value.replace(/\u0001BUBU_MD_(\d+)\u0002/g, (_match, index) => stash[Number(index)] ?? '');
}

function formatInline(input, stash) {
  let text = String(input ?? '');

  // Preserve inline code before processing emphasis or links.
  text = text.replace(/`([^`\n]+)`/g, (_m, code) =>
    protect(`\`${code}\``, stash));

  // Convert Markdown links to readable WhatsApp text with the real URL.
  text = text.replace(/!?\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+["'][^)]*["'])?\)/g,
    (_m, label, url) => label
      ? `${label}: ${url}`
      : url);

  // Remove common HTML wrappers while retaining their text.
  text = text.replace(/<\/?(?:strong|b)>/gi, '**')
    .replace(/<\/?(?:em|i)>/gi, '_')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div)>/gi, '\n');

  // Markdown bold -> WhatsApp bold.
  // Protect bold spans while converting Markdown single-asterisk italics.
  text = text.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, (_m, value) =>
    protect(`*${value}*`, stash));
  text = text.replace(/__(?=\S)([\s\S]*?\S)__/g, (_m, value) =>
    protect(`*${value}*`, stash));

  // A single-star span on its own line is commonly already WhatsApp bold
  // (e.g. approval prompts). Preserve it; convert inline Markdown italics.
  const standaloneWhatsAppBold = /^\s*\*[^*\n]+\*\s*$/.test(text);
  if (!standaloneWhatsAppBold) {
    text = text.replace(/(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)/g, '_$1_');
  }

  // Markdown strikethrough -> WhatsApp strikethrough.
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '~$1~');

  text = text.replace(/\\\*/g, '*').replace(/\\_/g, '_');

  return restore(text, stash);
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function isTableSeparator(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('|') &&
    /^\|?[\s:|-]+\|?$/.test(trimmed) &&
    trimmed.includes('-');
}

function formatTable(lines, start, stash) {
  const headers = splitTableRow(lines[start]);
  let index = start + 2;
  const output = ['*' + headers.map((cell) => formatInline(cell, stash)).join(' • ') + '*'];
  let rowNumber = 0;

  while (index < lines.length && lines[index].trim().startsWith('|')) {
    const cells = splitTableRow(lines[index]);
    const fields = headers.map((header, column) => {
      const value = cells[column] ?? '';
      if (!value) return null;
      return `*${formatInline(header, stash)}:* ${formatInline(value, stash)}`;
    }).filter(Boolean);
    rowNumber++;
    output.push(`${rowNumber}. ${fields.join('\n')}`);
    index++;
  }

  return { output, nextIndex: index };
}

function formatWhatsAppText(input) {
  if (input === null || input === undefined) return '';
  const source = String(input).replace(/\r\n?/g, '\n');
  const stash = [];
  const fenced = source.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_m, language, code) => {
    const body = String(code || '').replace(/^\n/, '').replace(/\n+$/, '');
    return protect(`\`\`\`\n${body}\n\`\`\``, stash);
  });

  const lines = fenced.split('\n');
  const output = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      if (output.length && output[output.length - 1] !== '') output.push('');
      index++;
      continue;
    }

    // Markdown table: header followed by separator row.
    if (trimmed.startsWith('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const table = formatTable(lines, index, stash);
      output.push(...table.output);
      index = table.nextIndex;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      output.push('━━━━━━━━━━━━');
    } else if (/^#{1,6}\s+/.test(trimmed)) {
      const heading = trimmed.replace(/^#{1,6}\s+/, '');
      output.push(`*${formatInline(heading, stash).replace(/^\*|\*$/g, '')}*`);
    } else if (/^>\s?/.test(trimmed)) {
      output.push(`> ${formatInline(trimmed.replace(/^>\s?/, ''), stash)}`);
    } else if (/^[-+*]\s+/.test(trimmed)) {
      const indent = line.match(/^\s*/)?.[0] || '';
      output.push(`${indent}• ${formatInline(trimmed.replace(/^[-+*]\s+/, ''), stash)}`);
    } else if (/^\d+[.)]\s+/.test(trimmed)) {
      output.push(formatInline(trimmed.replace(/^(\d+)[.)]\s+/, '$1. '), stash));
    } else {
      output.push(formatInline(line, stash));
    }
    index++;
  }

  let result = restore(output.join('\n'), stash);
  result = result.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return result;
}

module.exports = { formatWhatsAppText };
