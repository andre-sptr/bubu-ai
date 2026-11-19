async function buildXlsxBuffer({ title, headers = [], rows = [], formulas = {}, columnFormats = {}, sheets = [], freezeRows = 1 }) {
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

module.exports = { buildXlsxBuffer };
