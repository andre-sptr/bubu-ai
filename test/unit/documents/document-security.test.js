const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DocumentService,
  validateExtension,
  safeFilename,
  normalizeMediaUrl
} = require('../../../src/documents/document-service');

test('document extension allowlist rejects executable files', () => {
  assert.equal(validateExtension('report.pdf', 'application/pdf'), '.pdf');
  assert.throws(() => validateExtension('payload.exe', 'application/octet-stream'), /Format dokumen/);
  assert.throws(() => validateExtension('wrong.pdf', 'text/plain'), /MIME type/);
});

test('filename sanitization removes path traversal', () => {
  assert.equal(safeFilename('../../unsafe?.pdf'), 'unsafe_.pdf');
});

test('WAHA media URLs are constrained to the configured WAHA host', () => {
  const url = normalizeMediaUrl('http://localhost:3000/api/files/file.pdf', 'http://127.0.0.1:3001');
  assert.equal(url.origin, 'http://127.0.0.1:3001');
  assert.throws(() => normalizeMediaUrl('https://attacker.example/file.pdf', 'http://127.0.0.1:3001'), /host WAHA/);
});

test('generated files enforce extension, MIME type and configured size limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-generated-test-'));
  try {
    const service = new DocumentService({
      db: {}, wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
      storageDir: dir, maxFileBytes: 16
    });
    const file = await service.persistGenerated({
      buffer: Buffer.from('small-docx'),
      filename: 'proposal.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
    assert.equal(fs.existsSync(file.filePath), true);
    assert.equal(file.fileSize, 10);
    await assert.rejects(() => service.persistGenerated({
      buffer: Buffer.alloc(17),
      filename: 'large.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    }), /MAX_DOCUMENT_BYTES/);
    await assert.rejects(() => service.persistGenerated({
      buffer: Buffer.from('bad'),
      filename: 'wrong.docx',
      mimeType: 'application/pdf'
    }), /MIME type/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizes relative WAHA URLs and rejects credentials or non-HTTP schemes', () => {
  assert.equal(
    normalizeMediaUrl('/api/files/a.pdf', 'http://127.0.0.1:3001').toString(),
    'http://127.0.0.1:3001/api/files/a.pdf'
  );
  assert.throws(
    () => normalizeMediaUrl('http://user:pass@127.0.0.1:3001/api/a.pdf', 'http://127.0.0.1:3001'),
    /kredensial/
  );
  assert.throws(
    () => normalizeMediaUrl('file:///etc/passwd', 'http://127.0.0.1:3001'),
    /HTTP atau HTTPS/
  );
});

test('normalizes MIME parameters for document extensions', () => {
  assert.equal(validateExtension('report.pdf', 'application/pdf; charset=binary'), '.pdf');
  assert.equal(validateExtension('data.csv', 'text/csv; charset=utf-8'), '.csv');
  assert.throws(
    () => validateExtension('report.pdf', 'image/jpeg; charset=binary'),
    /MIME type/
  );
});

test('DocumentService downloads relative PDF URLs with redirects disabled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-document-download-'));
  let requestUrl;
  let requestOptions;
  const buffer = Buffer.from('%PDF-1.4\nfixture');

  const service = new DocumentService({
    db: {},
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000', apiKey: 'test-only' },
    storageDir: dir,
    maxFileBytes: 1024,
    httpClient: {
      get: async (url, options) => {
        requestUrl = url;
        requestOptions = options;
        return {
          status: 200,
          data: buffer,
          headers: { 'content-type': 'application/pdf; charset=binary', 'content-length': String(buffer.length) }
        };
      }
    }
  });

  try {
    const result = await service.downloadMedia('/api/files/report', 'report.pdf', 'application/pdf; charset=binary');
    assert.equal(requestUrl, 'http://127.0.0.1:3000/api/files/report');
    assert.equal(requestOptions.maxRedirects, 0);
    assert.equal(result.ext, '.pdf');
    assert.equal(fs.existsSync(result.filePath), true);
    await fs.promises.rm(result.filePath, { force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DocumentService rejects redirect and MIME mismatch before writing file', async () => {
  for (const response of [
    { status: 302, data: Buffer.from('%PDF-1.4'), headers: { location: 'https://attacker.example/x' } },
    { status: 200, data: Buffer.from('%PDF-1.4'), headers: { 'content-type': 'image/jpeg' } }
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-document-reject-'));
    const service = new DocumentService({
      db: {},
      wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
      storageDir: dir,
      maxFileBytes: 1024,
      httpClient: { get: async () => response }
    });
    try {
      await assert.rejects(
        () => service.downloadMedia('/api/files/report', 'report.pdf', 'application/pdf'),
        response.status === 302 ? /HTTP 302/ : /Content-Type/
      );
      assert.equal(fs.readdirSync(dir).length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('DocumentService infers a missing filename extension from the declared MIME', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-document-no-name-'));
  const buffer = Buffer.from('%PDF-1.4\nfixture');
  const service = new DocumentService({
    db: {},
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000' },
    storageDir: dir,
    maxFileBytes: 1024,
    httpClient: {
      get: async () => ({
        status: 200,
        data: buffer,
        headers: { 'content-type': 'application/pdf' }
      })
    }
  });
  try {
    const result = await service.downloadMedia('/api/files/opaque-id', '', 'application/pdf');
    assert.equal(result.ext, '.pdf');
    assert.equal(result.filename, 'document.pdf');
    await fs.promises.rm(result.filePath, { force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DocumentService.downloadMedia sanitizes AxiosError credentials while preserving status and code', async () => {
  const axios = require('axios');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-doc-axios-sanitize-'));
  const service = new DocumentService({
    db: {},
    wahaConfig: { baseUrl: 'http://127.0.0.1:3000', apiKey: 'secret-waha-doc-key' },
    storageDir: dir,
    httpClient: {
      get: async () => {
        throw new axios.AxiosError(
          'Request failed with status code 403',
          'ERR_BAD_REQUEST',
          { headers: { 'X-Api-Key': 'secret-waha-doc-key' } },
          { socket: true },
          { status: 403, config: { headers: { 'X-Api-Key': 'secret-waha-doc-key' } } }
        );
      }
    }
  });
  try {
    await assert.rejects(
      () => service.downloadMedia('/api/files/secret.pdf', 'secret.pdf', 'application/pdf'),
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.response?.status, 403);
        assert.equal(err.code, 'ERR_BAD_REQUEST');
        assert.equal(err.config, undefined);
        assert.equal(err.request, undefined);
        assert.equal(JSON.stringify(err).includes('secret-waha-doc-key'), false);
        return true;
      }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('safeFilename keeps document extension when stem exceeds 100 chars and rejects dot names', () => {
  const longName = `${'Proposal_Bisnis_Panjang_'.repeat(6)}.docx`;
  const clean = safeFilename(longName);
  assert.ok(clean.length <= 100);
  assert.equal(clean.endsWith('.docx'), true);
  assert.equal(safeFilename('.'), 'document');
  assert.equal(safeFilename('..'), 'document');
});
