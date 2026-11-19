const test = require('node:test');
const assert = require('node:assert/strict');
const { DocumentService } = require('../../../src/documents/document-service');

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

  for (const fn of [
    'IMAGE("https://tracker.example/pixel.png")',
    'IMPORTDATA("https://example.com/a.csv")',
    'IMPORTXML("https://example.com","//a")',
    'IMPORTHTML("https://example.com","table",1)',
    'IMPORTRANGE("sheet-id","A1:B2")',
    'INFO("directory")',
    'CELL("filename")'
  ]) {
    await assert.rejects(() => service().createXlsx({
      title: 'Test',
      headers: ['Value'],
      rows: [['x']],
      formulas: { A2: fn }
    }), /Formula ditolak/, `Expected ${fn} to be rejected`);
  }
});

test('extracts XLSX richText, Date, error, multi-line, and pipe cells without corrupting spreadsheet-analyzer columns', async () => {
  const ExcelJS = require('exceljs');
  const { analyzeSpreadsheetText, normalizeXlsxCellValue } = require('../../../src/documents/document-service');

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Transaksi');
  sheet.addRow(['Tanggal', 'Deskripsi', 'Catatan', 'Nominal', 'Status']);
  sheet.addRow([
    new Date('2026-11-19T08:30:00.000Z'),
    { richText: [{ text: 'Paket Server\n' }, { text: 'Tier A | Primary' }] },
    'Baris 1\r\nBaris 2 | Catatan',
    1500000,
    { error: '#DIV/0!' }
  ]);
  sheet.addRow([
    new Date('2026-11-20T09:00:00.000Z'),
    'Bandwidth',
    'Normal',
    500000,
    { formula: 'D2+D3', result: 2000000 }
  ]);

  const buffer = await workbook.xlsx.writeBuffer();
  const extracted = await service().extract({ buffer: Buffer.from(buffer), ext: '.xlsx' });

  assert.equal(extracted.includes('[object Object]'), false);
  assert.match(extracted, /2026-11-19T08:30:00\.000Z/);
  assert.match(extracted, /Paket Server Tier A │ Primary/);
  assert.match(extracted, /Baris 1 Baris 2 │ Catatan/);
  assert.match(extracted, /#DIV\/0!/);
  assert.match(extracted, /2000000/);

  const analysis = analyzeSpreadsheetText(extracted, { filename: 'transaksi.xlsx' });
  assert.equal(analysis.totalRows, 2);
  assert.deepEqual(analysis.headers, ['Tanggal', 'Deskripsi', 'Catatan', 'Nominal', 'Status']);
  const nominalCol = analysis.columns.find((c) => c.name === 'Nominal');
  assert.equal(nominalCol.inferredType, 'numeric');
  assert.equal(nominalCol.numericStats.sum, 2000000);
  assert.equal(analysis.sampleRows[0].values.Deskripsi, 'Paket Server Tier A │ Primary');
  assert.equal(analysis.sampleRows[0].values.Status, '#DIV/0!');

  // Direct helper coverage for nested formula result objects
  assert.equal(normalizeXlsxCellValue({ formula: 'TODAY()', result: new Date('2026-01-01T00:00:00.000Z') }), '2026-01-01T00:00:00.000Z');
  assert.equal(normalizeXlsxCellValue({ formula: '1/0', result: { error: '#DIV/0!' } }), '#DIV/0!');

  // CSV cell normalization preserves columns when quoted cells contain newlines or pipes
  const csvBuffer = Buffer.from('"Nama","Catatan","Nominal"\n"Item A","Baris 1\nBaris 2 | Info","250000"\n', 'utf8');
  const csvExtracted = await service().extract({ buffer: csvBuffer, ext: '.csv' });
  const csvAnalysis = analyzeSpreadsheetText(csvExtracted, { filename: 'csv-pipe.csv' });
  assert.equal(csvAnalysis.totalRows, 1);
  assert.equal(csvAnalysis.sampleRows[0].values.Catatan, 'Baris 1 Baris 2 │ Info');
  assert.equal(csvAnalysis.columns.find((c) => c.name === 'Nominal').numericStats.sum, 250000);
});

test('createPdf wraps oversized URLs and multi-line Markdown tables cleanly', async () => {
  const longToken = 'https://example.com/a-very-long-unbroken-segment-exceeding-normal-column-width-for-pdf-wrapping';
  const pdfBuffer = await service().createPdf({
    title: 'Uji PDF Wrapping',
    content: [
      `URL: ${longToken}`,
      '',
      '| Kolom A | Kolom B |',
      '|---|---|',
      `| ${longToken} | Teks multi kata yang cukup panjang agar terbungkus menjadi beberapa baris di dalam sel tabel |`
    ].join('\n')
  });

  const pdfText = pdfBuffer.toString('latin1');
  assert.equal(pdfBuffer.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(pdfText, /re S/);
  assert.match(pdfText, /beberapa baris/);
});
