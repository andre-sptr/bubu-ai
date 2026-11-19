const { z } = require('../utils/zod-loader');
const { createMemoryTools } = require('../memory/memory-tools');
const { createProductivityTools } = require('../productivity/productivity-tools');
const { createWebTools } = require('../web/web-tools');
const { createDocumentTools } = require('../documents/document-tools');
const { createWahaTools } = require('../channels/waha/waha-tools');

class ToolRegistry {
  constructor() { this.tools = new Map(); }

  register(tool) {
    if (!tool?.name || !tool.schema || typeof tool.execute !== 'function' || !Array.isArray(tool.scopes)) {
      throw new Error('Tool requires name, schema, execute, and scopes');
    }
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, Object.freeze({ risk: 'low', requiresApproval: false, ...tool }));
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
    ...createWahaTools({ waha, responseHandler, sessionMonitor })
  ];
  for (const tool of domainTools) {
    registry.register(tool);
  }
  return registry;
}

module.exports = { ToolRegistry, createCoreTools, registerAllTools, z };
