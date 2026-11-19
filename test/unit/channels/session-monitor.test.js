const test = require('node:test');
const assert = require('node:assert/strict');
const { WahaSessionMonitor } = require('../../../src/channels/waha/session-monitor');

test('WahaSessionMonitor tracks statuses, health, and degradation cleanly', () => {
  const monitor = new WahaSessionMonitor({ session: 'default' });
  assert.equal(monitor.session, 'default');
  assert.equal(monitor.status, 'UNKNOWN');
  assert.equal(monitor.updatedAt, null);
  assert.equal(monitor.isDegraded(), false);
  assert.equal(monitor.isHealthy(), true);

  const starting = monitor.update({ session: 'default', status: 'starting' });
  assert.equal(starting.status, 'STARTING');
  assert.equal(starting.previousStatus, 'UNKNOWN');
  assert.equal(starting.changed, true);
  assert.equal(monitor.isDegraded(), false);
  assert.equal(monitor.isHealthy(), true);
  assert.ok(monitor.updatedAt);

  const working = monitor.update({ session: 'bubu', status: 'WORKING' });
  assert.equal(working.changed, true);
  assert.equal(monitor.session, 'bubu');
  assert.equal(monitor.isDegraded(), false);
  assert.equal(monitor.isHealthy(), true);

  for (const degradedStatus of ['SCAN_QR_CODE', 'STOPPED', 'FAILED']) {
    monitor.update({ status: degradedStatus });
    assert.equal(monitor.isDegraded(), true, `${degradedStatus} should be degraded`);
    assert.equal(monitor.isHealthy(), false, `${degradedStatus} should not be healthy`);
  }

  const snap = monitor.snapshot();
  assert.equal(snap.session, 'bubu');
  assert.equal(snap.status, 'FAILED');
  assert.equal(snap.degraded, true);
  assert.equal(snap.healthy, false);
  assert.equal(snap.botJid, '');
  assert.equal(snap.botLid, '');
  assert.ok(snap.updatedAt);
});

test('WahaSessionMonitor normalizes and preserves botJid and botLid via updateBotIdentity and getBotIdentities', () => {
  const monitor = new WahaSessionMonitor({ session: 'default' });
  assert.deepEqual(monitor.getBotIdentities(), { botJid: '', botLid: '' });

  const first = monitor.updateBotIdentity({
    id: '628999111222:1@s.whatsapp.net',
    lid: '123456789:0@lid'
  });
  assert.equal(first.botJid, '628999111222@c.us');
  assert.equal(first.botLid, '123456789@lid');
  assert.equal(first.changed, true);

  // Partial update preserves previously known identity fields
  const second = monitor.updateBotIdentity({ lid: '987654321' });
  assert.equal(second.botJid, '628999111222@c.us');
  assert.equal(second.botLid, '987654321@lid');
  assert.equal(second.changed, true);

  // Idempotent update reports changed: false
  const third = monitor.updateBotIdentity({ id: '628999111222@c.us', lid: '987654321@lid' });
  assert.equal(third.changed, false);

  assert.deepEqual(monitor.getBotIdentities(), {
    botJid: '628999111222@c.us',
    botLid: '987654321@lid'
  });
  assert.equal(monitor.snapshot().botJid, '628999111222@c.us');
  assert.equal(monitor.snapshot().botLid, '987654321@lid');
});

test('WahaSessionMonitor syncFromWaha populates status and identity, falls back to getMe, and never throws on errors', async () => {
  const monitor = new WahaSessionMonitor({ session: 'default' });
  let getMeCalled = 0;

  const res1 = await monitor.syncFromWaha({
    sessionStatus: async () => ({
      name: 'bubu-live',
      status: 'WORKING',
      me: { id: '628111:2@s.whatsapp.net', lid: '555444:1@lid' }
    }),
    getMe: async () => {
      getMeCalled++;
      return {};
    }
  });
  assert.equal(res1.ok, true);
  assert.equal(getMeCalled, 0);
  assert.equal(res1.snapshot.session, 'bubu-live');
  assert.equal(res1.snapshot.status, 'WORKING');
  assert.equal(res1.snapshot.botJid, '628111@c.us');
  assert.equal(res1.snapshot.botLid, '555444@lid');

  // Falls back to getMe when me is absent in sessionStatus
  const monitorFallback = new WahaSessionMonitor({ session: 'default' });
  const res2 = await monitorFallback.syncFromWaha({
    sessionStatus: async () => ({ name: 'default', status: 'WORKING' }),
    getMe: async () => {
      getMeCalled++;
      return { id: '628222@c.us', lid: '777888@lid' };
    }
  });
  assert.equal(res2.ok, true);
  assert.equal(getMeCalled, 1);
  assert.equal(res2.snapshot.botJid, '628222@c.us');
  assert.equal(res2.snapshot.botLid, '777888@lid');

  // Graceful handling when sessionStatus rejects on startup
  const logs = [];
  const monitorErr = new WahaSessionMonitor({ session: 'default' });
  const res3 = await monitorErr.syncFromWaha({
    sessionStatus: async () => { throw new Error('ECONNREFUSED'); }
  }, {
    logger: { warn: (...args) => logs.push(args) }
  });
  assert.equal(res3.ok, false);
  assert.equal(res3.snapshot.status, 'UNKNOWN');
  assert.equal(logs.length, 1);

  // Graceful handling when getMe fallback rejects after sessionStatus succeeds
  const monitorPartial = new WahaSessionMonitor({ session: 'default' });
  const res4 = await monitorPartial.syncFromWaha({
    sessionStatus: async () => ({ name: 'default', status: 'STARTING' }),
    getMe: async () => { throw new Error('Not ready'); }
  }, {
    logger: { warn: (...args) => logs.push(args) }
  });
  assert.equal(res4.ok, true);
  assert.equal(res4.snapshot.status, 'STARTING');
  assert.equal(logs.length, 2);
});
