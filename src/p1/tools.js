const crypto = require('node:crypto');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { ResponseHandler } = require('../channels/response-handler');
const {
  readDocumentPages,
  searchDocumentSnippets,
  analyzeSpreadsheetText,
  compareDocumentTexts,
} = require('./documents/service');

function createFallbackZod() {
  const makeChain = (validateFn = (v) => v) => {
    let isOptional = false;
    let isNullable = false;
    const refinements = [];
    const api = {
      optional() { isOptional = true; return api; },
      nullable() { isNullable = true; return api; },
      strict() { return api; },
      min() { return api; },
      max() { return api; },
      int() { return api; },
      positive() { return api; },
      uuid() { return api; },
      url() { return api; },
      datetime() { return api; },
      refine(fn, message = 'Validation failed') {
        refinements.push({ fn, message });
        return api;
      },
      parse(val) {
        if (val === undefined) {
          if (isOptional) return undefined;
          throw new Error('Required value is undefined');
        }
        if (val === null) {
          if (isNullable) return null;
          throw new Error('Value cannot be null');
        }
        const out = validateFn(val);
        for (const r of refinements) {
          if (!r.fn(out)) throw new Error(r.message);
        }
        return out;
      },
    };
    return api;
  };

  return {
    string: () => makeChain((v) => {
      if (typeof v !== 'string') throw new Error('Expected string');
      return v;
    }),
    number: () => makeChain((v) => {
      if (typeof v !== 'number' || Number.isNaN(v)) throw new Error('Expected number');
      return v;
    }),
    boolean: () => makeChain((v) => {
      if (typeof v !== 'boolean') throw new Error('Expected boolean');
      return v;
    }),
    null: () => makeChain((v) => {
      if (v !== null) throw new Error('Expected null');
      return null;
    }),
    enum: (values) => makeChain((v) => {
      if (!values.includes(v)) throw new Error(`Expected one of: ${values.join(', ')}`);
      return v;
    }),
    array: (itemSchema) => makeChain((v) => {
      if (!Array.isArray(v)) throw new Error('Expected array');
      return itemSchema ? v.map((item) => itemSchema.parse(item)) : v;
    }),
    union: (schemas) => makeChain((v) => {
      for (const s of schemas) {
        try { return s.parse(v); } catch {}
      }
      throw new Error('Invalid union value');
    }),
    record: () => makeChain((v) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected record object');
      return v;
    }),
    object: (shape = {}) => {
      let strictMode = false;
      const base = makeChain((v) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected object');
        if (strictMode) {
          for (const key of Object.keys(v)) {
            if (!Object.prototype.hasOwnProperty.call(shape, key)) {
              throw new Error(`Unrecognized key: ${key}`);
            }
          }
        }
        const out = {};
        for (const [k, schema] of Object.entries(shape)) {
          const parsed = schema.parse(v[k]);
          if (parsed !== undefined) out[k] = parsed;
        }
        return out;
      });
      const origStrict = base.strict;
      base.strict = () => {
        strictMode = true;
        return origStrict();
      };
      return base;
    },
  };
}

function loadZod() {
  try {
    return require('zod').z;
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return createFallbackZod();
    throw err;
  }
}

const z = loadZod();

