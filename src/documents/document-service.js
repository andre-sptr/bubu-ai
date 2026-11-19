const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { runCommand } = require('../utils/process-runner');
const {
  safeFilename,
  sanitizeAxiosError,
  normalizeMediaUrl,
  normalizeMimeType,
  isGenericMime,
  validateResponseMime
} = require('../utils/media-http');
const { extractStructuredDocxText } = require('./parsers/docx-xml-parser');
const {
  splitDocumentIntoPages,
  readDocumentPages,
  searchDocumentSnippets
} = require('./parsers/page-search');
const {
  parseCsvText,
  parseSpreadsheetNumber,
  analyzeSpreadsheetText,
  compareDocumentTexts
} = require('./parsers/spreadsheet-analyzer');
const { parseInlineMarkdownTokens } = require('./generators/markdown-inline');
const { buildPdf14Buffer } = require('./generators/pdf-generator');
const { buildDocxBuffer } = require('./generators/docx-generator');
const { buildXlsxBuffer } = require('./generators/xlsx-generator');

const ALLOWED = new Map([
  ['.pdf', ['application/pdf']],
  ['.docx', ['application/vnd.openxmlformats-officedocument.wordprocessingml.document']],
  ['.xlsx', ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']],
  ['.xlsm', ['application/vnd.ms-excel.sheet.macroEnabled.12', 'application/vnd.ms-excel.sheet.macroenabled.12']],
  ['.csv', ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel']],
  ['.txt', ['text/plain']]
]);

function sanitizeSpreadsheetCellText(value) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/\s*\r?\n+\s*/g, ' ')
    .replace(/\|/g, '│')
    .trim();
}

function normalizeXlsxCellValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : '';
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) {
      return sanitizeSpreadsheetCellText(
        value.richText.map((part) => (part && typeof part.text === 'string' ? part.text : String(part?.text ?? ''))).join('')
      );
    }
    if (value.error !== undefined) {
      const errText = typeof value.error === 'object' && value.error !== null
        ? (value.error.message || JSON.stringify(value.error))
        : String(value.error);
      return sanitizeSpreadsheetCellText(errText);
    }
    if (value.result !== undefined) {
      return normalizeXlsxCellValue(value.result);
    }
    if (value.text !== undefined) {
      return typeof value.text === 'object'
        ? normalizeXlsxCellValue(value.text)
        : sanitizeSpreadsheetCellText(value.text);
    }
    if (value.formula !== undefined || value.sharedFormula !== undefined) {
      return '';
    }
    if (value.hyperlink !== undefined) {
      return sanitizeSpreadsheetCellText(value.hyperlink);
    }
  }
  return sanitizeSpreadsheetCellText(value);
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
  if (mime && !isGenericMime(mime) && !accepted.map((m) => m.toLowerCase()).includes(mime) &&
      !(ext === '.txt' && mime.startsWith('text/')) &&
      !(['.docx', '.xlsx', '.xlsm'].includes(ext) && mime === 'application/zip')) {
    throw new Error(`MIME type tidak sesuai dengan ekstensi ${ext}.`);
  }
  return ext;
}

