const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WahaClient } = require('../../src/channels/waha/client');

test('sendSeen calls WAHA endpoint with compatible chat-level read receipt payload', async () => {
  const client = new WahaClient({
    baseUrl: 'http://127.0.0.1:3000/',
    session: 'default',
    apiKey: 'test-key'
  });
  const calls = [];
  client.request = async (...args) => { calls.push(args); return { success: true }; };

  await client.sendSeen('123456789@c.us');

  assert.deepEqual(calls, [[
    'POST',
    '/api/sendSeen',
    { session: 'default', chatId: '123456789@c.us' }
  ]]);
});

test('startTyping and stopTyping call the documented WAHA endpoints', async () => {
  const client = new WahaClient({
    baseUrl: 'http://127.0.0.1:3000',
    session: 'bubu',
    apiKey: ''
  });
  const calls = [];
  client.request = async (...args) => { calls.push(args); return { success: true }; };

  await client.startTyping('123456789@c.us');
  await client.stopTyping('123456789@c.us');

  assert.deepEqual(calls, [
    ['POST', '/api/startTyping', { session: 'bubu', chatId: '123456789@c.us' }],
    ['POST', '/api/stopTyping', { session: 'bubu', chatId: '123456789@c.us' }]
  ]);
});


test('sendVideo calls WAHA sendVideo endpoint', async () => {
  const client = new WahaClient({
    baseUrl: 'http://127.0.0.1:3000',
    session: 'default',
    apiKey: 'test-key'
  });
  const calls = [];
  client.request = async (...args) => { calls.push(args); return { id: 'video-1' }; };

  const filePath = path.join(os.tmpdir(), `bubu-video-test-${process.pid}.mp4`);
  fs.writeFileSync(filePath, Buffer.from('video'));
  try {
    await client.sendVideo(filePath, '123456789@c.us', {
      filename: 'demo.mp4', mimetype: 'video/mp4', caption: 'Demo'
    });
  } finally {
    fs.rmSync(filePath, { force: true });
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'POST');
  assert.equal(calls[0][1], '/api/sendVideo');
  assert.equal(calls[0][2].session, 'default');
  assert.equal(calls[0][2].chatId, '123456789@c.us');
  assert.equal(calls[0][2].file.filename, 'demo.mp4');
});
