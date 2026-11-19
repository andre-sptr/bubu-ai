const { spawn } = require('node:child_process');

function runCommand(command, args, { input = null, timeoutMs = 120000, maxOutput = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (stdout.length + chunk.length > maxOutput) {
        child.kill('SIGKILL');
        finish(new Error(`${command} output exceeded limit`));
      } else {
        stdout = Buffer.concat([stdout, chunk]);
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 128 * 1024) {
        stderr = Buffer.concat([stderr, chunk]).subarray(0, 128 * 1024);
      }
    });
    child.on('error', (error) => finish(new Error(`${command} unavailable: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) finish(null, { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
      else finish(new Error(`${command} exited ${code}: ${stderr.toString('utf8').slice(-1200)}`));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

module.exports = { runCommand };