function createP1Tools({ db, documentService, webSearch, webFetch, approvalManager, waha, responseHandler = null }) {
  const delivery = responseHandler || new ResponseHandler({ waha, logger: null });
  const tools = [];

  if (webSearch) {
    tools.push({
      name: 'web_search',
      description: 'Search current public web information. Return concise source titles, URLs, snippets and dates. Use for fresh facts and research.',
      scopes: ['personal','group'],
      schema: z.object({
        query: z.string().min(3).max(400),
        maxResults: z.number().int().min(1).max(10).optional(),
        timeRange: z.enum(['day','week','month','year']).optional()
      }).strict(),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          query: { type: 'string' },
          maxResults: { type: 'integer', minimum: 1, maximum: 10 },
          timeRange: { type: 'string', enum: ['day','week','month','year'] }
        }, required: ['query']
      },
      execute: async (args) => ({ results: await webSearch.search(args) })
    });
  }

  tools.push({
    name: 'web_fetch',
    description: 'Fetch and extract readable text from a public HTTP/HTTPS web page. Do not fetch private networks or local services.',
    scopes: ['personal','group'],
    schema: z.object({ url: z.string().url().max(2000) }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { url: { type: 'string', format: 'uri' } }, required: ['url']
    },
    execute: async (args) => webFetch.fetch(args)
  });

  tools.push({
    name: 'list_documents',
    description: 'List documents uploaded in the current personal or group workspace.',
    scopes: ['personal','group'],
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
    scopes: ['personal','group'],
    schema: z.object({
      documentId: z.string().uuid(),
      page: z.number().int().min(1).max(500).optional(),
      startPage: z.number().int().min(1).max(500).optional(),
      endPage: z.number().int().min(1).max(500).optional(),
      maxChars: z.number().int().min(500).max(50000).optional(),
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
        documentId,ctx.scope,
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
        text: pageData.text,
      };
    }
  });

  tools.push({
    name: 'search_document',
    description: 'Search for terms across uploaded documents in the current workspace and return contextual snippets with page/section labels.',
    scopes: ['personal','group'],
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
          excerpt: snippetInfo.excerpt || item.excerpt || '',
        };
      });
      return { matches };
    }
  });

  tools.push({
    name: 'analyze_spreadsheet',
    description: 'Analyze a previously uploaded XLSX, XLSM or CSV document with deterministic column schema inference, statistics (count, sum, avg, min, max), optional row filtering, and group-by aggregation.',
    scopes: ['personal','group'],
    schema: z.object({
      documentId: z.string().uuid(),
      question: z.string().max(500).optional(),
      sheetName: z.string().max(100).optional(),
      filterColumn: z.string().max(100).optional(),
      filterValue: z.string().max(200).optional(),
      groupByColumn: z.string().max(100).optional(),
      aggregateColumn: z.string().max(100).optional(),
      rowLimit: z.number().int().min(1).max(200).optional(),
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
        documentId,ctx.scope,
        ctx.scope === 'personal' ? ctx.requesterId : null,
        ctx.scope === 'group' ? ctx.chatId : null
      );
      if (!doc || !['.xlsx','.xlsm','.csv'].includes(path.extname(doc.filename).toLowerCase())) {
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
        rowLimit,
      });
      return {
        documentId: doc.id,
        filename: doc.filename,
        question: question || null,
        extractedRows: doc.extracted_text,
        analysis,
      };
    }
  });

  tools.push({
    name: 'compare_documents',
    description: 'Compare two uploaded documents in the current workspace (e.g. Contract v1 vs v2, or Month 1 vs Month 2 spreadsheet) and return deterministic line/page differences and numeric deltas.',
    scopes: ['personal','group'],
    schema: z.object({
      firstDocumentId: z.string().uuid(),
      secondDocumentId: z.string().uuid(),
      focus: z.string().max(300).optional(),
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
    'business_proposal','business_plan','project_proposal','report',
    'financial_report','market_research','sop','work_instruction',
    'meeting_minutes','memo','formal_letter','invoice','quotation',
    'project_plan','executive_summary','general'
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
    if (!waha || typeof waha.sendFile !== 'function') {
      throw new Error('WAHA file delivery belum tersedia pada runtime.');
    }
  };

  const sendGeneratedGroupFile = async ({ file, record }, ctx, title) => {
    // Re-read the document record using the exact group scope before sending.
    // This prevents a file path from another workspace being delivered here.
    const stored = db.getDocumentFile(record.id, 'group', null, ctx.chatId);
    if (!stored || stored.id !== record.id || stored.chat_id !== ctx.chatId) {
      throw new Error('Dokumen tidak ditemukan pada workspace grup asal; pengiriman dibatalkan.');
    }

    const storageRoot = path.resolve(documentService.storageDir);
    const storedPath = path.resolve(stored.file_path);
    const relativePath = path.relative(storageRoot, storedPath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('Lokasi file berada di luar storage Bubu; pengiriman dibatalkan.');
    }

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
      // WAHA/network failures may happen after WhatsApp accepted the file.
      // Mark the outcome uncertain and never resend automatically.
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
    scopes: ['personal','group'],
    schema: z.object({}).strict(),
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    execute: async () => ({
      docx: [
        { type: 'business_proposal', examples: ['proposal bisnis','proposal kerja sama','sponsorship proposal'] },
        { type: 'business_plan', examples: ['business plan','rencana usaha','feasibility outline'] },
        { type: 'project_proposal', examples: ['proposal proyek','project charter'] },
        { type: 'report', examples: ['laporan kegiatan','laporan progres','laporan bisnis'] },
        { type: 'financial_report', examples: ['laporan keuangan','analisis biaya'] },
        { type: 'market_research', examples: ['riset pasar','analisis kompetitor'] },
        { type: 'sop', examples: ['SOP','kebijakan operasional'] },
        { type: 'work_instruction', examples: ['instruksi kerja','panduan langkah kerja'] },
        { type: 'meeting_minutes', examples: ['notulen rapat','meeting minutes','action items'] },
        { type: 'memo', examples: ['memo internal','pengumuman'] },
        { type: 'formal_letter', examples: ['surat resmi','surat penawaran','surat permohonan'] },
        { type: 'invoice', examples: ['invoice','tagihan'] },
        { type: 'quotation', examples: ['quotation','surat penawaran harga'] },
        { type: 'project_plan', examples: ['project plan','implementation plan','risk register'] },
        { type: 'executive_summary', examples: ['ringkasan eksekutif','management brief'] }
      ],
      pdf: [
        { type: 'executive_summary', examples: ['ringkasan eksekutif PDF','one-pager manajemen'] },
        { type: 'report', examples: ['laporan PDF siap cetak','audit summary PDF'] },
        { type: 'invoice', examples: ['invoice PDF','tagihan resmi PDF'] },
        { type: 'quotation', examples: ['penawaran harga PDF','quotation PDF'] },
        { type: 'formal_letter', examples: ['surat resmi PDF','memo resmi PDF'] },
        { type: 'sop', examples: ['SOP PDF','instruksi kerja PDF'] }
      ],
      xlsx: [
        { type: 'financial_budget', examples: ['anggaran','budget bulanan','cash flow','profit and loss'] },
        { type: 'inventory', examples: ['stok barang','inventory tracker','stock opname'] },
        { type: 'sales_report', examples: ['laporan penjualan','sales tracker','revenue forecast'] },
        { type: 'project_tracker', examples: ['project tracker','jadwal proyek','Gantt data'] },
        { type: 'kpi_dashboard', examples: ['KPI tracker','performance dashboard'] },
        { type: 'hr_tracker', examples: ['absensi','data karyawan','leave tracker','payroll worksheet'] },
        { type: 'customer_database', examples: ['database pelanggan','CRM sederhana'] },
        { type: 'custom', examples: ['spreadsheet sesuai kolom dan data permintaan'] }
      ],
      note: 'Bubu dapat menyesuaikan struktur dan isi dokumen (DOCX, PDF, maupun XLSX). Data yang tidak diberikan harus ditandai sebagai asumsi atau dibiarkan kosong, bukan dikarang.'
    })
  });

  tools.push({
    name: 'create_document',
    description: `Create a professionally formatted DOCX or PDF file for the current workspace (personal DM or group). Choose documentType from: ${documentTypes.join(', ')}. Write complete, useful content with Markdown headings, inline bold/italic/code, bullet/numbered lists and pipe tables when appropriate. Include a clear title, executive summary or purpose, structured sections, and conclusion/next steps when suitable. Do not invent facts, names, dates, amounts or legal requirements; label assumptions and placeholders. In group scope, automatically send the generated file to the same originating group after verifying its group-scoped database record and storage path. Never choose another destination. In personal scope, ask owner approval before sending the file.`,
    scopes: ['personal','group'],
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
      }, required: ['title','content']
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
    scopes: ['personal','group'],
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
      }, required: ['title','content']
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
    scopes: ['personal','group'],
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
          actorId: ctx.requesterId,
        });
      }
      if (typeof db.deleteDocument === 'function') {
        const removed = db.deleteDocument(documentId, ctx.scope, ownerId, chatId);
        if (!removed) throw new Error('Dokumen tidak ditemukan pada workspace ini.');
        if (removed.file_path) {
          await fsp.rm(removed.file_path, { force: true }).catch(() => {});
        }
        return { deleted: true, documentId: removed.id, filename: removed.filename, scope: removed.scope };
      }
      throw new Error('Fitur penghapusan dokumen belum tersedia pada database runtime.');
    }
  });

  const spreadsheetSheetSchema = z.object({
    name: z.string().min(1).max(31),
    headers: z.array(z.string().max(100)).min(1).max(40),
    rows: z.array(z.array(z.union([z.string(),z.number(),z.boolean(),z.null()]))).max(2000),
    formulas: z.record(z.string()).optional(),
    columnFormats: z.record(z.string()).optional(),
    freezeRows: z.number().int().min(1).max(20).optional()
  }).strict();

  tools.push({
    name: 'create_spreadsheet',
    description: 'Create a professionally formatted XLSX workbook for the current workspace. Supports a single sheet or up to 12 named worksheets, formulas, column number formats, frozen headers and filters. Common use cases: financial budget/cash flow/profit-and-loss, inventory and stock opname, sales report, project tracker, KPI dashboard, HR attendance/leave/payroll worksheet, customer database and custom analysis. Use formulas for derived totals and ratios; do not invent source data. In group scope, generate, save and automatically send to the current originating group after validating workspace ownership. In personal scope, the owner must approve sending.',
    scopes: ['personal','group'],
    schema: z.object({
      title: z.string().min(1).max(31),
      headers: z.array(z.string().max(100)).min(1).max(40).optional(),
      rows: z.array(z.array(z.union([z.string(),z.number(),z.boolean(),z.null()]))).max(2000).optional(),
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
        rows: { type: 'array', items: { type: 'array', items: { anyOf: [{type:'string'},{type:'number'},{type:'boolean'},{type:'null'}] } }, maxItems: 2000 },
        formulas: { type: 'object', additionalProperties: { type: 'string' }, description: 'Excel cell formulas, e.g. {\"D2\":\"SUM(B2:C2)\"}.' },
        columnFormats: { type: 'object', additionalProperties: { type: 'string' }, description: 'Excel number formats by column letter, e.g. {\"B\":\"Rp #,##0\",\"C\":\"0.0%\"}.' },
        freezeRows: { type: 'integer', minimum: 1, maximum: 20 },
        sheets: {
          type: 'array', minItems: 1, maxItems: 12,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              name: { type: 'string', maxLength: 31 },
              headers: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 40 },
              rows: { type: 'array', items: { type: 'array', items: { anyOf: [{type:'string'},{type:'number'},{type:'boolean'},{type:'null'}] } }, maxItems: 2000 },
              formulas: { type: 'object', additionalProperties: { type: 'string' } },
              columnFormats: { type: 'object', additionalProperties: { type: 'string' } },
              freezeRows: { type: 'integer', minimum: 1, maximum: 20 }
            }, required: ['name','headers','rows']
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

  tools.push({
    name: 'create_task',
    description: 'Create a task in the current workspace. Use ISO-8601 with timezone for optional dueAt.',
    scopes: ['personal','group'],
    schema: z.object({
      title: z.string().min(1).max(180),
      description: z.string().max(2000).optional(),
      priority: z.enum(['low','normal','high','urgent']).optional(),
      dueAt: z.string().datetime({ offset: true }).optional()
    }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string' }, description: { type: 'string' },
        priority: { type: 'string', enum: ['low','normal','high','urgent'] },
        dueAt: { type: 'string', description: 'Optional ISO-8601 timestamp with timezone' }
      }, required: ['title']
    },
    execute: async (args, ctx) => {
      const id = crypto.randomUUID();
      const dueTime = args.dueAt ? Date.parse(args.dueAt) : null;
      if (dueTime && (!Number.isFinite(dueTime) || dueTime < Date.now())) throw new Error('Due date must be in the future.');
      const task = db.createUserTask({
        id,scope:ctx.scope,ownerId:ctx.scope === 'personal' ? ctx.requesterId : null,
        chatId:ctx.scope === 'group' ? ctx.chatId : null,
        title:args.title,description:args.description,priority:args.priority,
        dueAt:dueTime ? new Date(dueTime).toISOString() : null
      });
      return { created: true, task };
    }
  });

  tools.push({
    name: 'list_tasks',
    description: 'List tasks from the current personal or group workspace. Optionally filter by status.',
    scopes: ['personal','group'],
    schema: z.object({
      status: z.enum(['open','in_progress','blocked','completed','cancelled']).optional(),
      limit: z.number().int().min(1).max(30).optional()
    }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { status: { type: 'string', enum: ['open','in_progress','blocked','completed','cancelled'] }, limit: { type: 'integer', minimum: 1, maximum: 30 } }
    },
    execute: async ({ status, limit }, ctx) => ({
      tasks: db.listUserTasks({
        scope:ctx.scope,ownerId:ctx.scope === 'personal' ? ctx.requesterId : null,
        chatId:ctx.scope === 'group' ? ctx.chatId : null,status:status || null,limit:limit || 20
      })
    })
  });

  tools.push({
    name: 'update_task',
    description: 'Update a task in the current workspace by task ID. Only fields supplied are changed.',
    scopes: ['personal','group'],
    schema: z.object({
      taskId: z.string().uuid(),
      title: z.string().min(1).max(180).optional(),
      description: z.string().max(2000).optional(),
      status: z.enum(['open','in_progress','blocked','completed','cancelled']).optional(),
      priority: z.enum(['low','normal','high','urgent']).optional(),
      dueAt: z.string().datetime({ offset: true }).nullable().optional()
    }).strict().refine((v) => Object.keys(v).some((k) => k !== 'taskId'), 'At least one field to update is required'),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        taskId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
        status: { type: 'string', enum: ['open','in_progress','blocked','completed','cancelled'] },
        priority: { type: 'string', enum: ['low','normal','high','urgent'] },
        dueAt: { type: ['string','null'] }
      }, required: ['taskId']
    },
    execute: async ({ taskId, dueAt, ...fields }, ctx) => {
      if (dueAt !== undefined && dueAt !== null && Date.parse(dueAt) < Date.now()) throw new Error('Due date must be in the future.');
      const mapped = { ...fields };
      if (dueAt !== undefined) mapped.due_at = dueAt ? new Date(dueAt).toISOString() : null;
      const task = db.updateUserTask({
        id:taskId,scope:ctx.scope,ownerId:ctx.scope === 'personal' ? ctx.requesterId : null,
        chatId:ctx.scope === 'group' ? ctx.chatId : null,fields:mapped
      });
      if (!task) throw new Error('Task not found in this workspace.');
      return { updated: true, task };
    }
  });

  tools.push({
    name: 'complete_task',
    description: 'Mark a task as completed in the current workspace.',
    scopes: ['personal','group'],
    schema: z.object({ taskId: z.string().uuid() }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { taskId: { type: 'string' } }, required: ['taskId']
    },
    execute: async ({ taskId }, ctx) => {
      const task = db.updateUserTask({
        id:taskId,scope:ctx.scope,ownerId:ctx.scope === 'personal' ? ctx.requesterId : null,
        chatId:ctx.scope === 'group' ? ctx.chatId : null,fields:{status:'completed'}
      });
      if (!task) throw new Error('Task not found in this workspace.');
      return { completed: true, task };
    }
  });

  tools.push({
    name: 'list_reminders',
    description: 'List the owner’s reminders in the current private chat.',
    scopes: ['personal'],
    schema: z.object({ status: z.enum(['pending','sent','failed','cancelled']).optional(), limit: z.number().int().min(1).max(30).optional() }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { status: { type: 'string', enum: ['pending','sent','failed','cancelled'] }, limit: { type: 'integer', minimum: 1, maximum: 30 } }
    },
    execute: async ({ status, limit }, ctx) => ({
      reminders: db.listReminders({ chatId:ctx.chatId,requesterId:ctx.requesterId,status:status || 'pending',limit:limit || 20 })
    })
  });

  tools.push({
    name: 'cancel_reminder',
    description: 'Cancel a pending reminder owned by the current user in the current private chat.',
    scopes: ['personal'],
    schema: z.object({ reminderId: z.number().int().positive() }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { reminderId: { type: 'integer', minimum: 1 } }, required: ['reminderId']
    },
    execute: async ({ reminderId }, ctx) => ({
      cancelled: db.cancelReminder({ id:reminderId,chatId:ctx.chatId,requesterId:ctx.requesterId })
    })
  });

  return tools;
}

module.exports = { createP1Tools };
