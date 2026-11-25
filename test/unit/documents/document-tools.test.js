const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDocumentTools } = require('../../../src/documents/document-tools');

function harness({ sendFileError = null } = {}) {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-group-delivery-'));
  const saved = [];
  const approvalCalls = [];
  const sendCalls = [];
  const generated = { docx: 0, xlsx: 0, xlsxArgs: null };
  const documents = new Map();
  const db = {
    saveDocument: (doc) => {
      saved.push(doc);
      const record = { id: doc.id, scope: doc.scope, filename: doc.filename };
      documents.set(doc.id, {
        id: doc.id, scope: doc.scope, owner_id: doc.ownerId || null, chat_id: doc.chatId || null,
        filename: doc.filename, mime_type: doc.mimeType,
        file_path: doc.filePath, file_size: doc.fileSize
      });
      return record;
    },
    getDocumentFile: (id, scope, ownerId, chatId) => {
      const record = documents.get(id);
      if (!record || record.scope !== scope) return null;
      return scope === 'group'
        ? (record.chat_id === chatId ? record : null)
        : (record.owner_id === ownerId ? record : null);
    }
  };
  const documentService = {
    storageDir,
    maxFileBytes: 5 * 1024 * 1024,
    createDocx: async (args) => { generated.docx++; generated.docxArgs = args; return Buffer.from('docx'); },
    createXlsx: async (args) => { generated.xlsx++; generated.xlsxArgs = args; return Buffer.from('xlsx'); },
    persistGenerated: async ({ buffer, filename, mimeType }) => {
      const filePath = path.join(storageDir, filename);
      fs.writeFileSync(filePath, buffer);
      return {
        id: `file-${generated.docx + generated.xlsx}`,
        filePath,
        filename,
        mimeType,
        fileSize: buffer.length
      };
    }
  };
  const waha = {
    sendFile: async (filePath, chatId, options) => {
      sendCalls.push({ filePath, chatId, options });
      if (sendFileError) throw sendFileError;
      return { id: `waha-message-${sendCalls.length}` };
    }
  };
  const approvalManager = {
    create: async (args) => { approvalCalls.push(args); return { pendingApproval: true, approvalId: 'approval-1', prompt: 'Approve file' }; }
  };
  const tools = createDocumentTools({ db, documentService, webSearch: null, webFetch: {}, approvalManager, waha });
  return {
    tools, saved, approvalCalls, generated, sendCalls, storageDir,
    cleanup: () => fs.rmSync(storageDir, { recursive: true, force: true })
  };
}

test('document template catalogue is available in group and personal workspaces', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const tool = h.tools.find((item) => item.name === 'list_document_templates');
  assert.deepEqual(tool.scopes, ['personal', 'group']);
  const result = await tool.execute({});
  assert.ok(result.docx.some((item) => item.type === 'sop'));
  assert.ok(result.docx.some((item) => item.type === 'meeting_minutes'));
  assert.ok(result.xlsx.some((item) => item.type === 'financial_budget'));
});

test('group create_document generates, stores and automatically sends a group-scoped DOCX', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const tool = h.tools.find((item) => item.name === 'create_document');
  assert.deepEqual(tool.scopes, ['personal', 'group']);
  const result = await tool.execute({
    title: 'SOP Operasional',
    content: '# Tujuan\nIsi SOP',
    documentType: 'sop',
    filename: 'sop-operasional.docx'
  }, { taskId: 'task-group-doc', chatId: '120363000000000000@g.us', requesterId: 'member@c.us', scope: 'group' });

  assert.equal(result.created, true);
  assert.equal(result.workspace, 'group');
  assert.equal(result.deliveryStatus, 'sent');
  assert.equal(h.saved[0].scope, 'group');
  assert.equal(h.saved[0].chatId, '120363000000000000@g.us');
  assert.equal(h.saved[0].ownerId, null);
  assert.equal(h.approvalCalls.length, 0);
  assert.equal(h.sendCalls.length, 1);
  assert.equal(tool.risk, 'external');
  assert.equal(h.sendCalls[0].chatId, '120363000000000000@g.us');
  assert.equal(h.sendCalls[0].options.filename, 'sop-operasional.docx');
  assert.match(h.sendCalls[0].options.caption, /SOP Operasional/);
  assert.equal(h.generated.docxArgs.documentType, 'sop');
});

