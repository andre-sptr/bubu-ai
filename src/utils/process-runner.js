const { spawn } = require('node:child_process');

function runCommand(command, args, { input = null, timeoutMs = 120000, maxOutput = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let abortError = null;
    let graceTimer = null;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      if (error) reject(error);
      else resolve(result);
    };

    const abort = (error) => {
      if (settled || abortError) return;
      abortError = error;
      clearTimeout(timer);
      try { child.stdin?.destroy(); } catch {}
      try { child.stdout?.destroy(); } catch {}
      try { child.stderr?.destroy(); } catch {}
      try { child.kill('SIGKILL'); } catch {}
      graceTimer = setTimeout(() => {
        finish(abortError);
      }, 500);
      graceTimer.unref?.();
    };

    const timer = setTimeout(() => {
      abort(new Error(`${command} timed out`));
    }, timeoutMs);

    child.stdin?.on('error', () => {});
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    child.stdout.on('data', (chunk) => {
      if (abortError || settled) return;
      if (stdoutBytes + chunk.length > maxOutput) {
        abort(new Error(`${command} output exceeded limit`));
      } else {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });

    child.stderr.on('data', (chunk) => {
      if (abortError || settled) return;
      if (stderrBytes < 128 * 1024) {
        const remaining = 128 * 1024 - stderrBytes;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        stderrChunks.push(slice);
        stderrBytes += slice.length;
      }
    });

    child.on('error', (error) => {
      finish(abortError || new Error(`${command} unavailable: ${error.message}`));
    });

    child.on('close', (code) => {
      if (abortError) {
        finish(abortError);
        return;
      }
      const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
      const stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf8');
      if (code === 0) finish(null, { stdout, stderr });
      else finish(new Error(`${command} exited ${code}: ${stderr.slice(-1200)}`));
    });

    if (child.stdin) {
      if (input !== null && input !== undefined && input !== '') child.stdin.end(input);
      else child.stdin.end();
    }
  });
}

module.exports = { runCommand };
