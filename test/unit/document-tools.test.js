const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createP1Tools } = require('../../src/p1/tools');

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
        id: doc.id, scope: doc.scope, chat_id: doc.chatId,
        filename: doc.filename, mime_type: doc.mimeType,
        file_path: doc.filePath, file_size: doc.fileSize
      });
      return record;
    },
    getDocumentFile: (id, scope, ownerId, chatId) => {
      const record = documents.get(id);
      return record && record.scope === scope && record.chat_id === chatId ? record : null;
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
  const tools = createP1Tools({ db, documentService, webSearch: null, webFetch: {}, approvalManager, waha });
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

test('personal create_document retains owner approval workflow', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const tool = h.tools.find((item) => item.name === 'create_document');
  const result = await tool.execute({
    title: 'Memo',
    content: 'Isi memo',
    documentType: 'memo'
  }, { taskId: 'task-personal-doc', chatId: 'owner@c.us', requesterId: 'owner@c.us', scope: 'personal' });

  assert.equal(result.pendingApproval, true);
  assert.equal(h.saved[0].scope, 'personal');
  assert.equal(h.saved[0].ownerId, 'owner@c.us');
  assert.equal(h.approvalCalls.length, 1);
  assert.equal(h.sendCalls.length, 0);
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
