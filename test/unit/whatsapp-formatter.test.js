const test = require('node:test');
const assert = require('node:assert/strict');
const { formatWhatsAppText } = require('../../src/channels/whatsapp-formatter');

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
