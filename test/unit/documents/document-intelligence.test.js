const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { loadConfig } = require('../../../src/config/env');
const {
  DocumentService,
  splitDocumentIntoPages,
  readDocumentPages,
  searchDocumentSnippets,
  extractStructuredDocxText,
  parseCsvText,
  parseSpreadsheetNumber,
  analyzeSpreadsheetText,
  compareDocumentTexts,
  parseInlineMarkdownTokens,
} = require('../../../src/documents/document-service');
const { createDocumentTools } = require('../../../src/documents/document-tools');
const { AgentRuntime } = require('../../../src/agent/runtime');
const { MessageProcessor } = require('../../../src/agent/message-processor');

function buildMinimalZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const uncompressed = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(String(entry.data), 'utf8');
    const compressed = zlib.deflateRawSync(uncompressed);

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14); // crc32 (ignored by extractor)
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    localParts.push(localHeader, compressed);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

test('Task 3.1: env.js provides Phase 3 document OCR defaults and database.js has no duplicate methods', () => {
  const cfg = loadConfig({
    WAHA_BASE_URL: 'http://127.0.0.1:3000',
    WAHA_SESSION: 'default',
    WAHA_API_KEY: 'k',
    WAHA_WEBHOOK_SECRET: '1234567890abcdef',
    SUMOPOD_API_KEY: 's',
    OWNER_JID: '6281234567890@c.us',
  });
  assert.equal(cfg.documents.ocrEnabled, true);
  assert.equal(cfg.documents.maxPdfOcrPages, 10);
  assert.equal(cfg.documents.pdfRenderDpi, 150);
  assert.equal(cfg.documents.pdftoppmBin, 'pdftoppm');
  assert.equal(cfg.documents.ghostscriptBin, 'gs');

  const collectJsFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectJsFiles(full);
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
  const dbSource = collectJsFiles(path.join(__dirname, '../../../src/db'))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  const saveDocMatches = dbSource.match(/^\s{2}saveDocument\s*\(/gm) || [];
  const searchDocMatches = dbSource.match(/^\s{2}searchDocuments\s*\(/gm) || [];
  const deleteDocMatches = dbSource.match(/^\s{2}deleteDocument\s*\(/gm) || [];
  assert.equal(saveDocMatches.length, 1, 'saveDocument should be defined exactly once');
  assert.equal(searchDocMatches.length, 1, 'searchDocuments should be defined exactly once');
  assert.equal(deleteDocMatches.length, 1, 'deleteDocument should be defined on DatabaseStore');
});

test('Task 3.2: Scanned and hybrid PDF extraction labels pages and cleans up temporary OCR files', async (t) => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-p3-pdf-'));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));

  const ocrCalledImages = [];
  let renderedTempDir = null;

  const service = new DocumentService({
    db: {},
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir,
    maxFileBytes: 15 * 1024 * 1024,
    maxExtractChars: 30000,
    ocrEnabled: true,
    maxPdfOcrPages: 2,
    pdfRenderDpi: 150,
    commandRunner: async (bin, args) => {
      if (bin === 'tesseract') {
        ocrCalledImages.push(path.basename(args[0]));
        return { stdout: 'Klausul 7: Pembayaran termin kedua sebesar Rp 75.000.000.', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  });

  // Case 1: Hybrid 3-page PDF (page 1 has digital text >= 20 chars, page 2 is scanned/empty, page 3 exceeds maxPdfOcrPages=2)
  service.parsePdfDigitalPages = async () => ({
    totalPages: 3,
    rawText: 'Halaman pertama memiliki teks digital asli yang cukup panjang untuk lulus ambang batas.\f\f',
    pages: [
      'Halaman pertama memiliki teks digital asli yang cukup panjang untuk lulus ambang batas.',
      '',
      '',
    ],
  });
  service.renderPdfPagesToImages = async (_pdfPath, workDir) => {
    renderedTempDir = workDir;
    const p1 = path.join(workDir, 'page-001.jpg');
    const p2 = path.join(workDir, 'page-002.jpg');
    fs.writeFileSync(p1, 'fake-jpg-1');
    fs.writeFileSync(p2, 'fake-jpg-2');
    return [p1, p2];
  };

  const extractedText = await service.extract({
    buffer: Buffer.from('%PDF-1.4 fake'),
    ext: '.pdf',
  });
  assert.deepEqual(ocrCalledImages, ['page-002.jpg'], 'Only sparse/scanned page 2 should run Tesseract OCR');
  assert.match(extractedText, /--- \[HALAMAN 1 — TEKS ASLI\] ---/);
  assert.match(extractedText, /--- \[HALAMAN 2 — OCR SCAN\] ---/);
  assert.match(extractedText, /Klausul 7: Pembayaran termin kedua/);
  assert.match(extractedText, /Dokumen memiliki 3 halaman; pemindaian OCR dibatasi pada 2 halaman pertama/);
  assert.ok(renderedTempDir && !fs.existsSync(renderedTempDir), 'Temporary PDF render directory must be cleaned up');

  // Case 2: Single-concurrency guard when ocrBusy is already true
  service.ocrBusy = true;
  await assert.rejects(
    () => service.ocrPdfPages({ buffer: Buffer.from('%PDF-1.4 scanned'), digitalPages: [''], totalPages: 1 }),
    /sedang sibuk/
  );
  service.ocrBusy = false;
});

test('Task 3.3: Structured DOCX XML extraction preserves headings, lists, and pipe tables', async () => {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p>
          <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
          <w:r><w:t>Perjanjian Kerja Sama</w:t></w:r>
        </w:p>
        <w:p>
          <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
          <w:r><w:t>Ruang Lingkup</w:t></w:r>
        </w:p>
        <w:p>
          <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
          <w:r><w:t>Pengembangan modul analitik dokumen</w:t></w:r>
        </w:p>
        <w:tbl>
          <w:tr>
            <w:tc><w:p><w:r><w:t>Termin</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>Persentase</w:t></w:r></w:p></w:tc>
          </w:tr>
          <w:tr>
            <w:tc><w:p><w:r><w:t>Termin 1</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>40%</w:t></w:r></w:p></w:tc>
          </w:tr>
        </w:tbl>
      </w:body>
    </w:document>`;

  const docxBuffer = buildMinimalZipBuffer([
    { name: 'word/document.xml', data: documentXml },
  ]);
  const extracted = await extractStructuredDocxText(docxBuffer);
  assert.match(extracted, /# Perjanjian Kerja Sama/);
  assert.match(extracted, /## Ruang Lingkup/);
  assert.match(extracted, /- Pengembangan modul analitik dokumen/);
  assert.match(extracted, /\| Termin \| Persentase \|/);
  assert.match(extracted, /\| Termin 1 \| 40% \|/);
});

test('Task 3.3: Contextual snippet search and paginated read_document locate content on later pages', async () => {
  const multiPageText = [
    '--- [HALAMAN 1 — TEKS ASLI] ---\nPendahuluan dokumen kontrak pengadaan perangkat lunak tahun 2026.\n' + 'A'.repeat(2200),
    '--- [HALAMAN 2 — TEKS ASLI] ---\nDefinisi operasional dan ruang lingkup pekerjaan tahap awal.\n' + 'B'.repeat(2200),
    '--- [HALAMAN 3 — TEKS ASLI] ---\nJadwal serah terima dan kriteria pengujian sistem.\n' + 'C'.repeat(2200),
    '--- [HALAMAN 4 — OCR SCAN] ---\nPasal 14 Denda Keterlambatan: Pihak Kedua dikenakan penalti 0,2% per hari kalender hingga maksimal 5% dari nilai kontrak.',
  ].join('\n\n');

  const pages = splitDocumentIntoPages(multiPageText);
  assert.equal(pages.length, 4);

  const page4 = readDocumentPages(multiPageText, { page: 4 });
  assert.equal(page4.totalPages, 4);
  assert.deepEqual(page4.returnedPages, [4]);
  assert.match(page4.text, /Pasal 14 Denda Keterlambatan/);
  assert.doesNotMatch(page4.text, /Pendahuluan dokumen/);

  const snippetRes = searchDocumentSnippets(multiPageText, 'penalti keterlambatan maksimal', {
    maxSnippets: 2,
    snippetChars: 300,
  });
  assert.ok(snippetRes.snippets.length >= 1);
  assert.equal(snippetRes.snippets[0].pageNumber, 4);
  assert.match(snippetRes.snippets[0].snippet, /Pasal 14 Denda Keterlambatan/);
  assert.match(snippetRes.excerpt, /HALAMAN 4 — OCR SCAN/);
});

test('Task 3.4: CSV parser and deterministic spreadsheet analytics compute accurate sums, filters, and group-by', () => {
  const csvContent = '\uFEFF"Cabang";"Kategori";"Deskripsi";"Nominal"\r\n' +
    '"Jakarta";"Software";"Lisensi Server\r\nTahun 2026";"Rp 1.250.000,50"\r\n' +
    '"Bandung";"Hardware";"Switch Core";"Rp 750.000,00"\r\n' +
    '"Jakarta";"Hardware";"Router Edge";"Rp 500.000,50"\r\n';

  const parsedCsv = parseCsvText(csvContent);
  assert.equal(parsedCsv.delimiter, ';');
  assert.equal(parsedCsv.rows.length, 4);
  assert.equal(parsedCsv.rows[1][2], 'Lisensi Server\nTahun 2026');
  assert.equal(parseSpreadsheetNumber('Rp 1.250.000,50'), 1250000.5);
  assert.equal(parseSpreadsheetNumber('$1,250,000.50'), 1250000.5);
  assert.equal(parseSpreadsheetNumber('2026-11-08'), null);

  const analysis = analyzeSpreadsheetText(csvContent, {
    filename: 'realisasi-anggaran.csv',
    filterColumn: 'Cabang',
    filterValue: 'Jakarta',
    groupByColumn: 'Cabang',
    aggregateColumn: 'Nominal',
  });

  assert.equal(analysis.totalRows, 3);
  assert.equal(analysis.filteredRows, 2);
  const nominalCol = analysis.columns.find((c) => c.name === 'Nominal');
  assert.equal(nominalCol.inferredType, 'numeric');
  assert.equal(nominalCol.numericStats.count, 2);
  assert.equal(nominalCol.numericStats.sum, 1750001);
  assert.equal(nominalCol.numericStats.min, 500000.5);
  assert.equal(nominalCol.numericStats.max, 1250000.5);

  assert.ok(Array.isArray(analysis.groupSummary));
  const jakartaGroup = analysis.groupSummary.find((g) => g.group === 'Jakarta');
  assert.equal(jakartaGroup.rowCount, 2);
  assert.equal(jakartaGroup.stats.sum, 1750001);
});

test('Task 3.5 & 3.6 & 3.7: P1 document tools support pagination, compare_documents, PDF generation, and delete_document', async (t) => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-p3-tools-'));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));

  const docs = new Map();
  const auditLogs = [];
  const sendCalls = [];
  const approvalCalls = [];

  const db = {
    saveDocument: (doc) => {
      const record = {
        id: doc.id,
        scope: doc.scope,
        owner_id: doc.ownerId || null,
        chat_id: doc.chatId || null,
        filename: doc.filename,
        mime_type: doc.mimeType,
        file_path: doc.filePath,
        file_size: doc.fileSize,
        extracted_text: doc.extractedText,
        created_at: new Date().toISOString(),
      };
      docs.set(doc.id, record);
      return record;
    },
    getDocument: (id, scope, ownerId, chatId) => {
      const d = docs.get(id);
      if (!d || d.scope !== scope) return null;
      if (scope === 'personal' && d.owner_id !== ownerId) return null;
      if (scope === 'group' && d.chat_id !== chatId) return null;
      return d;
    },
    getDocumentFile: (id, scope, ownerId, chatId) => {
      return db.getDocument(id, scope, ownerId, chatId);
    },
    deleteDocument: (id, scope, ownerId, chatId) => {
      const d = db.getDocument(id, scope, ownerId, chatId);
      if (!d) return null;
      docs.delete(id);
      return d;
    },
    searchDocuments: ({ scope, ownerId, chatId, query }) => {
      const out = [];
      for (const d of docs.values()) {
        if (d.scope !== scope) continue;
        if (scope === 'personal' && d.owner_id !== ownerId) continue;
        if (scope === 'group' && d.chat_id !== chatId) continue;
        const snip = searchDocumentSnippets(d.extracted_text, query);
        if (snip.snippets.length > 0) {
          out.push({
            id: d.id,
            filename: d.filename,
            mime_type: d.mime_type,
            snippets: snip.snippets,
            matchedPages: snip.snippets.map((s) => s.pageNumber),
            totalPages: snip.totalPages,
            excerpt: snip.excerpt,
          });
        }
      }
      return out;
    },
    audit: (entry) => auditLogs.push(entry),
  };

  const documentService = new DocumentService({
    db,
    waha: {},
    storageDir,
    maxFileBytes: 15 * 1024 * 1024,
    maxExtractChars: 30000,
  });

  const waha = {
    sendFile: async (filePath, chatId, options) => {
      sendCalls.push({ filePath, chatId, options });
      return { id: `waha-msg-${sendCalls.length}` };
    },
  };
  const approvalManager = {
    create: async (args) => {
      approvalCalls.push(args);
      return { pendingApproval: true, approvalId: 'app-pdf-1' };
    },
  };

  const tools = createDocumentTools({
    db,
    documentService,
    webSearch: null,
    webFetch: {},
    approvalManager,
    waha,
  });

  // 1. Inline Markdown tokenizer check
  const inlineTokens = parseInlineMarkdownTokens('Nilai **Rp 10.000.000** dengan *diskon* dan kode `INV-01` serta ***penting***.');
  assert.ok(inlineTokens.some((tok) => tok.text === 'Rp 10.000.000' && tok.bold));
  assert.ok(inlineTokens.some((tok) => tok.text === 'diskon' && tok.italics));
  assert.ok(inlineTokens.some((tok) => tok.text === 'INV-01' && tok.code));
  assert.ok(inlineTokens.some((tok) => tok.text === 'penting' && tok.bold && tok.italics));

  // 2. Native PDF generation and group auto-send via create_pdf
  const createPdfTool = tools.find((item) => item.name === 'create_pdf');
  const groupCtx = {
    taskId: 'task-pdf-group',
    chatId: '120363009999999999@g.us',
    requesterId: '628111@c.us',
    scope: 'group',
  };
  const pdfResult = await createPdfTool.execute({
    title: 'Ringkasan Eksekutif Q3',
    documentType: 'executive_summary',
    subtitle: 'Laporan Kuartal III 2026',
    content: '# Ringkasan Utama\nPendapatan tumbuh **18%** YoY.\n\n| Kuartal | Pendapatan |\n| --- | --- |\n| Q2 | 100 |\n| Q3 | 118 |',
    filename: 'ringkasan-q3.pdf',
  }, groupCtx);

  assert.equal(pdfResult.created, true);
  assert.equal(pdfResult.deliveryStatus, 'sent');
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].chatId, '120363009999999999@g.us');
  assert.equal(sendCalls[0].options.mimetype, 'application/pdf');
  const savedPdfBuffer = fs.readFileSync(sendCalls[0].filePath);
  assert.equal(savedPdfBuffer.subarray(0, 5).toString('ascii'), '%PDF-');

  // 3. Personal DM PDF generation requires owner approval
  const personalCtx = {
    taskId: 'task-pdf-personal',
    chatId: '6281234567890@c.us',
    requesterId: '6281234567890@c.us',
    scope: 'personal',
  };
  const personalPdfRes = await createPdfTool.execute({
    title: 'Invoice Layanan',
    documentType: 'invoice',
    content: '# Tagihan\nTotal: **Rp 5.000.000**',
  }, personalCtx);
  assert.equal(personalPdfRes.pendingApproval, true);
  assert.equal(approvalCalls.length, 1);
  assert.equal(approvalCalls[0].args.mimetype, 'application/pdf');

  // 4. Compare two documents in the same workspace
  db.saveDocument({
    id: '11111111-1111-4111-8111-111111111111',
    scope: 'group',
    chatId: groupCtx.chatId,
    filename: 'kontrak-v1.csv',
    mimeType: 'text/csv',
    filePath: path.join(storageDir, 'v1.csv'),
    fileSize: 100,
    extractedText: 'Item,Biaya\nServer,1000000\nLisensi,500000',
  });
  db.saveDocument({
    id: '22222222-2222-4222-8222-222222222222',
    scope: 'group',
    chatId: groupCtx.chatId,
    filename: 'kontrak-v2.csv',
    mimeType: 'text/csv',
    filePath: path.join(storageDir, 'v2.csv'),
    fileSize: 100,
    extractedText: 'Item,Biaya\nServer,1250000\nLisensi,500000\nBackup,250000',
  });

  const compareTool = tools.find((item) => item.name === 'compare_documents');
  const diffResult = await compareTool.execute({
    firstDocumentId: '11111111-1111-4111-8111-111111111111',
    secondDocumentId: '22222222-2222-4222-8222-222222222222',
  }, groupCtx);

  assert.equal(diffResult.summary.addedOrOnlyInSecondCount, 2);
  assert.ok(diffResult.onlyInSecond.some((line) => line.includes('Backup,250000')));
  assert.ok(diffResult.spreadsheetDelta);
  const biayaDelta = diffResult.spreadsheetDelta.columnDeltas.find((c) => c.column === 'Biaya');
  assert.equal(biayaDelta.sumDiff, 500000);

  // Cross-workspace compare must fail
  await assert.rejects(
    () => compareTool.execute({
      firstDocumentId: '11111111-1111-4111-8111-111111111111',
      secondDocumentId: '22222222-2222-4222-8222-222222222222',
    }, personalCtx),
    /tidak ditemukan pada workspace ini/
  );

  // 5. Delete document removes DB row and physical file inside storageDir
  const deleteTool = tools.find((item) => item.name === 'delete_document');
  const fileToRemove = sendCalls[0].filePath;
  assert.ok(fs.existsSync(fileToRemove));
  const delResult = await deleteTool.execute({
    documentId: pdfResult.documentId,
  }, groupCtx);
  assert.equal(delResult.deleted, true);
  assert.equal(delResult.documentId, pdfResult.documentId);
  assert.ok(!fs.existsSync(fileToRemove), 'Physical file must be deleted from storageDir');
  assert.equal(auditLogs.length, 1);
  assert.equal(auditLogs[0].action, 'delete_document');
});

test('Task 3.5: Quoted document resolution in MessageProcessor and workspace recentDocuments in AgentRuntime', async () => {
  const capturedRunArgs = [];
  const workspaceDocs = [
    {
      id: 'doc-uuid-kontrak-01',
      filename: 'Kontrak-Vendor-2026.pdf',
      mime_type: 'application/pdf',
      file_size: 40960,
      created_at: '2026-11-08T10:00:00.000Z',
    },
  ];

  const db = {
    consumeRateLimit: () => ({ allowed: true }),
    getChatOutputMode: () => 'text',
    getHistory: () => [],
    listMessages: () => [],
    searchMemories: () => [],
    listProjects: () => [],
    listDocuments: () => workspaceDocs,
    addMessage: () => {},
    getTask: () => null,
    getPendingApprovalForTask: () => null,
    getPendingApprovalsForChat: () => [],
    createTask: () => {},
    countTaskSteps: () => 0,
    logModelUsage: () => {},
    updateTask: () => {},
    queueTaskResponse: () => {},
    claimTaskResponse: () => 'Pasal denda ada di halaman 4.',
    finishTaskResponse: () => {},
    audit: () => {},
  };

  let providerMessages = null;
  const runtime = new AgentRuntime({
    provider: {
      chat: async ({ messages }) => {
        providerMessages = messages;
        return {
          model: 'gpt-5.4-mini',
          finishReason: 'stop',
          usage: { prompt_tokens: 100, completion_tokens: 20 },
          message: { role: 'assistant', content: 'Pasal denda ada di halaman 4.' },
        };
      },
    },
    router: { select: () => ({ tier: 'balanced', model: 'gpt-5.4-mini' }) },
    tools: { definitions: () => [] },
    db,
    config: {
      agent: { enabled: true, maxRounds: 3, taskTimeoutMs: 10000, maxOutputTokens: 2048 },
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });

  const processor = new MessageProcessor({
    config: {
      ownerJid: '6281234567890@c.us',
      botJid: '6289999999999@c.us',
      groupPolicy: 'all',
      groupRequireMention: false,
      groupMediaRequireMention: false,
      agent: { enabled: true, maxHistoryMessages: 10, messageRateLimit: 20, messageRateWindowMs: 60000 },
      documents: { maxExtractChars: 30000 },
      media: { enabled: true, voiceReplyDefault: false },
      waha: { baseUrl: 'http://127.0.0.1:3000' },
    },
    db,
    waha: {
      sendText: async () => ({ id: 'msg-out-1' }),
    },
    agent: {
      run: async (args) => {
        capturedRunArgs.push(args);
        return runtime.run(args);
      },
    },
    memoryService: null,
    documentService: {},
    mediaService: {},
    approvalManager: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });

  await processor.process({
    event: 'message',
    payload: {
      id: 'msg-reply-doc-1',
      from: '6281234567890@c.us',
      body: 'Apa isi pasal denda pada dokumen yang saya balas ini?',
      fromMe: false,
      replyTo: {
        id: 'msg-doc-0',
        chatId: '6281234567890@c.us',
        quotedMessage: {
          documentMessage: {
            fileName: 'Kontrak-Vendor-2026.pdf',
            mimetype: 'application/pdf',
          },
        },
      },
    },
  });

  assert.equal(capturedRunArgs.length, 1);
  assert.deepEqual(capturedRunArgs[0].quoteContext.referencedDocument, {
    documentId: 'doc-uuid-kontrak-01',
    filename: 'Kontrak-Vendor-2026.pdf',
    mimeType: 'application/pdf',
  });

  assert.ok(Array.isArray(providerMessages));
  const systemMsg = providerMessages.find((m) => m.role === 'system');
  assert.match(systemMsg.content, /doc-uuid-kontrak-01/);
  assert.match(systemMsg.content, /Kontrak-Vendor-2026\.pdf/);

  const quotedMsg = providerMessages.find(
    (m) => typeof m.content === 'string' && m.content.includes('[UNTRUSTED_QUOTED_MESSAGE]')
  );
  assert.ok(quotedMsg);
  assert.match(quotedMsg.content, /"referencedDocument":\{"documentId":"doc-uuid-kontrak-01"/);
});

test('DOCX XML parser guards out-of-range code points and limits zip bomb decompression', () => {
  const { decodeXmlEntities, readZipEntryFromBuffer } = require('../../../src/documents/parsers/docx-xml-parser');
  const decoded = decodeXmlEntities('Valid &#65; &#x42; invalid &#9999999; &#x9999999;');
  assert.equal(decoded, 'Valid A B invalid &#9999999; &#x9999999;');

  const bombPayload = Buffer.alloc(17 * 1024 * 1024, 0x41);
  const bombZip = buildMinimalZipBuffer([{ name: 'word/document.xml', data: bombPayload }]);
  assert.throws(
    () => readZipEntryFromBuffer(bombZip, 'word/document.xml'),
    /buffer|length|limit|size/i
  );
});

test('readDocumentPages returns hasMorePages false when requested page is out of bounds', () => {
  const text = [
    '--- [HALAMAN 1] ---\nSatu',
    '--- [HALAMAN 2] ---\nDua',
    '--- [HALAMAN 3] ---\nTiga'
  ].join('\n\n');
  const outOfRange = readDocumentPages(text, { page: 99 });
  assert.deepEqual(outOfRange.returnedPages, []);
  assert.equal(outOfRange.hasMorePages, false);

  const midPage = readDocumentPages(text, { page: 2 });
  assert.deepEqual(midPage.returnedPages, [2]);
  assert.equal(midPage.hasMorePages, true);

  const lastPage = readDocumentPages(text, { page: 3 });
  assert.deepEqual(lastPage.returnedPages, [3]);
  assert.equal(lastPage.hasMorePages, false);
});

test('Stage 1: Rupiah parsing, full-file analyze_spreadsheet beyond maxExtractChars, and clean create_spreadsheet summary', async (t) => {
  const { DatabaseStore } = require('../../../src/db/database');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-stage1-sheet-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // 1. Indonesian Rupiah parsing with non-000 thousands and ordinary decimal preservation
  assert.equal(parseSpreadsheetNumber('Rp 150.500'), 150500);
  assert.equal(parseSpreadsheetNumber('IDR 25.250'), 25250);
  assert.equal(parseSpreadsheetNumber('(Rp 10.250)'), -10250);
  assert.equal(parseSpreadsheetNumber('12.345'), 12.345);

  const mixedColCsv = [
    'Cabang,Nominal,Rasio',
    'A,Rp 150.000,12.345',
    'B,25.250,1.500'
  ].join('\n');
  const mixedAnalysis = analyzeSpreadsheetText(mixedColCsv, { filename: 'rupiah.csv' });
  const nominalStats = mixedAnalysis.columns.find((c) => c.name === 'Nominal').numericStats;
  const rasioStats = mixedAnalysis.columns.find((c) => c.name === 'Rasio').numericStats;
  assert.equal(nominalStats.sum, 175250);
  assert.equal(rasioStats.sum, 13.845);

  // 2. Full-file analyze_spreadsheet beyond maxExtractChars (200 chars DB cap, 30 rows on disk)
  const db = new DatabaseStore(path.join(root, 'sheet.sqlite'));
  const storageDir = path.join(root, 'storage');
  try {
    const csvLines = ['Item,Nominal'];
    let expectedSum = 0;
    for (let i = 1; i <= 30; i++) {
      const val = i * 1000 + 500;
      expectedSum += val;
      csvLines.push(`Item-${String(i).padStart(2, '0')},"Rp ${val.toLocaleString('id-ID')}"`);
    }
    const fullCsvBuf = Buffer.from(csvLines.join('\n'), 'utf8');
    const docSvc = new DocumentService({
      db,
      wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
      storageDir,
      maxExtractChars: 200,
      httpClient: {
        get: async () => ({
          status: 200,
          data: fullCsvBuf,
          headers: { 'content-type': 'text/csv', 'content-length': String(fullCsvBuf.length) }
        })
      }
    });

    const ingested = await docSvc.ingestMedia({
      media: { url: '/api/files/budget.csv', filename: 'budget.csv', mimetype: 'text/csv' },
      scope: 'personal',
      ownerId: '628111@c.us',
      sourceEventId: 'evt-big-csv'
    });
    assert.ok(ingested.extractedText.length <= 200);

    const tools = createDocumentTools({
      db,
      documentService: docSvc,
      approvalManager: { create: async () => ({ pendingApproval: true, approvalId: 'ap-1' }) },
      waha: { sendFile: async () => ({ id: 'm1' }) }
    });
    const analyzeTool = tools.find((item) => item.name === 'analyze_spreadsheet');
    const fullRes = await analyzeTool.execute(
      { documentId: ingested.id },
      { scope: 'personal', requesterId: '628111@c.us', chatId: '628111@c.us' }
    );
    assert.equal(fullRes.sourceMode, 'full_file');
    assert.equal(fullRes.truncated, false);
    assert.equal(fullRes.analysis.totalRows, 30);
    assert.equal(fullRes.analysis.columns.find((c) => c.name === 'Nominal').numericStats.sum, expectedSum);

    // 3. Re-analyzing a create_spreadsheet-generated XLSX must not include FORMULAS row
    const createSpreadsheet = tools.find((item) => item.name === 'create_spreadsheet');
    await createSpreadsheet.execute({
      title: 'Rekap',
      headers: ['Item', 'Nilai'],
      rows: [['A', 100], ['B', 200]],
      formulas: { B4: 'SUM(B2:B3)' }
    }, {
      taskId: 't-gen-xlsx',
      scope: 'personal',
      requesterId: '628111@c.us',
      chatId: '628111@c.us'
    });
    const docs = db.listDocuments({ scope: 'personal', ownerId: '628111@c.us', limit: 10 });
    const createdDoc = docs.find((d) => d.filename === 'Rekap.xlsx');
    assert.ok(createdDoc);
    const storedCreated = db.getDocument(createdDoc.id, 'personal', '628111@c.us', null);
    assert.equal(storedCreated.extracted_text.includes('FORMULAS:'), false);
    const fromStoredSummary = analyzeSpreadsheetText(storedCreated.extracted_text, { filename: 'Rekap.xlsx' });
    assert.equal(fromStoredSummary.totalRows, 2);
    const reanalyzed = await analyzeTool.execute(
      { documentId: createdDoc.id },
      { scope: 'personal', requesterId: '628111@c.us', chatId: '628111@c.us' }
    );
    assert.equal(reanalyzed.analysis.totalRows, 2);
    assert.equal(reanalyzed.analysis.columns.find((c) => c.name === 'Nilai').numericStats.sum, 300);
  } finally {
    db.close();
  }
});

test('Stage 2: chunkDocumentText, hybrid semantic+lexical search_document RAG, and OCR AsyncSemaphore queuing work end-to-end', async (t) => {
  const { DatabaseStore } = require('../../../src/db/database');
  const { chunkDocumentText } = require('../../../src/documents/parsers/chunker');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-stage2-doc-rag-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const chunks = chunkDocumentText(
    '--- [HALAMAN 1] ---\n' + 'Pendahuluan umum. '.repeat(90) + '\n\n' +
    '--- [HALAMAN 2] ---\nKlausul denda keterlambatan vendor berlaku setelah tujuh hari kalender.',
    { chunkChars: 600, overlapChars: 100 }
  );
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[chunks.length - 1].pageNumber, 2);

  const db = new DatabaseStore(path.join(root, 'rag.sqlite'));
  t.after(() => db.close());

  let activeOcr = 0;
  let maxConcurrentOcr = 0;
  const docSvc = new DocumentService({
    db,
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: root,
    embedder: async (text) => (/penalti|denda|keterlambatan|keterlambat/i.test(text) ? [0, 1] : [1, 0]),
    commandRunner: async () => ({ stdout: 'Scanned text content', stderr: '' })
  });
  docSvc.renderPdfPagesToImages = async (_pdfPath, workDir) => {
    activeOcr++;
    maxConcurrentOcr = Math.max(maxConcurrentOcr, activeOcr);
    await new Promise((r) => setTimeout(r, 25));
    const p1 = path.join(workDir, 'page-001.jpg');
    fs.writeFileSync(p1, 'jpg');
    activeOcr--;
    return [p1];
  };

  // Concurrent ocrPdfPages calls queue safely via AsyncSemaphore instead of immediately throwing busy
  const [ocr1, ocr2] = await Promise.all([
    docSvc.ocrPdfPages({ buffer: Buffer.from('%PDF-1.4'), digitalPages: [''], totalPages: 1 }),
    docSvc.ocrPdfPages({ buffer: Buffer.from('%PDF-1.4'), digitalPages: [''], totalPages: 1 })
  ]);
  assert.equal(maxConcurrentOcr, 1);
  assert.match(ocr1, /Scanned text content/);
  assert.match(ocr2, /Scanned text content/);

  // Hybrid RAG semantic+lexical match even when query phrasing differs from exact chunk tokens
  const docId = '77777777-7777-4777-8777-777777777777';
  const docText = '--- [HALAMAN 1] ---\nProfil perusahaan vendor resmi.\n\n--- [HALAMAN 2] ---\nKlausul sanksi keterlambatan pembayaran dihitung harian.';
  db.saveDocument({
    id: docId,
    scope: 'personal',
    ownerId: '628111@c.us',
    filename: 'kontrak-rag.pdf',
    mimeType: 'application/pdf',
    filePath: path.join(root, 'kontrak.pdf'),
    fileSize: 200,
    extractedText: docText
  });
  await docSvc.indexDocumentChunks({
    documentId: docId,
    scope: 'personal',
    ownerId: '628111@c.us',
    extractedText: docText
  });

  const tools = createDocumentTools({ db, documentService: docSvc, approvalManager: {}, waha: {} });
  const searchTool = tools.find((item) => item.name === 'search_document');
  const ragRes = await searchTool.execute(
    { query: 'aturan penalti telat bayar', documentId: docId },
    { scope: 'personal', requesterId: '628111@c.us', chatId: '628111@c.us' }
  );
  assert.equal(ragRes.matches.length, 1);
  assert.equal(ragRes.matches[0].id, docId);
  assert.equal(ragRes.matches[0].matchedPages.includes(2), true);
  assert.match(ragRes.matches[0].excerpt, /sanksi keterlambatan/);
});
