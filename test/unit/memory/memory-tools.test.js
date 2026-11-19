const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryTools } = require('../../../src/memory/memory-tools');

test('save_note forwards kind to memoryService.remember and db.saveMemory', async () => {
  const remembered = [];
  const savedDirect = [];

  const withService = createMemoryTools({
    db: {},
    memoryService: {
      remember: async (args) => {
        remembered.push(args);
        return { saved: true, memoryId: 1 };
      }
    }
  });
  const saveWithService = withService.find((t) => t.name === 'save_note');
  await saveWithService.execute(
    { content: 'Selalu kirim ringkasan poin.', kind: 'preference' },
    { scope: 'personal', requesterId: '628111@c.us', chatId: '628111@c.us' }
  );
  assert.equal(remembered.length, 1);
  assert.equal(remembered[0].kind, 'preference');
  assert.equal(remembered[0].memoryType, 'preference');

  const withoutService = createMemoryTools({
    db: {
      saveMemory: (args) => {
        savedDirect.push(args);
        return 42;
      }
    },
    memoryService: null
  });
  const saveDirect = withoutService.find((t) => t.name === 'save_note');
  const directRes = await saveDirect.execute(
    { content: 'Catatan rapat Jumat.', kind: 'meeting' },
    { scope: 'group', requesterId: '628111@c.us', chatId: '12036300@g.us' }
  );
  assert.deepEqual(directRes, { saved: true, noteId: 42 });
  assert.equal(savedDirect[0].kind, 'meeting');
});
