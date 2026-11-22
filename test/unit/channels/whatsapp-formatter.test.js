const test = require('node:test');
const assert = require('node:assert/strict');
const { formatWhatsAppText, splitWhatsAppMessage } = require('../../../src/channels/whatsapp-formatter');

test('converts Markdown headings to WhatsApp bold', () => {
  assert.equal(
    formatWhatsAppText('# Ringkasan\n## Hasil Analisis\n### Catatan'),
    '*Ringkasan*\n*Hasil Analisis*\n*Catatan*'
  );
});

test('converts Markdown bold, italic and strikethrough to WhatsApp syntax', () => {
  assert.equal(
    formatWhatsAppText('**Penting** dan *miring* serta ~~hapus~~'),
    '*Penting* dan _miring_ serta ~hapus~'
  );
  assert.equal(formatWhatsAppText('__Tebal__ dan _miring_'), '*Tebal* dan _miring_');
});

test('converts unordered and ordered lists to mobile-friendly WhatsApp lists', () => {
  assert.equal(
    formatWhatsAppText('- Satu\n* Dua\n+ Tiga\n\n1) Pertama\n2. Kedua'),
    '• Satu\n• Dua\n• Tiga\n\n1. Pertama\n2. Kedua'
  );
});

test('converts Markdown tables into readable labeled rows', () => {
  const input = '| Item | Harga |\n|---|---:|\n| Kopi | Rp20.000 |\n| Teh | Rp15.000 |';
  assert.equal(
    formatWhatsAppText(input),
    '*Item • Harga*\n1. *Item:* Kopi\n*Harga:* Rp20.000\n2. *Item:* Teh\n*Harga:* Rp15.000'
  );
});

test('converts Markdown links into readable labels and actual URLs', () => {
  assert.equal(
    formatWhatsAppText('Baca [dokumentasi](https://example.com/docs).'),
    'Baca dokumentasi: https://example.com/docs.'
  );
});

test('preserves fenced code blocks exactly and removes language hint', () => {
  const input = 'Contoh:\n```javascript\nconst x = **2**;\nconsole.log(`x`);\n```\nSelesai.';
  assert.equal(
    formatWhatsAppText(input),
    'Contoh:\n```\nconst x = **2**;\nconsole.log(`x`);\n```\nSelesai.'
  );
});

test('preserves inline code while formatting surrounding text', () => {
  assert.equal(
    formatWhatsAppText('Gunakan **npm test** dan jalankan `node --check app.js`.'),
    'Gunakan *npm test* dan jalankan `node --check app.js`.'
  );
});

test('converts blockquotes and horizontal rules', () => {
  assert.equal(
    formatWhatsAppText('> Catatan penting\n\n---\n\nLanjut.'),
    '> Catatan penting\n\n━━━━━━━━━━━━\n\nLanjut.'
  );
});

test('normalizes excessive blank lines and preserves URLs and emoji', () => {
  assert.equal(
    formatWhatsAppText('Halo 👋\n\n\nKunjungi https://example.com\n\n\nSelesai.'),
    'Halo 👋\n\nKunjungi https://example.com\n\nSelesai.'
  );
});

test('handles empty and non-string inputs safely', () => {
  assert.equal(formatWhatsAppText(null), '');
  assert.equal(formatWhatsAppText(undefined), '');
  assert.equal(formatWhatsAppText(123), '123');
});

test('does not alter Markdown-like syntax inside fenced code', () => {
  const input = '```text\n**bold**\n- item\n| A | B |\n```';
  const result = formatWhatsAppText(input);
  assert.ok(result.includes('**bold**'));
  assert.ok(result.includes('- item'));
  assert.ok(result.includes('| A | B |'));
});


test('preserves existing standalone WhatsApp bold such as approval headings', () => {
  assert.equal(
    formatWhatsAppText('*Konfirmasi pengiriman file Bubu*\nBalas /approve abc123.'),
    '*Konfirmasi pengiriman file Bubu*\nBalas /approve abc123.'
  );
});

