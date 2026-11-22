const path = require('node:path');
const { splitDocumentIntoPages, searchDocumentSnippets } = require('./page-search');

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

function parseSpreadsheetNumber(value, { preferDotThousands = false } = {}) {
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
  const isIndonesianCurrency = /^(?:rp\.?|idr)\b|\b(?:idr|rp)$/i.test(str);
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
    // Treat single dot + 3 digits as thousands when marked as Rp/IDR, column uses dot-thousands, or trailing .000
    if (
      parts[1].length === 3 &&
      parts[0].length >= 1 &&
      parts[0] !== '0' &&
      (isIndonesianCurrency || preferDotThousands || parts[1] === '000')
    ) {
      normalized = str.replace('.', '');
    }
  }

  const num = Number(normalized);
  if (!Number.isFinite(num)) return null;
  return negative ? -num : num;
}

function detectColumnUsesDotThousands(rows, colIdx) {
  if (!Array.isArray(rows) || colIdx < 0) return false;
  for (const row of rows) {
    const val = String(row?.[colIdx] ?? '').trim();
    if (!val) continue;
    if (/^\(?(?:rp\.?|idr)\b|\b(?:idr|rp)\)?$/i.test(val)) {
      return true;
    }
    if (/^[-+]?\(?(?:rp\.?\s*)?\d{1,3}(?:\.\d{3}){2,}(?:,\d+)?\)?$/i.test(val)) {
      return true;
    }
  }
  return false;
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
  const colUsesDotThousands = headers.map((_, idx) => detectColumnUsesDotThousands(dataRows, idx));

  let filteredDataRows = dataRows;
  if (filterColumn && filterValue !== null && filterValue !== undefined && String(filterValue).trim() !== '') {
    const colIdx = resolveColumnIndex(headers, filterColumn);
    if (colIdx !== -1) {
      const preferDotThousands = colUsesDotThousands[colIdx];
      const needle = String(filterValue).trim().toLowerCase();
      const needleNum = parseSpreadsheetNumber(filterValue, { preferDotThousands });
      filteredDataRows = dataRows.filter((row) => {
        const cell = String(row[colIdx] ?? '').trim();
        if (cell.toLowerCase() === needle || cell.toLowerCase().includes(needle)) return true;
        if (needleNum !== null) {
          const cellNum = parseSpreadsheetNumber(cell, { preferDotThousands });
          if (cellNum !== null && cellNum === needleNum) return true;
        }
        return false;
      });
    }
  }

  const columns = headers.map((headerName, colIdx) => {
    const preferDotThousands = colUsesDotThousands[colIdx];
    const nonEmpty = [];
    const numericValues = [];
    for (const row of filteredDataRows) {
      const val = String(row[colIdx] ?? '').trim();
      if (!val) continue;
      nonEmpty.push(val);
      const parsedNum = parseSpreadsheetNumber(val, { preferDotThousands });
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
    const aggDotThousands = aggIdx !== -1 ? colUsesDotThousands[aggIdx] : false;
    if (groupIdx !== -1) {
      const groups = new Map();
      for (const row of filteredDataRows) {
        const key = String(row[groupIdx] || '(Kosong)').trim() || '(Kosong)';
        if (!groups.has(key)) groups.set(key, { rowCount: 0, values: [] });
        const entry = groups.get(key);
        entry.rowCount++;
        if (aggIdx !== -1) {
          const num = parseSpreadsheetNumber(row[aggIdx], { preferDotThousands: aggDotThousands });
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

module.exports = {
  detectCsvDelimiter,
  parseCsvText,
  parseSpreadsheetNumber,
  detectColumnUsesDotThousands,
  parseSheetsFromExtractedText,
  roundStat,
  computeNumericArrayStats,
  resolveColumnIndex,
  analyzeSpreadsheetText,
  compareDocumentTexts
};
