'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const COMMANDS = Object.freeze(['typecheck', 'lint', 'test:contracts', 'check:static', 'build']);
const EXCLUDED = new Set(['.git', '.role-tests', 'node_modules', 'storage', 'docs', 'tasks', 'public/uploads', 'public/videos']);
function hashFile(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function sourceDigest(root) {
  const hash = createHash('sha256');
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      // Next regenerates its ambient type reference for the selected build directory.
      if (relative === 'next-env.d.ts') {
        const declarations = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim() && !line.startsWith('// NOTE:') && !line.startsWith('// see '));
        if (declarations.some(line => !/^\/\/\/ <reference (?:types="(?:next|next\/image-types\/global)"|path="\.\/\.next[^"/]*\/types\/routes\.d\.ts") \/>$/.test(line))) {
          throw new Error('equivalent-ci-unexpected-generated-types');
        }
        continue;
      }
      if (EXCLUDED.has(relative) || directory === root && (entry.name.startsWith('.next') || entry.name.startsWith('.env')
        || entry.name.endsWith('.tsbuildinfo') || entry.name.endsWith('.log'))) continue;
      if (entry.isSymbolicLink()) throw new Error('equivalent-ci-source-symlink');
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) hash.update(path.relative(root, file)).update('\0').update(hashFile(file)).update('\0');
    }
  }
  visit(root);
  return hash.digest('hex');
}
function fingerprint(root) {
  return { sourceDigest: sourceDigest(root), lockSha256: hashFile(path.join(root, 'package-lock.json')),
    installedLockSha256: hashFile(path.join(root, 'node_modules/.package-lock.json')),
    runtimeSha256: hashFile(fs.realpathSync(process.execPath)), runtimeVersion: process.version,
    platform: process.platform, architecture: process.arch };
}
function withinEvidence(root, file) {
  const evidence = fs.realpathSync(path.join(root, '.role-tests'));
  const resolved = fs.realpathSync(file);
  if (!resolved.startsWith(evidence + path.sep)) throw new Error('equivalent-ci-evidence-outside-root');
  return resolved;
}
function verifyEquivalentCi(root, source, file) {
  try {
    const receipt = JSON.parse(fs.readFileSync(withinEvidence(root, file), 'utf8'));
    if (receipt.schema !== 'equivalent-ci.v1' || receipt.source !== source || receipt.completed !== true
      || receipt.root !== root || fs.readFileSync(path.join(root, '.deployed-commit'), 'utf8').trim() !== source) return false;
    const current = fingerprint(root);
    if (Object.keys(current).some(key => receipt.fingerprint?.[key] !== current[key])) return false;
    if (!Array.isArray(receipt.results) || receipt.results.length !== COMMANDS.length) return false;
    return COMMANDS.every((name, index) => {
      const entry = receipt.results[index];
      return entry.command === `npm run ${name}` && entry.exitCode === 0 && entry.signal === null
        && Number.isFinite(Date.parse(entry.startedAt)) && Date.parse(entry.finishedAt) >= Date.parse(entry.startedAt)
        && hashFile(withinEvidence(root, path.resolve(root, entry.log))) === entry.logSha256;
    });
  } catch { return false; }
}
function main() {
  const root = fs.realpathSync(process.cwd());
  if (!/^\/data\/video-api-debugger\/managed-releases\/[a-f0-9]{40}$/.test(root) || process.getuid() === 0) {
    throw new Error('equivalent-ci-requires-isolated-candidate-service-user');
  }
  for (const file of ['.env', '.env.local', '.env.production', 'storage', 'public/uploads', 'public/videos']) {
    try { fs.lstatSync(path.join(root, file)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('equivalent-ci-candidate-contains-runtime-data');
  }
  const source = fs.readFileSync(path.join(root, '.deployed-commit'), 'utf8').trim();
  if (path.basename(root) !== source) throw new Error('equivalent-ci-source-mismatch');
  const directory = fs.mkdtempSync(path.join(root, '.role-tests', 'equivalent-ci-'));
  const receiptFile = path.join(directory, 'receipt.json');
  const receipt = { schema: 'equivalent-ci.v1', source, root, fingerprint: fingerprint(root), results: [], completed: false };
  const save = () => fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  save();
  for (const name of COMMANDS) {
    const log = path.join(directory, name.replace(':', '-') + '.log');
    const fd = fs.openSync(log, 'wx', 0o600);
    const startedAt = new Date().toISOString();
    let result;
    try {
      result = spawnSync('npm', ['run', name], { cwd: root, stdio: ['ignore', fd, fd],
        env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}` } });
    } finally { fs.closeSync(fd); }
    receipt.results.push({ command: `npm run ${name}`, startedAt, finishedAt: new Date().toISOString(),
      exitCode: result.status, signal: result.signal, log: path.relative(root, log), logSha256: hashFile(log) });
    save();
    console.log(JSON.stringify(receipt.results.at(-1)));
    if (result.error || result.status !== 0 || result.signal) { process.exitCode = 1; return; }
  }
  const after = fingerprint(root);
  if (Object.keys(after).some(key => receipt.fingerprint[key] !== after[key])) throw new Error('equivalent-ci-source-or-runtime-changed');
  receipt.completed = true;
  save();
  console.log(`EQUIVALENT_CI_RECEIPT=${receiptFile}`);
}
module.exports = { COMMANDS, fingerprint, verifyEquivalentCi, hashFile };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