test('literal legacy placeholder sentinels in input text do not collide with internal stash tokens', () => {
  const input = 'Teks \u0001BUBU_MD_0\u0002 dengan **tebal** dan `kode` serta \u0001BUBU_MD_1\u0002.';
  assert.equal(
    formatWhatsAppText(input),
    'Teks \u0001BUBU_MD_0\u0002 dengan *tebal* dan `kode` serta \u0001BUBU_MD_1\u0002.'
  );
});

test('splitWhatsAppMessage returns single-element array when text is within maxChars', () => {
  assert.deepEqual(splitWhatsAppMessage(null), ['']);
  assert.deepEqual(splitWhatsAppMessage(undefined), ['']);
  assert.deepEqual(splitWhatsAppMessage('Halo Bubu', { maxChars: 20 }), ['Halo Bubu']);
  const exact = 'a'.repeat(50);
  assert.deepEqual(splitWhatsAppMessage(exact, { maxChars: 50 }), [exact]);
});

test('splitWhatsAppMessage prefers paragraph, line, then space boundaries and honors maxChars', () => {
  const paraPreferred = 'First paragraph.\n\nSecond paragraph line one.\nSecond paragraph line two.';
  const paraChunks = splitWhatsAppMessage(paraPreferred, { maxChars: 55 });
  assert.deepEqual(paraChunks, [
    'First paragraph.',
    'Second paragraph line one.\nSecond paragraph line two.'
  ]);

  const linePreferred = 'Alpha line one\nBeta line two\nGamma line three';
  const lineChunks = splitWhatsAppMessage(linePreferred, { maxChars: 30 });
  assert.deepEqual(lineChunks, [
    'Alpha line one\nBeta line two',
    'Gamma line three'
  ]);

  const wordSplit = 'one two three four five six seven';
  const wordChunks = splitWhatsAppMessage(wordSplit, { maxChars: 15 });
  assert.deepEqual(wordChunks, ['one two three', 'four five six', 'seven']);
  for (const chunk of wordChunks) {
    assert.ok(chunk.length <= 15, `Expected chunk <= 15 chars, got ${chunk.length}`);
  }

  const unbroken = 'a'.repeat(25);
  const hardChunks = splitWhatsAppMessage(unbroken, { maxChars: 10 });
  assert.deepEqual(hardChunks, ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
});

test('splitWhatsAppMessage preserves balanced fenced code blocks across chunks within maxChars', () => {
  const formatted = [
    'Ringkasan:',
    '```',
    'const alpha = 1111;',
    'const beta = 2222;',
    'const gamma = 3333;',
    'const delta = 4444;',
    '```',
    'Selesai.'
  ].join('\n');

  const chunks = splitWhatsAppMessage(formatted, { maxChars: 55 });
  assert.ok(chunks.length >= 2, 'Expected code block message to split into multiple chunks');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 55, `Chunk exceeded maxChars (got ${chunk.length}): ${chunk}`);
    const fenceCount = (chunk.match(/```/g) || []).length;
    assert.equal(fenceCount % 2, 0, `Unbalanced code fence in chunk:\n${chunk}`);
    assert.equal(/```\s*```/.test(chunk), false, `Empty code block produced in chunk:\n${chunk}`);
  }
  const combined = chunks.join('\n');
  for (const token of ['Ringkasan:', 'alpha = 1111;', 'beta = 2222;', 'gamma = 3333;', 'delta = 4444;', 'Selesai.']) {
    assert.ok(combined.includes(token), `Missing token ${token}`);
  }
});

test('Stage 1: formatWhatsAppText preserves math multiplication, intraword asterisks, and glob patterns', () => {
  assert.equal(formatWhatsAppText('Hitung 2 * 3 * 4 = 24'), 'Hitung 2 * 3 * 4 = 24');
  assert.equal(formatWhatsAppText('Variabel foo*bar*baz tetap utuh'), 'Variabel foo*bar*baz tetap utuh');
  assert.equal(formatWhatsAppText('Filter *.js dan *.ts saja'), 'Filter *.js dan *.ts saja');
  assert.equal(formatWhatsAppText('Ini *miring* dan (*catatan*)'), 'Ini _miring_ dan (_catatan_)');
});
