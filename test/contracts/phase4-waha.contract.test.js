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
  const directPhase4Send = /\bwaha\.(?:sendText|sendFile|sendImage|sendVoice|sendVideo|sendReaction|sendPoll|sendLocation|sendContactVcard|sendLinkCustomPreview|editMessage|deleteMessage|forwardMessage)\s*\(/;
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
  for (const method of [
    'sendReaction',
    'sendPoll',
    'sendLocation',
    'sendContactVcard',
    'sendLinkPreview',
    'editMessage',
    'deleteMessage',
    'forwardMessage'
  ]) {
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
  assert.match(appSource, /updateBotIdentity/);
});

test('Phase 4 contract: WAHA tools enforce strict personal/group scope boundaries and external risk tagging', () => {
  const { createWahaTools } = require('../../src/channels/waha/waha-tools');
  const { registerAllTools } = require('../../src/agent/tool-registry');
  const tools = createWahaTools({ waha: {}, responseHandler: {}, approvalManager: {} });
  assert.equal(tools.length, 14);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  assert.deepEqual(byName.get_group_info.scopes, ['group']);
  for (const personalOnly of [
    'check_whatsapp_number',
    'get_waha_session_status',
    'list_recent_chat_messages',
    'send_whatsapp_poll',
    'send_whatsapp_location',
    'send_whatsapp_contact'
  ]) {
    assert.deepEqual(byName[personalOnly].scopes, ['personal'], `${personalOnly} must be personal-only`);
  }

  for (const bothScopes of [
    'react_to_message',
    'send_poll',
    'send_location',
    'send_contact_card',
    'send_link_preview',
    'edit_bot_message',
    'delete_bot_message'
  ]) {
    assert.deepEqual(byName[bothScopes].scopes, ['personal', 'group'], `${bothScopes} must support personal and group`);
    assert.equal(byName[bothScopes].risk, 'external', `${bothScopes} must declare risk: 'external'`);
  }

  for (const approvalTool of ['send_whatsapp_poll', 'send_whatsapp_location', 'send_whatsapp_contact']) {
    assert.equal(byName[approvalTool].risk, 'external', `${approvalTool} must declare risk: 'external'`);
    assert.equal(byName[approvalTool].requiresApproval, true, `${approvalTool} must require owner approval`);
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
  assert.equal(groupDefs.includes('list_recent_chat_messages'), false);
  assert.equal(groupDefs.includes('send_whatsapp_poll'), false);
  assert.equal(groupDefs.includes('send_whatsapp_location'), false);
  assert.equal(groupDefs.includes('send_whatsapp_contact'), false);
});

test('Phase 4 contract: splitWhatsAppMessage, cross-chat ApprovalManager types, auto-discovered botJid in hasBotMention, and phase4-regression.sh exist', () => {
  const { splitWhatsAppMessage } = require('../../src/channels/whatsapp-formatter');
  assert.equal(typeof splitWhatsAppMessage, 'function');
  const chunks = splitWhatsAppMessage('```js\nconst a = 1;\nconst b = 2;\n```', { maxChars: 20 });
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.equal((chunk.match(/```/g) || []).length % 2, 0, 'Code fences must remain balanced per chunk');
  }

  const { ApprovalManager, formatApprovalPrompt, APPROVED_TOOLS } = require('../../src/agent/approval-manager');
  assert.equal(typeof ApprovalManager, 'function');
  for (const toolName of [
    'send_whatsapp_message',
    'send_whatsapp_file',
    'send_whatsapp_poll',
    'send_whatsapp_location',
    'send_whatsapp_contact'
  ]) {
    assert.equal(APPROVED_TOOLS.has(toolName), true, `APPROVED_TOOLS must include ${toolName}`);
    const prompt = formatApprovalPrompt({
      id: 'ap-1',
      toolName,
      args: {
        targetId: '6281@c.us',
        message: 'Halo',
        filename: 'doc.pdf',
        question: 'Pilih?',
        options: ['A', 'B'],
        latitude: -6.2,
        longitude: 106.8,
        fullName: 'Budi',
        phoneNumber: '+628123456'
      }
    });
    assert.match(prompt, /\/approve ap-1/);
  }

  const { hasBotMention } = require('../../src/agent/message-processor');
  assert.equal(
    hasBotMention({ text: 'Halo', mentions: ['99887766:0@lid'] }, ['', '628999@c.us', '99887766@lid']),
    true
  );

  const regressionScript = path.join(projectRoot, 'scripts/phase4-regression.sh');
  assert.equal(fs.existsSync(regressionScript), true, 'scripts/phase4-regression.sh must exist');
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:phase4'], 'bash scripts/phase4-regression.sh');
});

test('Phase 4 contract: src/index.js configures Pino redact paths, WahaSessionMonitor, and startup syncFromWaha', () => {
  const indexSource = fs.readFileSync(path.join(sourceRoot, 'index.js'), 'utf8');
  assert.match(indexSource, /redact:/);
  assert.match(indexSource, /WahaSessionMonitor/);
  assert.match(indexSource, /syncFromWaha/);
  assert.match(indexSource, /app\.close\(\)/);
});
