const test = require('node:test');
const assert = require('node:assert/strict');
const { eventKey } = require('../../src/agent/message-processor');

test('event key is deterministic and chat-scoped', () => {
  const m = { eventId: 'message-1', chatId: 'chat-a' };
  assert.equal(eventKey(m), eventKey(m));
  assert.notEqual(eventKey(m), eventKey({ ...m, chatId: 'chat-b' }));
});
