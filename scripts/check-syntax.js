const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const targets = ['src', 'test', 'scripts'];

function collectFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (entry.isFile() && /\.(?:c|m)?js$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = targets.flatMap((dir) => collectFiles(path.join(root, dir)));
const ecosystemFile = path.join(root, 'ecosystem.config.cjs');
if (fs.existsSync(ecosystemFile)) files.push(ecosystemFile);

files.sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`Syntax check failed: ${path.relative(root, file)}`);
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(result.status || 1);
  }
}

console.log(`Syntax check passed (${files.length} JS/CJS files).`);
