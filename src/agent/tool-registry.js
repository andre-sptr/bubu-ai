const { z } = require('../utils/zod-loader');
const { createMemoryTools } = require('../memory/memory-tools');
const { createProductivityTools } = require('../productivity/productivity-tools');
const { createWebTools } = require('../web/web-tools');
const { createDocumentTools } = require('../documents/document-tools');
const { createWahaTools } = require('../channels/waha/waha-tools');
const { createPollTools } = require('../channels/waha/poll-tools');

const ALL_TOOL_GROUPS = Object.freeze(['memory', 'productivity', 'web', 'documents', 'waha']);
const REQUEST_TOOL_GROUP_NAME = 'request_tool_group';
const CORE_ALWAYS_TOOLS = new Set([
  'search_memory',
  'remember_fact',
  'create_task',
  'list_tasks',
  'create_reminder'
]);

const GROUP_PATTERNS = Object.freeze({
  memory: /\b(ingat|catat|catatan|memori|memory|preferensi|proyek|project|lupa|hapus memori|arsip|sinkron|konsolidasi|riwayat|tujuan|goal|fakta)\b/i,
  productivity: /\b(task|tugas|todo|to-do|kerjaan|daftar tugas|selesai|selesaikan|deadline|reminder|ingatkan|pengingat|jadwal|batal|batalkan)\b/i,
  web: /\b(cari|carikan|search|google|internet|web|berita|terbaru|hari ini|harga|kurs|cuaca|riset|research|jurnal|artikel|link|url|situs|website|buka halaman|cek info)\b/i,
  documents: /\b(dokumen|document|file|berkas|pdf|docx|word|xlsx|excel|spreadsheet|csv|tabel|sheet|laporan|proposal|invoice|quotation|surat|sop|notulen|memo|bandingkan|compare|halaman|page|lampiran|attachment|template)\b/i,
  waha: /\b(kirim|kirimkan|send|pesan|chat|whatsapp|wa|poll|polling|voting|vote|lokasi|location|maps|koordinat|kontak|vcard|kartu nama|reaksi|react|emoji|preview|tautan|edit pesan|hapus pesan|ubah pesan|tarik pesan|info grup|anggota grup|peserta|admin grup|cek nomor|nomor wa|sesi waha|status waha|pesan terakhir)\b/i
});

function selectToolGroups({
  task = 'general_chat',
  text = '',
  hasAttachment = false,
  hasRecentDocuments = false,
  hasQuote = false,
  hasPendingApprovals = false,
  enabledGroups = null
} = {}) {
  const manualGroups = new Set(enabledGroups || []);
  if (
    task === 'greeting' &&
    !hasAttachment &&
    !hasQuote &&
    !hasPendingApprovals &&
    manualGroups.size === 0
  ) {
    return { isGreetingFastPath: true, groups: new Set(), includeCore: false };
  }

  const s = String(text || '');
  const groups = new Set(manualGroups);
  if (GROUP_PATTERNS.memory.test(s)) groups.add('memory');
  if (GROUP_PATTERNS.productivity.test(s)) groups.add('productivity');
  if (
    task === 'simple_question' ||
    task === 'reasoning' ||
    task === 'agent' ||
    /https?:\/\//i.test(s) ||
    GROUP_PATTERNS.web.test(s)
  ) {
    groups.add('web');
  }
  if (
    hasAttachment ||
    hasQuote ||
    GROUP_PATTERNS.documents.test(s) ||
    (hasRecentDocuments && /\b(tadi|itu|tersebut|ringkas|rangkum|jelaskan|analisis|buatkan|cek)\b/i.test(s))
  ) {
    groups.add('documents');
  }
  if (hasPendingApprovals || GROUP_PATTERNS.waha.test(s)) {
    groups.add('waha');
  }

  return { isGreetingFastPath: false, groups, includeCore: true };
}

