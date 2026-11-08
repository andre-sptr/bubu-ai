const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ALLOWED = new Map([
  ['.pdf', ['application/pdf']],
  ['.docx', ['application/vnd.openxmlformats-officedocument.wordprocessingml.document']],
  ['.xlsx', ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']],
  ['.xlsm', ['application/vnd.ms-excel.sheet.macroEnabled.12']],
  ['.csv', ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel']],
  ['.txt', ['text/plain']]
]);

function safeFilename(name) {
  const portable = String(name || 'document').replace(/\\/g, '/');
  const base = path.basename(portable).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0,100);
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
  if (mime && !isGenericMime(mime) && !accepted.includes(mime) &&
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
  const accepted = new Set(acceptedMimes || []);

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

class DocumentService {
  constructor({ db, wahaConfig, storageDir, maxFileBytes = 15*1024*1024, maxExtractChars = 50000, httpClient = null }) {
    this.db = db;
    this.wahaConfig = wahaConfig;
    this.storageDir = storageDir;
    this.maxFileBytes = maxFileBytes;
    this.maxExtractChars = maxExtractChars;
    this.httpClient = httpClient;
    fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
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
    if (ext === '.pdf' && buffer.subarray(0,5).toString('ascii') !== '%PDF-') {
      throw new Error('File tidak memiliki signature PDF yang valid.');
    }
    if (['.docx','.xlsx','.xlsm'].includes(ext) &&
        !(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
      throw new Error('File Office tidak memiliki signature ZIP/Office yang valid.');
    }
    if (['.csv', '.txt'].includes(ext) && buffer.includes(0)) {
      throw new Error('Dokumen teks mengandung byte NUL dan ditolak.');
    }

    const id = crypto.randomUUID();
    const folder = path.join(this.storageDir, id.slice(0,2));
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

  async extract({ buffer, ext }) {
    let text = '';
    if (ext === '.pdf') {
      const pdfParse = require('pdf-parse');
      const parsed = await pdfParse(buffer);
      text = parsed.text || '';
    } else if (ext === '.docx') {
      const mammoth = require('mammoth');
      const parsed = await mammoth.extractRawText({ buffer });
      text = parsed.value || '';
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
    } else if (ext === '.csv' || ext === '.txt') {
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
      const record = this.db.saveDocument({
        id: downloaded.id, scope, ownerId: scope === 'personal' ? ownerId : null,
        chatId: scope === 'group' ? chatId : null,
        filename: downloaded.filename, mimeType: downloaded.mimeType,
        filePath: downloaded.filePath, fileSize: downloaded.fileSize,
        extractedText, sourceEventId
      });
      if (record.id !== downloaded.id) await fsp.rm(downloaded.filePath, { force: true }).catch(() => {});
      return { ...record, extractedText: record.extracted_text || extractedText };
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
    const paragraph = (text, options = {}) => new Paragraph({
      spacing: { after: 120, line: 300 },
      ...options,
      children: [new TextRun({ text: String(text), font: 'Aptos', size: 22 })]
    });
    const makeCell = (text, header = false) => new TableCell({
      width: { size: 100, type: WidthType.AUTO },
      shading: header ? { fill: '1F4E78', type: ShadingType.CLEAR } : undefined,
      margins: { top: 100, bottom: 100, left: 120, right: 120 },
      children: [new Paragraph({
        children: [new TextRun({
          text: String(text ?? ''),
          bold: header,
          color: header ? 'FFFFFF' : '222222',
          font: 'Aptos',
          size: 20
        })]
      })]
    });

    children.push(new Paragraph({
      text: title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 180 }
    }));
    if (subtitle) children.push(new Paragraph({
      text: subtitle,
      alignment: AlignmentType.CENTER,
      spacing: { after: 260 }
    }));

    const docTypeLabels = {
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
    const label = docTypeLabels[documentType] || docTypeLabels.general;
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
        children.push(new Paragraph({ text: trimmed.replace(/^###\s+/, ''), heading: HeadingLevel.HEADING_3, spacing: { before: 160, after: 100 } }));
      } else if (/^##\s+/.test(trimmed)) {
        children.push(new Paragraph({ text: trimmed.replace(/^##\s+/, ''), heading: HeadingLevel.HEADING_2, spacing: { before: 220, after: 120 } }));
      } else if (/^#\s+/.test(trimmed)) {
        children.push(new Paragraph({ text: trimmed.replace(/^#\s+/, ''), heading: HeadingLevel.HEADING_1, spacing: { before: 260, after: 140 } }));
      } else if (/^[-*•]\s+/.test(trimmed)) {
        children.push(new Paragraph({
          children: [new TextRun({ text: trimmed.replace(/^[-*•]\s+/, ''), font: 'Aptos', size: 22 })],
          bullet: { indent: 360 },
          spacing: { after: 80 }
        }));
      } else if (/^\d+[.)]\s+/.test(trimmed)) {
        children.push(new Paragraph({
          children: [new TextRun({ text: trimmed.replace(/^\d+[.)]\s+/, ''), font: 'Aptos', size: 22 })],
          numbering: { reference: 'bubu-numbering', level: 0 },
          spacing: { after: 80 }
        }));
      } else if (trimmed.startsWith('> ')) {
        children.push(new Paragraph({
          children: [new TextRun({ text: trimmed.slice(2), italics: true, color: '666666', font: 'Aptos', size: 21 })],
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
      title,
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
    if (!['.docx','.xlsx'].includes(ext)) throw new Error('Generated file extension is not allowed');
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Generated document is empty or invalid.');
    if (buffer.length > this.maxFileBytes) throw new Error('Generated document exceeds MAX_DOCUMENT_BYTES.');
    const expectedMime = ext === '.docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (mimeType && mimeType !== expectedMime) throw new Error('Generated document MIME type does not match its extension.');
    const id = crypto.randomUUID();
    const folder = path.join(this.storageDir, 'generated');
    await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
    const filePath = path.join(folder, `${id}${ext}`);
    await fsp.writeFile(filePath, buffer, { mode: 0o600, flag: 'wx' });
    return { id, filePath, filename: safe, mimeType, fileSize: buffer.length };
  }
}

module.exports = { DocumentService, validateExtension, normalizeMediaUrl, normalizeMimeType, isGenericMime, validateResponseMime, documentExtensionFromMime, safeFilename };
