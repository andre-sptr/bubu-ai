const test = require('node:test');
const assert = require('node:assert/strict');
const { DocumentService } = require('../../src/p1/documents/service');

function service() {
  return new DocumentService({
    db: {}, wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: '/tmp/bubu-document-generation-test',
    maxFileBytes: 5 * 1024 * 1024
  });
}

test('creates a DOCX buffer with professional document metadata and markdown table support', async () => {
  const buffer = await service().createDocx({
    title: 'Proposal Bisnis',
    subtitle: 'Rencana Pengembangan',
    documentType: 'business_proposal',
    author: 'Bubu AI',
    content: '# Ringkasan Eksekutif\nIsi proposal.\n\n| Item | Nilai |\n|---|---|\n| A | 100 |\n\n## Risiko\n- Risiko pertama\n1. Tindak lanjut'
  });
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 2).toString('hex'), '504b');
  assert.ok(buffer.length > 1000);
});

test('creates a multi-sheet XLSX workbook and retains formulas and number formats', async () => {
  const buffer = await service().createXlsx({
    title: 'Laporan',
    sheets: [
      {
        name: 'Penjualan',
        headers: ['Produk', 'Jumlah', 'Harga', 'Total'],
        rows: [['Kopi', 2, 15000, null]],
        formulas: { D2: 'B2*C2' },
        columnFormats: { C: '"Rp" #,##0', D: '"Rp" #,##0' }
      },
      {
        name: 'Ringkasan',
        headers: ['Metrik', 'Nilai'],
        rows: [['Total Penjualan', null]],
        formulas: { B2: 'SUM(Penjualan!D2:D2)' }
      }
    ]
  });
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 2).toString('hex'), '504b');
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Penjualan', 'Ringkasan']);
  assert.equal(workbook.getWorksheet('Penjualan').getCell('D2').value.formula, 'B2*C2');
  assert.equal(workbook.getWorksheet('Penjualan').getColumn('C').numFmt, '"Rp" #,##0');
});

test('rejects duplicate worksheet names and unsafe external formula references', async () => {
  await assert.rejects(() => service().createXlsx({
    title: 'Test',
    sheets: [
      { name: 'Data', headers: ['A'], rows: [] },
      { name: 'data', headers: ['A'], rows: [] }
    ]
  }), /Nama worksheet harus unik/);

  await assert.rejects(() => service().createXlsx({
    title: 'Test',
    headers: ['Value'],
    rows: [['x']],
    formulas: { A2: 'WEBSERVICE("https://example.com")' }
  }), /Formula ditolak/);
});
