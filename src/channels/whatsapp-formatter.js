const crypto = require('node:crypto');

function createStash(source) {
  let nonce;
  do {
    nonce = crypto.randomBytes(8).toString('hex');
  } while (source.includes(nonce));
  return { items: [], nonce };
}

function protect(value, stash) {
  const token = `\u0001BUBU_${stash.nonce}_${stash.items.length}\u0002`;
  stash.items.push(value);
  return token;
}

function restore(value, stash) {
  if (!stash.items.length) return value;
  const pattern = new RegExp(`\\u0001BUBU_${stash.nonce}_(\\d+)\\u0002`, 'g');
  let output = value;
  for (let pass = 0; pass <= stash.items.length; pass++) {
    let replaced = false;
    output = output.replace(pattern, (_match, index) => {
      replaced = true;
      return stash.items[Number(index)] ?? '';
    });
    if (!replaced) break;
  }
  return output;
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
    text = text.replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '_$1_');
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
  const stash = createStash(source);
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

function findCodeFenceBlocks(source) {
  const blocks = [];
  let inCode = false;
  let blockStart = -1;
  let openLineEnd = -1;
  let openFence = '```';
  let pos = 0;

  while (pos <= source.length) {
    const nlIndex = source.indexOf('\n', pos);
    const lineEnd = nlIndex === -1 ? source.length : nlIndex;
    const trimmed = source.slice(pos, lineEnd).trim();

    if (!inCode) {
      if (trimmed.startsWith('```') && !trimmed.slice(3).includes('```')) {
        inCode = true;
        blockStart = pos;
        openLineEnd = lineEnd;
        openFence = trimmed;
      }
    } else if (/^```[ \t]*$/.test(trimmed)) {
      blocks.push({
        blockStart,
        openLineEnd,
        closeLineStart: pos,
        closeLineEnd: lineEnd,
        openFence
      });
      inCode = false;
    }

    if (nlIndex === -1) break;
    pos = nlIndex + 1;
  }

  if (inCode) {
    blocks.push({
      blockStart,
      openLineEnd,
      closeLineStart: source.length,
      closeLineEnd: source.length,
      openFence
    });
  }

  return blocks;
}

function isLowSurrogate(codeUnit) {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function isHighSurrogate(codeUnit) {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function splitWhatsAppMessage(text, { maxChars = 3800 } = {}) {
  const source = String(text ?? '');
  const numericMax = Number(maxChars);
  const limit = Number.isFinite(numericMax) && numericMax >= 1 ? Math.floor(numericMax) : 3800;

  if (source.length <= limit) {
    return [source];
  }

  const blocks = findCodeFenceBlocks(source);
  const chunks = [];
  let cursor = 0;
  let activeBlock = null;

  const findBlockContaining = (pos) => blocks.find(
    (block) => block.blockStart <= pos && pos < block.closeLineEnd
  ) || null;

  const evaluateCandidate = (splitEnd, nextCursor) => {
    if (splitEnd <= cursor) return null;
    const prefix = activeBlock
      ? `${activeBlock.openFence.length + 1 + 4 <= limit ? activeBlock.openFence : '```'}\n`
      : '';
    const blockAtEnd = findBlockContaining(splitEnd);

    if (blockAtEnd) {
      if (splitEnd > blockAtEnd.blockStart && splitEnd <= blockAtEnd.openLineEnd + 1) {
        return null;
      }
      if (splitEnd >= blockAtEnd.closeLineStart && splitEnd < blockAtEnd.closeLineEnd) {
        return null;
      }
      if (blockAtEnd.openLineEnd + 1 < splitEnd && splitEnd < blockAtEnd.closeLineStart) {
        if (nextCursor >= blockAtEnd.closeLineStart && blockAtEnd.closeLineStart < source.length) {
          return null;
        }
        const body = source.slice(cursor, splitEnd);
        const minContentStart = activeBlock === blockAtEnd ? cursor : blockAtEnd.openLineEnd + 1;
        if (splitEnd <= minContentStart) return null;
        const closingSuffix = body.endsWith('\n') ? '```' : '\n```';
        const chunkText = `${prefix}${body}${closingSuffix}`;
        if (chunkText.length > limit) return null;
        return { chunkText, nextCursor, nextActiveBlock: blockAtEnd };
      }
    }

    const body = source.slice(cursor, splitEnd);
    const chunkText = `${prefix}${body}`;
    if (chunkText.length > limit) return null;

    let nextActiveBlock = null;
    if (nextCursor < source.length) {
      const blockAtNext = findBlockContaining(nextCursor);
      if (blockAtNext && nextCursor > blockAtNext.openLineEnd && nextCursor < blockAtNext.closeLineStart) {
        nextActiveBlock = blockAtNext;
      }
    }
    return { chunkText, nextCursor, nextActiveBlock };
  };

  while (cursor < source.length) {
    const prefix = activeBlock
      ? `${activeBlock.openFence.length + 1 + 4 <= limit ? activeBlock.openFence : '```'}\n`
      : '';

    if (prefix.length + (source.length - cursor) <= limit) {
      chunks.push(`${prefix}${source.slice(cursor)}`);
      break;
    }

    const avail = Math.max(1, limit - prefix.length);
    const maxRaw = Math.min(source.length, cursor + avail);
    let chosen = null;

    // 1. Prefer paragraph boundaries (\n\n).
    const paraWindow = source.slice(cursor, Math.min(source.length, maxRaw + 2));
    let searchFrom = paraWindow.length;
    while (searchFrom > 0) {
      const idx = paraWindow.lastIndexOf('\n\n', searchFrom - 1);
      if (idx <= 0) break;
      if (idx <= avail) {
        let nextCursor = cursor + idx + 2;
        if (!findBlockContaining(cursor + idx)) {
          while (source[nextCursor] === '\n') nextCursor++;
        }
        chosen = evaluateCandidate(cursor + idx, nextCursor);
        if (chosen) break;
      }
      searchFrom = idx;
    }

    // 2. Fall back to single line boundaries (\n).
    if (!chosen) {
      const lineWindow = source.slice(cursor, Math.min(source.length, maxRaw + 1));
      searchFrom = lineWindow.length;
      while (searchFrom > 0) {
        const idx = lineWindow.lastIndexOf('\n', searchFrom - 1);
        if (idx <= 0) break;
        if (idx <= avail) {
          chosen = evaluateCandidate(cursor + idx, cursor + idx + 1);
          if (chosen) break;
        }
        searchFrom = idx;
      }
    }

    // 3. Fall back to word/space boundaries.
    if (!chosen) {
      const spaceWindow = source.slice(cursor, Math.min(source.length, maxRaw + 1));
      for (let idx = Math.min(avail, spaceWindow.length - 1); idx > 0; idx--) {
        const ch = spaceWindow[idx];
        if (ch === ' ' || ch === '\t') {
          let splitEnd = cursor + idx;
          while (splitEnd > cursor && (source[splitEnd - 1] === ' ' || source[splitEnd - 1] === '\t')) {
            splitEnd--;
          }
          let nextCursor = cursor + idx + 1;
          while (source[nextCursor] === ' ' || source[nextCursor] === '\t') {
            nextCursor++;
          }
          if (splitEnd > cursor) {
            chosen = evaluateCandidate(splitEnd, nextCursor);
            if (chosen) break;
          }
        }
      }
    }

    // 4. Hard character fallback when no clean boundary exists inside maxChars.
    if (!chosen) {
      for (let splitEnd = maxRaw; splitEnd > cursor; splitEnd--) {
        if (splitEnd < source.length &&
            isHighSurrogate(source.charCodeAt(splitEnd - 1)) &&
            isLowSurrogate(source.charCodeAt(splitEnd))) {
          continue;
        }
        chosen = evaluateCandidate(splitEnd, splitEnd);
        if (chosen) break;
      }
    }

    // Guaranteed forward progress even for extreme micro-limits (e.g. maxChars < 8).
    if (!chosen) {
      let splitEnd = Math.min(source.length, cursor + avail);
      if (splitEnd > cursor + 1 &&
          splitEnd < source.length &&
          isHighSurrogate(source.charCodeAt(splitEnd - 1)) &&
          isLowSurrogate(source.charCodeAt(splitEnd))) {
        splitEnd--;
      }
      chosen = {
        chunkText: `${prefix}${source.slice(cursor, splitEnd)}`,
        nextCursor: splitEnd,
        nextActiveBlock: null
      };
    }

    chunks.push(chosen.chunkText);
    cursor = chosen.nextCursor;
    activeBlock = chosen.nextActiveBlock;
  }

  return chunks.length ? chunks : [source];
}

module.exports = { formatWhatsAppText, splitWhatsAppMessage };
