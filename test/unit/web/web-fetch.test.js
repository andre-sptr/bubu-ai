const test = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateHost, extractReadableText } = require('../../../src/web/web-service');

test('web fetch blocks loopback and private IPv4 hosts', () => {
  assert.equal(isPrivateHost('127.0.0.1'), true);
  assert.equal(isPrivateHost('10.1.2.3'), true);
  assert.equal(isPrivateHost('192.168.1.1'), true);
  assert.equal(isPrivateHost('example.com'), false);
});

test('HTML extraction removes script/style and returns readable text', () => {
  const text = extractReadableText('<html><title>Report</title><script>secret()</script><p>Hello world</p></html>');
  assert.match(text, /Hello world/);
  assert.doesNotMatch(text, /secret/);
});
