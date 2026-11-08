const crypto = require('node:crypto');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { ResponseHandler } = require('../channels/response-handler');
const { z } = require('zod');

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
    description: 'Read an uploaded document by its document ID from the current workspace. Returns extracted text.',
    scopes: ['personal','group'],
    schema: z.object({ documentId: z.string().uuid() }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { documentId: { type: 'string', description: 'Document UUID returned by list_documents or upload processing' } },
      required: ['documentId']
    },
    execute: async ({ documentId }, ctx) => {
      const doc = db.getDocument(
        documentId,ctx.scope,
        ctx.scope === 'personal' ? ctx.requesterId : null,
        ctx.scope === 'group' ? ctx.chatId : null
      );
      if (!doc) throw new Error('Dokumen tidak ditemukan pada workspace ini.');
      return { documentId: doc.id, filename: doc.filename, mimeType: doc.mime_type, text: doc.extracted_text };
    }
  });

  tools.push({
    name: 'search_document',
    description: 'Search for terms across uploaded documents in the current workspace and return relevant excerpts.',
    scopes: ['personal','group'],
    schema: z.object({ query: z.string().min(2).max(300), limit: z.number().int().min(1).max(10).optional() }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['query']
    },
    execute: async ({ query, limit }, ctx) => ({
      matches: db.searchDocuments({
        scope: ctx.scope,
        ownerId: ctx.scope === 'personal' ? ctx.requesterId : null,
        chatId: ctx.scope === 'group' ? ctx.chatId : null,
        query, limit: limit || 5
      })
    })
  });

  tools.push({
    name: 'analyze_spreadsheet',
    description: 'Read a previously uploaded XLSX, XLSM or CSV document and return its extracted rows for analysis.',
    scopes: ['personal','group'],
    schema: z.object({ documentId: z.string().uuid(), question: z.string().max(500).optional() }).strict(),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        documentId: { type: 'string' },
        question: { type: 'string' }
      }, required: ['documentId']
    },
    execute: async ({ documentId, question }, ctx) => {
      const doc = db.getDocument(
        documentId,ctx.scope,
        ctx.scope === 'personal' ? ctx.requesterId : null,
        ctx.scope === 'group' ? ctx.chatId : null
      );
      if (!doc || !['.xlsx','.xlsm','.csv'].includes(path.extname(doc.filename).toLowerCase())) {
        throw new Error('Spreadsheet tidak ditemukan atau formatnya bukan XLSX/XLSM/CSV.');
      }
      return { filename: doc.filename, question: question || null, extractedRows: doc.extracted_text };
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
    description: 'List the professional DOCX and XLSX document templates Bubu can generate. Use this when the user asks what kinds of files or templates are available.',
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
      note: 'Bubu dapat menyesuaikan struktur dan isi dokumen. Data yang tidak diberikan harus ditandai sebagai asumsi atau dibiarkan kosong, bukan dikarang.'
    })
  });

  tools.push({
    name: 'create_document',
    description: `Create a professionally formatted DOCX file for the current workspace (personal DM or group). Choose documentType from: ${documentTypes.join(', ')}. Write complete, useful content with Markdown headings, bullet/numbered lists and pipe tables when appropriate. Include a clear title, executive summary or purpose, structured sections, and conclusion/next steps when suitable. Do not invent facts, names, dates, amounts or legal requirements; label assumptions and placeholders. In group scope, automatically send the generated file to the same originating group after verifying its group-scoped database record and storage path. Never choose another destination. In personal scope, ask owner approval before sending the file.`,
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
        content: { type: 'string', maxLength: 30000, description: 'Full document body. Markdown headings, bullet lists, numbered lists, and pipe tables are supported.' },
        documentType: { type: 'string', enum: documentTypes },
        subtitle: { type: 'string', maxLength: 250 },
        author: { type: 'string', maxLength: 120 },
        filename: { type: 'string', maxLength: 100, description: 'Optional .docx filename' }
      }, required: ['title','content']
    },
    risk: 'external',
    execute: async ({ title, content, documentType, subtitle, author, filename }, ctx) => {
      assertGroupContext(ctx);
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
