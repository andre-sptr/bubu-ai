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

test('Phase 4 contract: Phase 4 outbound sends are centralized in ResponseHandler', () => {
  const directPhase4Send = /\bwaha\.(?:sendReaction|sendPoll|sendLocation|sendContactVcard)\s*\(/;
  const offenders = [];
  for (const file of listJs(sourceRoot)) {
    const relative = path.relative(projectRoot, file).replace(/\\/g, '/');
    if (relative === 'src/channels/response-handler.js') continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (directPhase4Send.test(line)) offenders.push(`${relative}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);

  const { ResponseHandler } = require('../../src/channels/response-handler');
  for (const method of ['sendReaction', 'sendPoll', 'sendLocation', 'sendContactVcard']) {
    assert.equal(typeof ResponseHandler.prototype[method], 'function', `${method} must exist on ResponseHandler`);
  }
});

test('Phase 4 contract: WahaClient contains zero blocking fs.readFileSync calls', () => {
  const clientSource = fs.readFileSync(path.join(sourceRoot, 'channels/waha/client.js'), 'utf8');
  assert.equal(/\breadFileSync\b/.test(clientSource), false);
});

test('Phase 4 contract: app.js uses timingSafeEqual for webhook verification and handles session.status', () => {
  const appSource = fs.readFileSync(path.join(sourceRoot, 'app.js'), 'utf8');
  assert.match(appSource, /\btimingSafeEqual\b/);
  assert.match(appSource, /session\.status/);
});

test('Phase 4 contract: WAHA tools enforce strict personal/group scope boundaries and external risk tagging', () => {
  const { createWahaTools } = require('../../src/channels/waha/waha-tools');
  const { registerAllTools } = require('../../src/agent/tool-registry');
  const tools = createWahaTools({ waha: {}, responseHandler: {} });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  assert.deepEqual(byName.get_group_info.scopes, ['group']);
  assert.deepEqual(byName.check_whatsapp_number.scopes, ['personal']);
  assert.deepEqual(byName.get_waha_session_status.scopes, ['personal']);

  for (const outboundName of ['react_to_message', 'send_poll', 'send_location', 'send_contact_card']) {
    assert.equal(byName[outboundName].risk, 'external', `${outboundName} must declare risk: 'external'`);
  }

  const registry = registerAllTools({
    db: {},
    approvalManager: {},
    waha: {},
    responseHandler: {},
    memoryService: null,
    documentService: {},
    webSearch: null,
    webFetch: null
  });
  const personalDefs = registry.definitions('personal').map((d) => d.function.name);
  const groupDefs = registry.definitions('group').map((d) => d.function.name);
  assert.equal(personalDefs.includes('get_group_info'), false);
  assert.equal(groupDefs.includes('check_whatsapp_number'), false);
  assert.equal(groupDefs.includes('get_waha_session_status'), false);
});

test('Phase 4 contract: src/index.js configures Pino redact paths and WahaSessionMonitor', () => {
  const indexSource = fs.readFileSync(path.join(sourceRoot, 'index.js'), 'utf8');
  assert.match(indexSource, /redact:/);
  assert.match(indexSource, /WahaSessionMonitor/);
  assert.match(indexSource, /app\.close\(\)/);
});