test('personal create_document delivers directly to owner self-DM and keeps approval for cross-chat sends', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const tool = h.tools.find((item) => item.name === 'create_document');
  const directRes = await tool.execute({
    title: 'Memo',
    content: 'Isi memo',
    documentType: 'memo'
  }, { taskId: 'task-personal-doc', chatId: 'owner@c.us', requesterId: 'owner@c.us', scope: 'personal' });

  assert.equal(directRes.created, true);
  assert.equal(directRes.workspace, 'personal');
  assert.equal(directRes.deliveryStatus, 'sent');
  assert.equal(h.saved[0].scope, 'personal');
  assert.equal(h.saved[0].ownerId, 'owner@c.us');
  assert.equal(h.approvalCalls.length, 0);
  assert.equal(h.sendCalls.length, 1);
  assert.equal(h.sendCalls[0].chatId, 'owner@c.us');

  const crossRes = await tool.execute({
    title: 'Memo Eksternal',
    content: 'Isi memo lain',
    documentType: 'memo'
  }, { taskId: 'task-cross-doc', chatId: 'other@c.us', requesterId: 'owner@c.us', scope: 'personal' });

  assert.equal(crossRes.pendingApproval, true);
  assert.equal(h.approvalCalls.length, 1);
  assert.equal(h.sendCalls.length, 1);
});

test('group create_spreadsheet supports multiple sheets and stores group-scoped XLSX', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const tool = h.tools.find((item) => item.name === 'create_spreadsheet');
  const args = {
    title: 'Laporan Keuangan',
    sheets: [{
      name: 'Ringkasan',
      headers: ['Item', 'Nilai'],
      rows: [['Pendapatan', 1000000]],
      formulas: { B3: 'SUM(B2:B2)' },
      columnFormats: { B: '"Rp" #,##0' }
    }]
  };
  const result = await tool.execute(args, {
    taskId: 'task-group-xlsx', chatId: '120363000000000000@g.us', requesterId: 'member@c.us', scope: 'group'
  });
  assert.equal(result.created, true);
  assert.equal(result.deliveryStatus, 'sent');
  assert.equal(h.generated.xlsxArgs.sheets.length, 1);
  assert.equal(h.generated.xlsxArgs.sheets[0].formulas.B3, 'SUM(B2:B2)');
  assert.equal(h.saved[0].scope, 'group');
  assert.equal(h.saved[0].filename, 'Laporan Keuangan.xlsx');
  assert.equal(h.approvalCalls.length, 0);
  assert.equal(h.sendCalls.length, 1);
  assert.equal(h.sendCalls[0].chatId, '120363000000000000@g.us');
  assert.equal(h.sendCalls[0].options.filename, 'Laporan Keuangan.xlsx');
});

test('spreadsheet tool rejects rows wider than their header', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const tool = h.tools.find((item) => item.name === 'create_spreadsheet');
  await assert.rejects(() => tool.execute({
    title: 'Bad sheet', headers: ['A'], rows: [['A', 'B']]
  }, { taskId: 'task-bad', chatId: '120363000000000000@g.us', requesterId: 'member@c.us', scope: 'group' }), /melebihi jumlah header/);
});


test('group file delivery failure is reported as uncertain and is not retried inside the tool', async (t) => {
  const h = harness({ sendFileError: new Error('WAHA request timed out') });
  t.after(h.cleanup);
  const tool = h.tools.find((item) => item.name === 'create_document');
  const result = await tool.execute({
    title: 'Proposal',
    content: '# Proposal'
  }, {
    taskId: 'task-group-send-uncertain',
    chatId: '120363000000000000@g.us',
    requesterId: 'member@c.us',
    scope: 'group'
  });

  assert.equal(result.created, true);
  assert.equal(result.deliveryStatus, 'uncertain');
  assert.equal(h.saved.length, 1);
  assert.equal(h.sendCalls.length, 1);
  assert.match(result.message, /tidak mengirim ulang otomatis/);
});

test('group file delivery refuses non-group targets before generating a file', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const tool = h.tools.find((item) => item.name === 'create_document');
  await assert.rejects(() => tool.execute({
    title: 'Proposal',
    content: '# Proposal'
  }, {
    taskId: 'task-invalid-group',
    chatId: '628111111111@c.us',
    requesterId: 'member@c.us',
    scope: 'group'
  }), /ID grup WhatsApp yang valid/);
  assert.equal(h.generated.docx, 0);
  assert.equal(h.sendCalls.length, 0);
});