function buildRequestToolGroupDefinition(unloadedGroups) {
  return {
    type: 'function',
    function: {
      name: REQUEST_TOOL_GROUP_NAME,
      description: `Load additional tool schemas from an unloaded domain group when needed (${unloadedGroups.join(', ')}).`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: {
            type: 'string',
            enum: unloadedGroups,
            description: 'Tool group name to unlock for subsequent steps in this task'
          }
        },
        required: ['group']
      }
    }
  };
}

class ToolRegistry {
  constructor() { this.tools = new Map(); }

  register(tool) {
    if (!tool?.name || !tool.schema || typeof tool.execute !== 'function' || !Array.isArray(tool.scopes)) {
      throw new Error('Tool requires name, schema, execute, and scopes');
    }
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, Object.freeze({
      risk: 'low',
      requiresApproval: false,
      readOnly: Boolean(tool.readOnly),
      group: tool.group || 'core',
      aliasOf: tool.aliasOf || null,
      ...tool
    }));
  }

  get(name) { return this.tools.get(name); }

  list(scope) {
    return [...this.tools.values()].filter((tool) => tool.scopes.includes(scope));
  }

  definitions(scope) {
    return this.list(scope).map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    }));
  }

  definitionsForContext(scope, routeCtx = {}) {
    const routing = selectToolGroups(routeCtx);
    if (routing.isGreetingFastPath) return [];

    const scopedTools = this.list(scope);
    const candidateTools = scopedTools.filter(
      (tool) => routing.groups.has(tool.group) || (routing.includeCore && CORE_ALWAYS_TOOLS.has(tool.name))
    );
    const candidateNames = new Set(candidateTools.map((tool) => tool.name));
    const filtered = candidateTools
      .filter((tool) => !tool.aliasOf || !candidateNames.has(tool.aliasOf))
      .sort((a, b) => a.name.localeCompare(b.name));

    const defs = filtered.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    }));

    const availableGroups = new Set(scopedTools.map((tool) => tool.group).filter((g) => ALL_TOOL_GROUPS.includes(g)));
    const unloadedGroups = ALL_TOOL_GROUPS.filter((g) => availableGroups.has(g) && !routing.groups.has(g));
    if (unloadedGroups.length > 0) {
      defs.push(buildRequestToolGroupDefinition(unloadedGroups));
    }
    return defs;
  }
}

function createCoreTools({ db, approvalManager, memoryService }) {
  const registry = new ToolRegistry();
  const memoryToolNames = new Set(['save_note', 'search_notes']);
  const productivityToolNames = new Set(['create_reminder', 'send_whatsapp_message']);

  for (const tool of createMemoryTools({ db, memoryService })) {
    if (memoryToolNames.has(tool.name)) registry.register(tool);
  }
  for (const tool of createProductivityTools({ db, approvalManager })) {
    if (productivityToolNames.has(tool.name)) registry.register(tool);
  }

  return registry;
}

function registerAllTools({
  db,
  approvalManager,
  waha,
  responseHandler = null,
  sessionMonitor = null,
  memoryService,
  documentService,
  webSearch,
  webFetch
}) {
  const registry = new ToolRegistry();
  const domainTools = [
    ...createMemoryTools({ db, memoryService }),
    ...createProductivityTools({ db, approvalManager }),
    ...createWebTools({ webSearch, webFetch }),
    ...createDocumentTools({ db, documentService, approvalManager, waha, responseHandler }),
    ...createWahaTools({ waha, responseHandler, approvalManager, sessionMonitor, db }),
    ...createPollTools({ db })
  ];
  for (const tool of domainTools) {
    registry.register(tool);
  }
  return registry;
}

module.exports = {
  ToolRegistry,
  createCoreTools,
  registerAllTools,
  selectToolGroups,
  ALL_TOOL_GROUPS,
  REQUEST_TOOL_GROUP_NAME,
  CORE_ALWAYS_TOOLS,
  z
};
