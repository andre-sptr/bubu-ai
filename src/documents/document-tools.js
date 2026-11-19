const path = require('node:path');
const fsp = require('node:fs/promises');
const { z } = require('../utils/zod-loader');
const { ResponseHandler } = require('../channels/response-handler');
const { readDocumentPages, searchDocumentSnippets } = require('./parsers/page-search');
const { analyzeSpreadsheetText, compareDocumentTexts } = require('./parsers/spreadsheet-analyzer');

function isPathWithinDir(rootDir, targetPath) {
  if (!rootDir || !targetPath) return false;
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function createDocumentTools({ db, documentService, approvalManager, waha, responseHandler = null, logger = null }) {
  const log = logger || responseHandler?.logger || documentService?.logger || null;
  const delivery = responseHandler || new ResponseHandler({ waha, logger: log });
  const tools = [];

  tools.push({
    name: 'list_documents',
    description: 'List documents uploaded in the current personal or group workspace.',
    scopes: ['personal', 'group'],
    schema: z.object({ limit: z.number().int().min(1).max(20).optional() }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } }
    },
    execute: async ({ limit }, ctx) => ({
      documents: db.listDocuments({
        scope: ctx.scope,
        ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
        chatId: ctx.scope === 'group' ? ctx.chatId : null,
        limit: limit || 10
      })
    })
  });

  tools.push({
    name: 'read_document',
    description: 'Read an uploaded document by its document ID from the current workspace. Supports optional page or startPage/endPage pagination for multi-page PDF/DOCX/text documents.',
    scopes: ['personal', 'group'],
    schema: z.object({
      documentId: z.string().uuid(),
      page: z.number().int().min(1).max(500).optional(),
      startPage: z.number().int().min(1).max(500).optional(),
      endPage: z.number().int().min(1).max(500).optional(),
      maxChars: z.number().int().min(500).max(50000).optional()
    }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        documentId: { type: 'string', description: 'Document UUID returned by list_documents or upload processing' },
        page: { type: 'integer', minimum: 1, maximum: 500, description: 'Optional specific page/section number to read (1-based)' },
        startPage: { type: 'integer', minimum: 1, maximum: 500, description: 'Optional start page/section number (1-based)' },
        endPage: { type: 'integer', minimum: 1, maximum: 500, description: 'Optional end page/section number (1-based)' },
        maxChars: { type: 'integer', minimum: 500, maximum: 50000, description: 'Maximum characters to return (default 12000)' }
      },
      required: ['documentId']
    },
    execute: async ({ documentId, page, startPage, endPage, maxChars }, ctx) => {
      const doc = db.getDocument(
        documentId, ctx.scope,
        ctx.scope === 'personal' ? ctx.requesterId : null,
        ctx.scope === 'group' ? ctx.chatId : null
      );
      if (!doc) throw new Error('Dokumen tidak ditemukan pada workspace ini.');
      const pageData = readDocumentPages(doc.extracted_text, { page, startPage, endPage, maxChars });
      return {
        documentId: doc.id,
        filename: doc.filename,
        mimeType: doc.mime_type,
        totalPages: pageData.totalPages,
        returnedPages: pageData.returnedPages,
        pageLabels: pageData.pageLabels,
        hasMorePages: pageData.hasMorePages,
        text: pageData.text
      };
    }
  });

  tools.push({
    name: 'search_document',
    description: 'Search for terms across uploaded documents in the current workspace and return contextual snippets with page/section labels.',
    scopes: ['personal', 'group'],
    schema: z.object({ query: z.string().min(2).max(300), limit: z.number().int().min(1).max(10).optional() }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['query']
    },
    execute: async ({ query, limit }, ctx) => {
      const rawMatches = db.searchDocuments({
        scope: ctx.scope,
        ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
        chatId: ctx.scope === 'group' ? ctx.chatId : null,
        query, limit: limit || 5
      }) || [];
      const matches = rawMatches.map((item) => {
        if (Array.isArray(item.snippets)) return item;
        const snippetInfo = searchDocumentSnippets(item.extracted_text || item.excerpt || '', query);
        return {
          ...item,
          snippets: snippetInfo.snippets,
          matchedPages: snippetInfo.snippets.map((s) => s.pageNumber),
          totalPages: snippetInfo.totalPages,
          excerpt: snippetInfo.excerpt || item.excerpt || ''
        };
      });
      return { matches };
    }
  });

  tools.push({
    name: 'analyze_spreadsheet',
    description: 'Analyze a previously uploaded XLSX, XLSM or CSV document with deterministic column schema inference, statistics (count, sum, avg, min, max), optional row filtering, and group-by aggregation.',
    scopes: ['personal', 'group'],
    schema: z.object({
      documentId: z.string().uuid(),
      question: z.string().max(500).optional(),
      sheetName: z.string().max(100).optional(),
      filterColumn: z.string().max(100).optional(),
      filterValue: z.string().max(200).optional(),
      groupByColumn: z.string().max(100).optional(),
      aggregateColumn: z.string().max(100).optional(),
      rowLimit: z.number().int().min(1).max(200).optional()
    }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        documentId: { type: 'string' },
        question: { type: 'string' },
        sheetName: { type: 'string', description: 'Optional worksheet name for multi-sheet XLSX files' },
        filterColumn: { type: 'string', description: 'Optional column header name to filter rows by' },
        filterValue: { type: 'string', description: 'Optional substring or value to match in filterColumn' },
        groupByColumn: { type: 'string', description: 'Optional column header name for group-by aggregation' },
        aggregateColumn: { type: 'string', description: 'Optional numeric column header to sum/average per group' },
        rowLimit: { type: 'integer', minimum: 1, maximum: 200 }
      }, required: ['documentId']
    },
    execute: async ({ documentId, question, sheetName, filterColumn, filterValue, groupByColumn, aggregateColumn, rowLimit }, ctx) => {
      const doc = db.getDocument(
        documentId, ctx.scope,
        ctx.scope === 'personal' ? ctx.requesterId : null,
        ctx.scope === 'group' ? ctx.chatId : null
      );
      if (!doc || !['.xlsx', '.xlsm', '.csv'].includes(path.extname(doc.filename).toLowerCase())) {
        throw new Error('Spreadsheet tidak ditemukan atau formatnya bukan XLSX/XLSM/CSV.');
      }
      const analysis = analyzeSpreadsheetText(doc.extracted_text, {
        filename: doc.filename,
        question,
        sheetName,
        filterColumn,
        filterValue,
        groupByColumn,
        aggregateColumn,
        rowLimit
      });
      return {
        documentId: doc.id,
        filename: doc.filename,
        question: question || null,
        analysis
      };
    }
  });

  tools.push({
    name: 'compare_documents',
    description: 'Compare two uploaded documents in the current workspace (e.g. Contract v1 vs v2, or Month 1 vs Month 2 spreadsheet) and return deterministic line/page differences and numeric deltas.',
    scopes: ['personal', 'group'],
    schema: z.object({
      firstDocumentId: z.string().uuid(),
      secondDocumentId: z.string().uuid(),
      focus: z.string().max(300).optional()
    }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        firstDocumentId: { type: 'string', description: 'UUID of the first (baseline) document in the current workspace' },
        secondDocumentId: { type: 'string', description: 'UUID of the second (comparison) document in the current workspace' },
        focus: { type: 'string', description: 'Optional topic, section, or column name to focus comparison on' }
      },
      required: ['firstDocumentId', 'secondDocumentId']
    },
    execute: async ({ firstDocumentId, secondDocumentId, focus }, ctx) => {
      const ownerId = ctx.scope === 'personal' ? ctx.requesterId : null;
      const chatId = ctx.scope === 'group' ? ctx.chatId : null;
      const firstDoc = db.getDocument(firstDocumentId, ctx.scope, ownerId, chatId);
      const secondDoc = db.getDocument(secondDocumentId, ctx.scope, ownerId, chatId);
      if (!firstDoc || !secondDoc) {
        throw new Error('Salah satu atau kedua dokumen tidak ditemukan pada workspace ini.');
      }
      return compareDocumentTexts(firstDoc, secondDoc, { focus });
    }
  });

  const documentTypes = [
    'business_proposal', 'business_plan', 'project_proposal', 'report',
    'financial_report', 'market_research', 'sop', 'work_instruction',
    'meeting_minutes', 'memo', 'formal_letter', 'invoice', 'quotation',
    'project_plan', 'executive_summary', 'general'
  ];
  const documentTypeEnum = z.enum(documentTypes);

  const saveGeneratedDocument = async ({ file, title, content }, ctx) => {
    try {
      const record = db.saveDocument({
        id: file.id,
        scope: ctx.scope,
        ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
        chatId: ctx.scope === 'group' ? ctx.chatId : null,
        filename: file.filename,
        mimeType: file.mimeType,
        filePath: file.filePath,
        fileSize: file.fileSize,
        extractedText: String(content || title || '').slice(0, 50000)
      });
      if (!record) throw new Error('Generated file metadata could not be saved to the workspace.');
      return { record, file };
    } catch (error) {
      await fsp.rm(file.filePath, { force: true }).catch(() => {});
      throw error;
    }
  };

  const assertGroupContext = (ctx) => {
    if (ctx.scope !== 'group') return;
    if (!String(ctx.chatId || '').endsWith('@g.us')) {
      throw new Error('Pengiriman dokumen otomatis hanya diizinkan ke ID grup WhatsApp yang valid.');
    }
    if (!responseHandler && (!waha || typeof waha.sendFile !== 'function')) {
      throw new Error('WAHA file delivery belum tersedia pada runtime.');
    }
  };

  const sendGeneratedGroupFile = async ({ record }, ctx, title) => {
    const stored = db.getDocumentFile(record.id, 'group', null, ctx.chatId);
    if (!stored || stored.id !== record.id || stored.chat_id !== ctx.chatId) {
      throw new Error('Dokumen tidak ditemukan pada workspace grup asal; pengiriman dibatalkan.');
    }

    if (!isPathWithinDir(documentService?.storageDir, stored.file_path)) {
      throw new Error('Lokasi file berada di luar storage Bubu; pengiriman dibatalkan.');
    }
    const storedPath = path.resolve(stored.file_path);

    const stat = await fsp.stat(storedPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > documentService.maxFileBytes) {
      throw new Error('File tidak valid atau melebihi batas ukuran; pengiriman dibatalkan.');
    }
    if (stat.size !== Number(stored.file_size)) {
      throw new Error('Ukuran file tidak sesuai dengan metadata workspace; pengiriman dibatalkan.');
    }

    const caption = `📄 **${title}**\nDibuat oleh Bubu AI.`;
    try {
      const receipt = await delivery.sendFile(storedPath, ctx.chatId, {
        filename: stored.filename,
        mimetype: stored.mime_type,
        caption
      });
      const messageId = receipt.messageId || null;
      return {
        created: true,
        documentId: record.id,
        filename: stored.filename,
        fileSize: stat.size,
        workspace: 'group',
        deliveryStatus: 'sent',
        targetChatId: ctx.chatId,
        messageId,
        message: 'File berhasil dibuat, disimpan di workspace grup, dan dikirim ke grup asal.'
      };
    } catch (error) {
      log?.warn?.({
        documentId: record.id,
        chatId: ctx.chatId,
        filename: stored.filename,
        error: error?.message || 'Unknown WAHA delivery error'
      }, 'Group document delivery failed');
      return {
        created: true,
        documentId: record.id,
        filename: stored.filename,
        fileSize: stat.size,
        workspace: 'group',
        deliveryStatus: 'uncertain',
        targetChatId: ctx.chatId,
        message: 'File berhasil dibuat dan disimpan, tetapi hasil pengiriman WAHA belum dapat dipastikan. Bubu tidak mengirim ulang otomatis untuk mencegah file duplikat. Periksa grup terlebih dahulu.'
      };
    }
  };

  const finishGeneratedFile = async ({ saved, title }, ctx) => {
    const { file, record } = saved;
    if (ctx.scope === 'group') {
      return sendGeneratedGroupFile({ file, record }, ctx, title);
    }
    return approvalManager.create({
      taskId: ctx.taskId, chatId: ctx.chatId, requesterId: ctx.requesterId,
      toolName: 'send_whatsapp_file',
      args: {
        targetId: ctx.chatId, filePath: file.filePath,
        filename: file.filename, mimetype: file.mimeType,
        caption: `Dokumen: ${title}`
      }
    });
  };

  tools.push({
    name: 'list_document_templates',
    description: 'List the professional DOCX, PDF, and XLSX document templates Bubu can generate. Use this when the user asks what kinds of files or templates are available.',
    scopes: ['personal', 'group'],
    schema: z.object({}).strict(),
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    execute: async () => ({
      docx: [
        { type: 'business_proposal', examples: ['proposal bisnis', 'proposal kerja sama', 'sponsorship proposal'] },
        { type: 'business_plan', examples: ['business plan', 'rencana usaha', 'feasibility outline'] },
        { type: 'project_proposal', examples: ['proposal proyek', 'project charter'] },
        { type: 'report', examples: ['laporan kegiatan', 'laporan progres', 'laporan bisnis'] },
        { type: 'financial_report', examples: ['laporan keuangan', 'analisis biaya'] },
        { type: 'market_research', examples: ['riset pasar', 'analisis kompetitor'] },
        { type: 'sop', examples: ['SOP', 'kebijakan operasional'] },
        { type: 'work_instruction', examples: ['instruksi kerja', 'panduan langkah kerja'] },
        { type: 'meeting_minutes', examples: ['notulen rapat', 'meeting minutes', 'action items'] },
        { type: 'memo', examples: ['memo internal', 'pengumuman'] },
        { type: 'formal_letter', examples: ['surat resmi', 'surat penawaran', 'surat permohonan'] },
        { type: 'invoice', examples: ['invoice', 'tagihan'] },
        { type: 'quotation', examples: ['quotation', 'surat penawaran harga'] },
        { type: 'project_plan', examples: ['project plan', 'implementation plan', 'risk register'] },
        { type: 'executive_summary', examples: ['ringkasan eksekutif', 'management brief'] }
      ],
      pdf: [
        { type: 'executive_summary', examples: ['ringkasan eksekutif PDF', 'one-pager manajemen'] },
        { type: 'report', examples: ['laporan PDF siap cetak', 'audit summary PDF'] },
        { type: 'invoice', examples: ['invoice PDF', 'tagihan resmi PDF'] },
        { type: 'quotation', examples: ['penawaran harga PDF', 'quotation PDF'] },
        { type: 'formal_letter', examples: ['surat resmi PDF', 'memo resmi PDF'] },
        { type: 'sop', examples: ['SOP PDF', 'instruksi kerja PDF'] }
      ],
      xlsx: [
        { type: 'financial_budget', examples: ['anggaran', 'budget bulanan', 'cash flow', 'profit and loss'] },
        { type: 'inventory', examples: ['stok barang', 'inventory tracker', 'stock opname'] },
        { type: 'sales_report', examples: ['laporan penjualan', 'sales tracker', 'revenue forecast'] },
        { type: 'project_tracker', examples: ['project tracker', 'jadwal proyek', 'Gantt data'] },
        { type: 'kpi_dashboard', examples: ['KPI tracker', 'performance dashboard'] },
        { type: 'hr_tracker', examples: ['absensi', 'data karyawan', 'leave tracker', 'payroll worksheet'] },
        { type: 'customer_database', examples: ['database pelanggan', 'CRM sederhana'] },
        { type: 'custom', examples: ['spreadsheet sesuai kolom dan data permintaan'] }
      ],
      note: 'Bubu dapat menyesuaikan struktur dan isi dokumen (DOCX, PDF, maupun XLSX). Data yang tidak diberikan harus ditandai sebagai asumsi atau dibiarkan kosong, bukan dikarang.'
    })
  });

  tools.push({
    name: 'create_document',
    description: `Create a professionally formatted DOCX or PDF file for the current workspace (personal DM or group). Choose documentType from: ${documentTypes.join(', ')}. Write complete, useful content with Markdown headings, inline bold/italic/code, bullet/numbered lists and pipe tables when appropriate. Include a clear title, executive summary or purpose, structured sections, and conclusion/next steps when suitable. Do not invent facts, names, dates, amounts or legal requirements; label assumptions and placeholders. In group scope, automatically send the generated file to the same originating group after verifying its group-scoped database record and storage path. Never choose another destination. In personal scope, ask owner approval before sending the file.`,
    scopes: ['personal', 'group'],
    schema: z.object({
      title: z.string().min(1).max(180),
      content: z.string().min(1).max(30000),
      documentType: documentTypeEnum.optional(),
      format: z.enum(['docx', 'pdf']).optional(),
      subtitle: z.string().max(250).optional(),
      author: z.string().max(120).optional(),
      filename: z.string().min(1).max(100).optional()
    }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string', maxLength: 180 },
        content: { type: 'string', maxLength: 30000, description: 'Full document body. Markdown headings, inline **bold**/*italic*/`code`, bullet lists, numbered lists, and pipe tables are supported.' },
        documentType: { type: 'string', enum: documentTypes },
        format: { type: 'string', enum: ['docx', 'pdf'], description: 'Output file format: docx (default) or pdf' },
        subtitle: { type: 'string', maxLength: 250 },
        author: { type: 'string', maxLength: 120 },
        filename: { type: 'string', maxLength: 100, description: 'Optional .docx or .pdf filename' }
      }, required: ['title', 'content']
    },
    risk: 'external',
    execute: async ({ title, content, documentType, format, subtitle, author, filename }, ctx) => {
      assertGroupContext(ctx);
      const targetFormat = format || (filename?.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx');
      if (targetFormat === 'pdf') {
        const buffer = await documentService.createPdf({ title, content, documentType, subtitle, author });
        const baseName = filename ? filename.replace(/\.(docx|pdf)$/i, '') : title;
        const file = await documentService.persistGenerated({
          buffer,
          filename: `${baseName}.pdf`,
          mimeType: 'application/pdf'
        });
        const saved = await saveGeneratedDocument({ file, title, content }, ctx);
        return finishGeneratedFile({ saved, title }, ctx);
      }
      const buffer = await documentService.createDocx({ title, content, documentType, subtitle, author });
      const file = await documentService.persistGenerated({
        buffer,
        filename: filename?.toLowerCase().endsWith('.docx') ? filename : `${filename || title}.docx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      });
      const saved = await saveGeneratedDocument({ file, title, content }, ctx);
      return finishGeneratedFile({ saved, title }, ctx);
    }
  });

  tools.push({
    name: 'create_pdf',
    description: `Create a professionally formatted, print-ready PDF document for the current workspace (personal DM or group). Choose documentType from: ${documentTypes.join(', ')}. Supports Markdown headings, inline bold/italic/code, bullet/numbered lists, and pipe tables. In group scope, automatically sends the generated PDF to the originating group after verifying workspace ownership. In personal scope, requires owner approval before sending.`,
    scopes: ['personal', 'group'],
    schema: z.object({
      title: z.string().min(1).max(180),
      content: z.string().min(1).max(30000),
      documentType: documentTypeEnum.optional(),
      subtitle: z.string().max(250).optional(),
      author: z.string().max(120).optional(),
      filename: z.string().min(1).max(100).optional()
    }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string', maxLength: 180 },
        content: { type: 'string', maxLength: 30000, description: 'Full PDF document body with Markdown headings, lists, and pipe tables.' },
        documentType: { type: 'string', enum: documentTypes },
        subtitle: { type: 'string', maxLength: 250 },
        author: { type: 'string', maxLength: 120 },
        filename: { type: 'string', maxLength: 100, description: 'Optional .pdf filename' }
      }, required: ['title', 'content']
    },
    risk: 'external',
    execute: async ({ title, content, documentType, subtitle, author, filename }, ctx) => {
      assertGroupContext(ctx);
      const buffer = await documentService.createPdf({ title, content, documentType, subtitle, author });
      const file = await documentService.persistGenerated({
        buffer,
        filename: filename?.toLowerCase().endsWith('.pdf') ? filename : `${filename || title}.pdf`,
        mimeType: 'application/pdf'
      });
      const saved = await saveGeneratedDocument({ file, title, content }, ctx);
      return finishGeneratedFile({ saved, title }, ctx);
    }
  });

  tools.push({
    name: 'delete_document',
    description: 'Delete a document from the current personal or group workspace by its document ID, removing both its database record and stored file.',
    scopes: ['personal', 'group'],
    schema: z.object({
      documentId: z.string().uuid()
    }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        documentId: { type: 'string', description: 'Document UUID to delete from the current workspace' }
      },
      required: ['documentId']
    },
    execute: async ({ documentId }, ctx) => {
      const ownerId = ctx.scope === 'personal' ? ctx.requesterId : null;
      const chatId = ctx.scope === 'group' ? ctx.chatId : null;
      if (documentService && typeof documentService.deleteWorkspaceDocument === 'function') {
        return documentService.deleteWorkspaceDocument({
          documentId,
          scope: ctx.scope,
          ownerId,
          chatId,
          actorId: ctx.requesterId
        });
      }
      if (typeof db.deleteDocument === 'function') {
        const removed = db.deleteDocument(documentId, ctx.scope, ownerId, chatId);
        if (!removed) throw new Error('Dokumen tidak ditemukan pada workspace ini.');
        let fileRemoved = false;
        if (isPathWithinDir(documentService?.storageDir, removed.file_path)) {
          try {
            await fsp.rm(path.resolve(removed.file_path), { force: true });
            fileRemoved = true;
          } catch (err) {
            log?.warn?.({ documentId: removed.id, error: err.message }, 'Fallback document file removal failed');
          }
        }
        return { deleted: true, documentId: removed.id, filename: removed.filename, scope: removed.scope, fileRemoved };
      }
      throw new Error('Fitur penghapusan dokumen belum tersedia pada database runtime.');
    }
  });

  const spreadsheetSheetSchema = z.object({
    name: z.string().min(1).max(31),
    headers: z.array(z.string().max(100)).min(1).max(40),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(2000),
    formulas: z.record(z.string()).optional(),
    columnFormats: z.record(z.string()).optional(),
    freezeRows: z.number().int().min(1).max(20).optional()
  }).strict();

  tools.push({
    name: 'create_spreadsheet',
    description: 'Create a professionally formatted XLSX workbook for the current workspace. Supports a single sheet or up to 12 named worksheets, formulas, column number formats, frozen headers and filters. Common use cases: financial budget/cash flow/profit-and-loss, inventory and stock opname, sales report, project tracker, KPI dashboard, HR attendance/leave/payroll worksheet, customer database and custom analysis. Use formulas for derived totals and ratios; do not invent source data. In group scope, generate, save and automatically send to the current originating group after validating workspace ownership. In personal scope, the owner must approve sending.',
    scopes: ['personal', 'group'],
    schema: z.object({
      title: z.string().min(1).max(31),
      headers: z.array(z.string().max(100)).min(1).max(40).optional(),
      rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(2000).optional(),
      formulas: z.record(z.string()).optional(),
      columnFormats: z.record(z.string()).optional(),
      freezeRows: z.number().int().min(1).max(20).optional(),
      sheets: z.array(spreadsheetSheetSchema).min(1).max(12).optional(),
      filename: z.string().min(1).max(100).optional()
    }).strict().refine((v) => (Array.isArray(v.sheets) && v.sheets.length > 0) ||
      (Array.isArray(v.headers) && v.headers.length > 0), 'Provide headers or sheets.'),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string', maxLength: 31 },
        headers: { type: 'array', items: { type: 'string', maxLength: 100 }, minItems: 1, maxItems: 40 },
        rows: { type: 'array', items: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] } }, maxItems: 2000 },
        formulas: { type: 'object', additionalProperties: { type: 'string' }, description: 'Excel cell formulas, e.g. {"D2":"SUM(B2:C2)"}.' },
        columnFormats: { type: 'object', additionalProperties: { type: 'string' }, description: 'Excel number formats by column letter, e.g. {"B":"Rp #,##0","C":"0.0%"}.' },
        freezeRows: { type: 'integer', minimum: 1, maximum: 20 },
        sheets: {
          type: 'array', minItems: 1, maxItems: 12,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              name: { type: 'string', maxLength: 31 },
              headers: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 40 },
              rows: { type: 'array', items: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] } }, maxItems: 2000 },
              formulas: { type: 'object', additionalProperties: { type: 'string' } },
              columnFormats: { type: 'object', additionalProperties: { type: 'string' } },
              freezeRows: { type: 'integer', minimum: 1, maximum: 20 }
            }, required: ['name', 'headers', 'rows']
          }
        },
        filename: { type: 'string', maxLength: 100 }
      }, required: ['title']
    },
    risk: 'external',
    execute: async ({ title, headers, rows, formulas, columnFormats, sheets, freezeRows, filename }, ctx) => {
      assertGroupContext(ctx);
      if (!sheets?.length && rows?.some((row) => row.length > headers.length)) {
        throw new Error('Jumlah kolom data melebihi jumlah header.');
      }
      if (sheets?.some((sheet) => sheet.rows.some((row) => row.length > sheet.headers.length))) {
        throw new Error('Jumlah kolom data pada worksheet melebihi jumlah header.');
      }
      const buffer = await documentService.createXlsx({ title, headers, rows, formulas, columnFormats, sheets, freezeRows });
      const file = await documentService.persistGenerated({
        buffer,
        filename: filename?.toLowerCase().endsWith('.xlsx') ? filename : `${filename || title}.xlsx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      const workbookSummary = (sheets?.length ? sheets : [{ name: title, headers, rows, formulas }])
        .map((sheet) => [
          `SHEET: ${sheet.name || title}`,
          `HEADERS: ${(sheet.headers || []).join(' | ')}`,
          ...(sheet.rows || []).map((row) => (row || []).map((value) => String(value ?? '')).join(' | ')),
          `FORMULAS: ${JSON.stringify(sheet.formulas || {})}`
        ].join('\n')).join('\n\n');
      const saved = await saveGeneratedDocument({
        file, title, content: workbookSummary
      }, ctx);
      return finishGeneratedFile({ saved, title }, ctx);
    }
  });

  return tools;
}

module.exports = { createDocumentTools };
