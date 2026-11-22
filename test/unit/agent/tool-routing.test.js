const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAllTools, selectToolGroups, ALL_TOOL_GROUPS, REQUEST_TOOL_GROUP_NAME } = require('../../../src/agent/tool-registry');

function makeRegistry() {
  return registerAllTools({
    db: {},
    approvalManager: {},
    waha: {},
    responseHandler: {},
    sessionMonitor: null,
    memoryService: null,
    documentService: {},
    webSearch: { search: async () => [] },
    webFetch: { fetch: async () => ({}) }
  });
}

test('Stage 2: greeting fast-path loads 0 tools and dynamic routing trims schema size by >50%', () => {
  const registry = makeRegistry();
  const fullPersonal = registry.definitions('personal');
  const fullGroup = registry.definitions('group');
  assert.ok(fullPersonal.length >= 40);
  assert.ok(fullGroup.length >= 30);

  const greetingPersonal = registry.definitionsForContext('personal', { task: 'greeting', text: 'Halo' });
  assert.deepEqual(greetingPersonal, []);

  const greetingGroup = registry.definitionsForContext('group', { task: 'greeting', text: 'Pagi' });
  assert.deepEqual(greetingGroup, []);

  const generalPersonal = registry.definitionsForContext('personal', { task: 'general_chat', text: 'Bagaimana kabarmu?' });
  const generalNames = generalPersonal.map((d) => d.function.name);
  assert.equal(generalNames.includes(REQUEST_TOOL_GROUP_NAME), true);
  assert.equal(generalNames.includes('search_memory'), true);
  assert.equal(generalNames.includes('save_note'), false);
  assert.equal(generalNames.includes('search_notes'), false);
  assert.equal(generalNames.includes('create_pdf'), false);
  assert.equal(generalNames.includes('web_search'), false);

  const fullChars = JSON.stringify(fullPersonal).length;
  const generalChars = JSON.stringify(generalPersonal).length;
  assert.ok(generalChars < fullChars * 0.45, `Expected >55% schema savings, got ${generalChars} vs ${fullChars}`);
});

test('Stage 2: domain selection unlocks relevant groups and omits redundant aliases', () => {
  const registry = makeRegistry();

  const docRoute = selectToolGroups({ task: 'general_chat', text: 'Tolong analisis file PDF ini dan buatkan laporan' });
  assert.equal(docRoute.groups.has('documents'), true);
  assert.equal(docRoute.groups.has('waha'), false);

  const docDefs = registry.definitionsForContext('personal', {
    task: 'general_chat',
    text: 'Tolong buatkan PDF proposal kerja'
  });
  const docNames = docDefs.map((d) => d.function.name);
  assert.equal(docNames.includes('create_document'), true);
  assert.equal(docNames.includes('create_pdf'), false);

  const unlocked = registry.definitionsForContext('personal', {
    task: 'general_chat',
    text: 'Cek cepat',
    enabledGroups: new Set(['documents', 'web'])
  });
  const unlockedNames = unlocked.map((d) => d.function.name);
  assert.equal(unlockedNames.includes('web_search'), true);
  assert.equal(unlockedNames.includes('read_document'), true);
  assert.equal(registry.get('create_pdf') !== undefined, true);
  assert.equal(registry.get('save_note') !== undefined, true);

  // All 5 groups enabled -> request_tool_group meta-tool is no longer attached
  const allUnlocked = registry.definitionsForContext('personal', {
    task: 'general_chat',
    text: 'Semua grup',
    enabledGroups: new Set(ALL_TOOL_GROUPS)
  });
  assert.equal(allUnlocked.some((d) => d.function.name === REQUEST_TOOL_GROUP_NAME), false);
});
