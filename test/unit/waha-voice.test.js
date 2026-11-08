const test = require('node:test');
const assert = require('node:assert/strict');
const { WahaClient, normalizeIncoming } = require('../../src/channels/waha/client');

test('WAHA sendVoice sends OGG/Opus as base64 through sendVoice endpoint', async () => {
  const client = new WahaClient({ baseUrl:'http://waha:3000',session:'default',apiKey:'secret' });
  let request = null;
  client.request = async (...args) => { request = args; return { id:'sent-1' }; };
  const result = await client.sendVoice(Buffer.from('audio-bytes'),'628123@c.us');
  assert.equal(result.id,'sent-1');
  assert.equal(request[0],'POST');
  assert.equal(request[1],'/api/sendVoice');
  assert.equal(request[2].file.data,Buffer.from('audio-bytes').toString('base64'));
  assert.equal(request[2].file.mimetype,'audio/ogg; codecs=opus');
});

test('WAHA normalizer accepts incoming voice media metadata', () => {
  const message = normalizeIncoming({
    event:'message',
    payload:{
      id:'voice-1',from:'628123@c.us',author:'628123@c.us',
      hasMedia:true,body:'',
      media:{url:'http://waha:3000/api/files/voice.ogg',mimetype:'audio/ogg',filename:'voice.ogg'}
    }
  });
  assert.equal(message.hasMedia,true);
  assert.equal(message.media.mimetype,'audio/ogg');
});
