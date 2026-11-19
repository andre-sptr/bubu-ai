const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCommand } = require('../../../src/utils/process-runner');

test('runCommand handles fast-exiting child with large stdin without EPIPE crash', async () => {
  const largeInput = 'x'.repeat(256 * 1024);
  const result = await runCommand(process.execPath, ['-e', 'process.exit(0)'], {
    input: largeInput,
    timeoutMs: 5000
  });
  assert.equal(result.stdout, '');
});

test('runCommand collects multi-chunk stdout and stderr via array buffers', async () => {
  const result = await runCommand(process.execPath, [
    '-e',
    'for (let i = 0; i < 50; i++) process.stdout.write("A".repeat(1024)); process.stderr.write("warn");'
  ]);
  assert.equal(result.stdout.length, 50 * 1024);
  assert.equal(result.stderr, 'warn');
});

test('runCommand waits for child close on timeout abort before rejecting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubu-proc-timeout-'));
  const marker = path.join(dir, 'alive.txt');
  try {
    await assert.rejects(
      () => runCommand(process.execPath, [
        '-e',
        `const fs = require('fs'); const p = ${JSON.stringify(marker)}; setInterval(() => fs.writeFileSync(p, String(Date.now())), 25);`
      ], { timeoutMs: 120 }),
      /timed out/
    );
    const snapshotAfterReject = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
    await new Promise((resolve) => setTimeout(resolve, 80));
    const snapshotLater = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
    assert.equal(snapshotLater, snapshotAfterReject);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCommand aborts and rejects when stdout exceeds maxOutput', async () => {
  await assert.rejects(
    () => runCommand(process.execPath, [
      '-e',
      'process.stdout.write("B".repeat(64 * 1024))'
    ], { maxOutput: 4096, timeoutMs: 5000 }),
    /output exceeded limit/
  );
});
