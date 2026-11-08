const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../..');
const sourceRoot = path.join(projectRoot, 'src');

function listJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJs(full);
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
}

test('all outbound WhatsApp content sends are centralized in ResponseHandler', () => {
  const directSend = /\bwaha\.(?:sendText|sendFile|sendImage|sendVoice|sendVideo)\s*\(/;
  const offenders = [];
  for (const file of listJs(sourceRoot)) {
    const relative = path.relative(projectRoot, file).replace(/\\/g, '/');
    if (relative === 'src/channels/response-handler.js') continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (directSend.test(line)) offenders.push(`${relative}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('ResponseHandler exposes all Phase 1 outbound content types', () => {
  const { ResponseHandler, ResponseDeliveryError } = require('../../src/channels/response-handler');
  assert.equal(typeof ResponseHandler, 'function');
  assert.equal(typeof ResponseDeliveryError, 'function');
  for (const method of ['sendText','sendVoice','sendFile','sendImage','sendVideo','sendAssistantResponse','send']) {
    assert.equal(typeof ResponseHandler.prototype[method], 'function', `${method} must exist`);
  }
});

test('WAHA presence lifecycle remains available independently of content delivery', () => {
  const { WahaClient } = require('../../src/channels/waha/client');
  for (const method of ['sendSeen','startTyping','stopTyping']) {
    assert.equal(typeof WahaClient.prototype[method], 'function', `${method} must exist`);
  }
});

test('WhatsApp formatter remains connected to unified response delivery', () => {
  const responseHandlerSource = fs.readFileSync(
    path.join(sourceRoot, 'channels/response-handler.js'), 'utf8'
  );
  assert.match(responseHandlerSource, /formatWhatsAppText/);
  assert.match(responseHandlerSource, /async sendAssistantResponse/);
});

test('voice preference persistence and group workspace isolation remain implemented', () => {
  const dbSource = fs.readFileSync(path.join(sourceRoot, 'db/database.js'), 'utf8');
  assert.match(dbSource, /getChatOutputMode/);
  assert.match(dbSource, /setChatOutputMode/);
  assert.match(dbSource, /getDocumentFile/);
  assert.match(dbSource, /scope='group' AND chat_id=\?/);
});

test('error recovery keeps delivery uncertainty non-retryable', () => {
  const { classifyOperationalError } = require('../../src/utils/error-policy');
  const policy = classifyOperationalError({
    name: 'ResponseDeliveryError',
    deliveryStatus: 'uncertain',
    message: 'delivery could not be confirmed'
  });
  assert.equal(policy.category, 'delivery_uncertain');
  assert.equal(policy.retryable, false);
});