test('analyze_spreadsheet omits redundant raw extracted_text so analysis survives 12KB truncation', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const rows = ['Item,Nominal'];
  for (let i = 1; i <= 1500; i++) {
    rows.push(`Item-${String(i).padStart(4, '0')},${i * 1000}`);
  }
  const bigCsv = rows.join('\n');
  assert.ok(bigCsv.length > 20000);

  const docId = '33333333-3333-4333-8333-333333333333';
  const tools = createDocumentTools({
    db: {
      getDocument: () => ({
        id: docId,
        filename: 'big.csv',
        extracted_text: bigCsv
      })
    },
    documentService: { storageDir: h.storageDir, maxFileBytes: 5 * 1024 * 1024 },
    approvalManager: { create: async () => ({}) },
    waha: { sendFile: async () => ({}) }
  });

  const analyzeTool = tools.find((item) => item.name === 'analyze_spreadsheet');
  const result = await analyzeTool.execute(
    { documentId: docId, question: 'Berapa total Nominal?' },
    { scope: 'personal', requesterId: 'owner@c.us', chatId: 'owner@c.us' }
  );

  assert.equal('extractedRows' in result, false);
  const truncated = JSON.parse(JSON.stringify(result).slice(0, 12000) + '');
  assert.equal(typeof result.analysis, 'object');
  assert.equal(result.analysis.totalRows, 1500);
  const nominalCol = result.analysis.columns.find((c) => c.name === 'Nominal');
  assert.equal(nominalCol.numericStats.count, 1500);
  const serialized = JSON.stringify(result);
  assert.ok(serialized.indexOf('"analysis"') < 200);
  assert.ok(serialized.slice(0, 12000).includes('"numericStats"'));
  assert.ok(truncated.documentId === docId);
});

test('delete_document fallback enforces storageDir containment and group WAHA errors are logged', async (t) => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-doc-tools-hardening-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-doc-tools-outside-'));
  t.after(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  const outsideFile = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outsideFile, 'keep-me');
  const insideFile = path.join(storageDir, 'inside.txt');
  fs.writeFileSync(insideFile, 'delete-me');

  const warnLogs = [];
  const docMap = new Map([
    ['44444444-4444-4444-8444-444444444444', { id: '44444444-4444-4444-8444-444444444444', scope: 'personal', filename: 'outside.txt', file_path: outsideFile }],
    ['55555555-5555-4555-8555-555555555555', { id: '55555555-5555-4555-8555-555555555555', scope: 'personal', filename: 'inside.txt', file_path: insideFile }]
  ]);

  const tools = createDocumentTools({
    db: {
      deleteDocument: (id) => {
        const rec = docMap.get(id) || null;
        docMap.delete(id);
        return rec;
      },
      saveDocument: (doc) => ({ id: doc.id, scope: doc.scope, filename: doc.filename }),
      getDocumentFile: (id) => ({
        id, scope: 'group', chat_id: '120363000000000000@g.us',
        filename: 'doc.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        file_path: insideFile, file_size: 9
      })
    },
    documentService: {
      storageDir,
      maxFileBytes: 1024 * 1024,
      createDocx: async () => Buffer.from('docx-data'),
      persistGenerated: async ({ buffer, filename, mimeType }) => {
        const fp = path.join(storageDir, filename);
        fs.writeFileSync(fp, buffer);
        return { id: '66666666-6666-4666-8666-666666666666', filePath: fp, filename, mimeType, fileSize: buffer.length };
      }
    },
    approvalManager: { create: async () => ({}) },
    waha: {
      sendFile: async () => { throw new Error('WAHA upload timed out'); }
    },
    logger: { warn: (meta, msg) => warnLogs.push({ meta, msg }) }
  });

  const deleteTool = tools.find((item) => item.name === 'delete_document');
  const outsideRes = await deleteTool.execute(
    { documentId: '44444444-4444-4444-8444-444444444444' },
    { scope: 'personal', requesterId: 'owner@c.us', chatId: 'owner@c.us' }
  );
  assert.equal(outsideRes.fileRemoved, false);
  assert.equal(fs.existsSync(outsideFile), true);

  const insideRes = await deleteTool.execute(
    { documentId: '55555555-5555-4555-8555-555555555555' },
    { scope: 'personal', requesterId: 'owner@c.us', chatId: 'owner@c.us' }
  );
  assert.equal(insideRes.fileRemoved, true);
  assert.equal(fs.existsSync(insideFile), false);

  fs.writeFileSync(insideFile, 'docx-data');
  const createTool = tools.find((item) => item.name === 'create_document');
  const groupRes = await createTool.execute(
    { title: 'Tes Log', content: 'Isi dokumen' },
    { taskId: 't1', scope: 'group', chatId: '120363000000000000@g.us', requesterId: 'member@c.us' }
  );
  assert.equal(groupRes.deliveryStatus, 'uncertain');
  assert.equal(warnLogs.some((entry) => /Group document delivery failed/.test(entry.msg)), true);
});
