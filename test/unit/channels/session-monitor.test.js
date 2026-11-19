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
  assert.ok(snap.updatedAt);
});