class DocumentService {
  constructor({
    db,
    wahaConfig,
    storageDir,
    maxFileBytes = 15 * 1024 * 1024,
    maxExtractChars = 50000,
    ocrEnabled = true,
    maxPdfOcrPages = 10,
    pdfRenderDpi = 150,
    pdftoppmBin = 'pdftoppm',
    ghostscriptBin = 'gs',
    tesseractBin = 'tesseract',
    ffmpegBin = 'ffmpeg',
    httpClient = null,
    pdfParser = null,
    mammothLib = null,
    commandRunner = runCommand,
    logger = null
  }) {
    this.db = db;
    this.wahaConfig = wahaConfig;
    this.storageDir = storageDir;
    this.maxFileBytes = maxFileBytes;
    this.maxExtractChars = maxExtractChars;
    this.ocrEnabled = ocrEnabled;
    this.maxPdfOcrPages = maxPdfOcrPages;
    this.pdfRenderDpi = pdfRenderDpi;
    this.pdftoppmBin = pdftoppmBin;
    this.ghostscriptBin = ghostscriptBin;
    this.tesseractBin = tesseractBin;
    this.ffmpegBin = ffmpegBin;
    this.httpClient = httpClient;
    this.pdfParser = pdfParser;
    this.mammothLib = mammothLib;
    this.commandRunner = commandRunner;
    this.logger = logger;
    this.ocrBusy = false;
    try {
      fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES') && String(storageDir).startsWith('/tmp/')) {
        const fallbackDir = path.join(os.tmpdir(), path.basename(storageDir));
        fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
        this.storageDir = fallbackDir;
      } else {
        throw err;
      }
    }
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
    let response;
    try {
      response = await axios.get(url.toString(), {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: this.maxFileBytes,
        maxBodyLength: this.maxFileBytes,
        maxRedirects: 0,
        headers: this.wahaConfig.apiKey ? { 'X-Api-Key': this.wahaConfig.apiKey } : {}
      });
    } catch (error) {
      throw sanitizeAxiosError(error);
    }

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
    if (ext === '.pdf' && buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('File tidak memiliki signature PDF yang valid.');
    }
    if (['.docx', '.xlsx', '.xlsm'].includes(ext) &&
        !(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
      throw new Error('File Office tidak memiliki signature ZIP/Office yang valid.');
    }
    if (['.csv', '.txt'].includes(ext) && buffer.includes(0)) {
      throw new Error('Dokumen teks mengandung byte NUL dan ditolak.');
    }

    const id = crypto.randomUUID();
    const folder = path.join(this.storageDir, id.slice(0, 2));
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

  async parsePdfDigitalPages(buffer) {
    const parser = this.pdfParser || require('pdf-parse');
    const collectedPages = [];
    const options = {
      pagerender: async (pageData) => {
        if (!pageData || typeof pageData.getTextContent !== 'function') return '';
        const textContent = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
        let lastY = null;
        let pageText = '';
        for (const item of textContent.items || []) {
          const y = item.transform ? item.transform[5] : null;
          if (lastY === null || y === lastY) {
            pageText += item.str;
          } else {
            pageText += `\n${item.str}`;
          }
          lastY = y;
        }
        const cleaned = pageText.replace(/\u0000/g, '').trim();
        collectedPages.push(cleaned);
        return cleaned;
      }
    };

    const parsed = await parser(buffer, options);
    const rawText = String(parsed?.text || '').replace(/\u0000/g, '').trim();
    const numPages = Number(parsed?.numpages) || collectedPages.length || (rawText ? 1 : 0);

    if (collectedPages.length > 0) {
      return { pages: collectedPages, totalPages: Math.max(numPages, collectedPages.length), rawText };
    }
    if (rawText.includes('\f')) {
      const splitPages = rawText.split('\f').map((p) => p.trim());
      return { pages: splitPages, totalPages: Math.max(numPages, splitPages.length), rawText };
    }
    if (numPages > 1 && rawText) {
      const pages = splitDocumentIntoPages(rawText, { defaultPageChars: Math.max(1500, Math.ceil(rawText.length / numPages)) })
        .map((p) => p.content);
      return { pages, totalPages: numPages, rawText };
    }
    return { pages: rawText ? [rawText] : [], totalPages: numPages, rawText };
  }

  async renderPdfPagesToImages(pdfPath, workDir, maxPages) {
    const prefix = path.join(workDir, 'page');
    // 1. Try pdftoppm (poppler-utils)
    try {
      await this.commandRunner(this.pdftoppmBin, [
        '-jpeg',
        '-r', String(this.pdfRenderDpi),
        '-f', '1',
        '-l', String(maxPages),
        pdfPath,
        prefix
      ], { timeoutMs: 90000 });
    } catch (err) {
      this.logger?.debug?.({ error: err.message }, 'pdftoppm render failed; trying fallback renderer');
    }

    let files = (await fsp.readdir(workDir))
      .filter((f) => /^page[-_]?\d+\.jpe?g$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    // 2. Fallback to Ghostscript (gs)
    if (!files.length) {
      try {
        await this.commandRunner(this.ghostscriptBin, [
          '-dSAFER', '-dBATCH', '-dNOPAUSE',
          '-sDEVICE=jpeg',
          `-r${this.pdfRenderDpi}`,
          '-dFirstPage=1',
          `-dLastPage=${maxPages}`,
          `-sOutputFile=${path.join(workDir, 'page-%03d.jpg')}`,
          pdfPath
        ], { timeoutMs: 90000 });
        files = (await fsp.readdir(workDir))
          .filter((f) => /^page[-_]?\d+\.jpe?g$/i.test(f))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      } catch (err) {
        this.logger?.debug?.({ error: err.message }, 'Ghostscript render failed; trying FFmpeg fallback');
      }
    }

    // 3. Fallback to FFmpeg
    if (!files.length) {
      try {
        await this.commandRunner(this.ffmpegBin, [
          '-nostdin', '-y', '-i', pdfPath,
          '-vf', 'scale=min(1280\\,iw):-2',
          '-frames:v', String(maxPages),
          path.join(workDir, 'page-%03d.jpg')
        ], { timeoutMs: 90000 });
        files = (await fsp.readdir(workDir))
          .filter((f) => /^page[-_]?\d+\.jpe?g$/i.test(f))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      } catch (err) {
        this.logger?.warn?.({ error: err.message }, 'All PDF page image renderers failed');
      }
    }

    return files.slice(0, maxPages).map((f) => path.join(workDir, f));
  }

  async ocrPdfPages({ buffer, filePath = null, digitalPages = [], totalPages = 0 }) {
    if (this.ocrBusy) {
      throw new Error('Pemrosesan OCR dokumen sedang sibuk. Silakan coba kembali beberapa saat lagi.');
    }
    this.ocrBusy = true;
    let workDir = null;
    try {
      workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bubu-pdf-ocr-'));
      let pdfInputPath = filePath;
      if (!pdfInputPath || !fs.existsSync(pdfInputPath)) {
        pdfInputPath = path.join(workDir, 'input.pdf');
        await fsp.writeFile(pdfInputPath, buffer, { mode: 0o600 });
      }

      const maxPages = this.maxPdfOcrPages;
      const renderedImages = await this.renderPdfPagesToImages(pdfInputPath, workDir, maxPages);
      const count = Math.max(digitalPages.length, renderedImages.length);
      const combinedSections = [];

      for (let idx = 0; idx < count; idx++) {
        const pageNo = idx + 1;
        const digitalText = String(digitalPages[idx] || '').trim();
        if (digitalText.length >= 20) {
          combinedSections.push(`--- [HALAMAN ${pageNo} — TEKS ASLI] ---\n${digitalText}`);
          continue;
        }
        if (idx < renderedImages.length) {
          const imgPath = renderedImages[idx];
          try {
            const ocrResult = await this.commandRunner(this.tesseractBin, [
              imgPath, 'stdout', '-l', 'ind+eng', '--psm', '3'
            ], { timeoutMs: 60000, maxOutput: 500000 });
            const ocrText = String(ocrResult.stdout || '').trim();
            if (ocrText) {
              const merged = digitalText ? `${digitalText}\n${ocrText}` : ocrText;
              combinedSections.push(`--- [HALAMAN ${pageNo} — OCR SCAN] ---\n${merged}`);
              continue;
            }
          } catch (ocrErr) {
            this.logger?.warn?.({ pageNo, error: ocrErr.message }, 'PDF page OCR failed');
          }
        }
        if (digitalText) {
          combinedSections.push(`--- [HALAMAN ${pageNo} — TEKS ASLI] ---\n${digitalText}`);
        }
      }

      const declaredTotal = Math.max(totalPages, count);
      if (declaredTotal > maxPages && renderedImages.length > 0) {
        combinedSections.push(
          `[CATATAN OCR: Dokumen memiliki ${declaredTotal} halaman; pemindaian OCR dibatasi pada ${maxPages} halaman pertama untuk menjaga stabilitas resource server.]`
        );
      }
      return combinedSections.join('\n\n').trim();
    } finally {
      if (workDir) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
      this.ocrBusy = false;
    }
  }

  async extract({ buffer, ext, filePath = null }) {
    let text = '';
    if (ext === '.pdf') {
      let digital = { pages: [], totalPages: 0, rawText: '' };
      try {
        digital = await this.parsePdfDigitalPages(buffer);
      } catch (parseErr) {
        if (!this.ocrEnabled) throw parseErr;
        this.logger?.warn?.({ error: parseErr.message }, 'Digital PDF parsing failed; attempting OCR fallback');
      }

      const nonEmptyDigitalPages = digital.pages.filter((p) => String(p || '').trim().length >= 20);
      const needsOcr = this.ocrEnabled && (
        nonEmptyDigitalPages.length === 0 ||
        (digital.pages.slice(0, this.maxPdfOcrPages).some((p) => String(p || '').trim().length < 20))
      );

      if (needsOcr) {
        text = await this.ocrPdfPages({
          buffer,
          filePath,
          digitalPages: digital.pages,
          totalPages: digital.totalPages
        });
      }

      if (!text && digital.pages.length > 0) {
        if (digital.pages.length === 1) {
          text = `--- [HALAMAN 1] ---\n${digital.pages[0]}`;
        } else {
          text = digital.pages
            .map((p, idx) => `--- [HALAMAN ${idx + 1}] ---\n${p}`)
            .join('\n\n');
        }
      } else if (!text && digital.rawText) {
        text = digital.rawText;
      }
    } else if (ext === '.docx') {
      text = await extractStructuredDocxText(buffer, this.mammothLib);
    } else if (ext === '.xlsx' || ext === '.xlsm') {
      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const sections = [];
      workbook.eachSheet((sheet) => {
        sections.push(`SHEET: ${sheet.name}`);
        sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
          const cells = Array.from(row.values.slice(1), (v) => normalizeXlsxCellValue(v));
          sections.push(`${rowNumber}: ${cells.join(' | ')}`);
        });
      });
      text = sections.join('\n');
    } else if (ext === '.csv') {
      const rawCsv = buffer.toString('utf8').replace(/\u0000/g, '').trim();
      const parsedCsv = parseCsvText(rawCsv);
      if (parsedCsv.rows.length > 0) {
        text = [
          'SHEET: CSV',
          ...parsedCsv.rows.map((row, idx) => `${idx + 1}: ${row.map(sanitizeSpreadsheetCellText).join(' | ')}`)
        ].join('\n');
      } else {
        text = rawCsv;
      }
    } else if (ext === '.txt') {
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
      const pages = splitDocumentIntoPages(extractedText);
      const hasOcrPages = pages.some((p) => p.isOcr);
      const record = this.db.saveDocument({
        id: downloaded.id, scope, ownerId: scope === 'personal' ? ownerId : null,
        chatId: scope === 'group' ? chatId : null,
        filename: downloaded.filename, mimeType: downloaded.mimeType,
        filePath: downloaded.filePath, fileSize: downloaded.fileSize,
        extractedText, sourceEventId
      });
      if (record.id !== downloaded.id) await fsp.rm(downloaded.filePath, { force: true }).catch(() => {});
      return {
        ...record,
        extractedText: record.extracted_text || extractedText,
        pageCount: pages.length,
        hasOcrPages,
        extractionMode: hasOcrPages ? 'ocr_or_hybrid' : 'text'
      };
    } catch (error) {
      await fsp.rm(downloaded.filePath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async createDocx(options) {
    return buildDocxBuffer(options);
  }

  async createPdf({ title, content, documentType = 'general', subtitle = '', author = 'Bubu AI' }) {
    return buildPdf14Buffer({ title, content, documentType, subtitle, author });
  }

  async createXlsx(options) {
    return buildXlsxBuffer(options);
  }

  async persistGenerated({ buffer, filename, mimeType }) {
    const safe = safeFilename(filename);
    const ext = path.extname(safe).toLowerCase();
    if (!['.docx', '.xlsx', '.pdf'].includes(ext)) throw new Error('Generated file extension is not allowed');
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Generated document is empty or invalid.');
    if (buffer.length > this.maxFileBytes) throw new Error('Generated document exceeds MAX_DOCUMENT_BYTES.');
    const expectedMimeMap = {
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.pdf': 'application/pdf'
    };
    const expectedMime = expectedMimeMap[ext];
    if (mimeType && mimeType !== expectedMime) throw new Error('Generated document MIME type does not match its extension.');
    if (ext === '.pdf' && buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('Generated PDF does not have a valid %PDF- signature.');
    }
    const id = crypto.randomUUID();
    const folder = path.join(this.storageDir, 'generated');
    await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
    const filePath = path.join(folder, `${id}${ext}`);
    await fsp.writeFile(filePath, buffer, { mode: 0o600, flag: 'wx' });
    return { id, filePath, filename: safe, mimeType: expectedMime, fileSize: buffer.length };
  }

  async deleteWorkspaceDocument({ documentId, scope, ownerId = null, chatId = null, actorId = null }) {
    if (!this.db || typeof this.db.deleteDocument !== 'function') {
      throw new Error('Operasi penghapusan dokumen belum tersedia pada database.');
    }
    const deleted = this.db.deleteDocument(
      documentId,
      scope,
      scope === 'personal' ? ownerId : null,
      scope === 'group' ? chatId : null
    );
    if (!deleted) {
      throw new Error('Dokumen tidak ditemukan pada workspace ini.');
    }

    let fileRemoved = false;
    if (deleted.file_path) {
      const storageRoot = path.resolve(this.storageDir);
      const storedPath = path.resolve(deleted.file_path);
      const relativePath = path.relative(storageRoot, storedPath);
      if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
        try {
          await fsp.rm(storedPath, { force: true });
          fileRemoved = true;
        } catch (err) {
          this.logger?.warn?.({ documentId: deleted.id, error: err.message }, 'Failed to remove stored document file');
        }
      }
    }

    this.db.audit?.({
      chatId: chatId || ownerId || null,
      actorId: actorId || ownerId || null,
      action: 'delete_document',
      outcome: 'deleted',
      details: { documentId: deleted.id, filename: deleted.filename, scope, fileRemoved }
    });

    return {
      deleted: true,
      documentId: deleted.id,
      filename: deleted.filename,
      scope,
      fileRemoved
    };
  }
}

module.exports = {
  DocumentService,
  sanitizeSpreadsheetCellText,
  normalizeXlsxCellValue,
  validateExtension,
  normalizeMediaUrl,
  normalizeMimeType,
  isGenericMime,
  validateResponseMime,
  documentExtensionFromMime,
  safeFilename,
  splitDocumentIntoPages,
  readDocumentPages,
  searchDocumentSnippets,
  parseCsvText,
  parseSpreadsheetNumber,
  analyzeSpreadsheetText,
  compareDocumentTexts,
  parseInlineMarkdownTokens,
  extractStructuredDocxText
};
