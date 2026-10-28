'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const COMMANDS = Object.freeze(['typecheck', 'lint', 'test:contracts', 'check:static', 'build']);
const EXCLUDED = new Set(['.git', '.role-tests', 'node_modules', 'storage', 'docs', 'tasks', 'public/uploads', 'public/videos']);
function hashFile(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function sourceDigest(root, replacements = new Map()) {
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
      else if (entry.isFile()) hash.update(path.relative(root, file)).update('\0').update(replacements.has(relative)
        ? createHash('sha256').update(replacements.get(relative)).digest('hex') : hashFile(file)).update('\0');
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
        && hashFile(withinEvidence(root, path.resolve(root, entry.log))) === entry.logSha256
        && (!entry.reusedFrom || name === 'test:contracts'
          && hashFile(entry.reusedFrom.receipt) === entry.reusedFrom.receiptSha256
          && reuseTypeOnlyContracts(root, entry.reusedFrom.receipt).entry.logSha256 === entry.logSha256
          && hashFile(withinEvidence(root, path.resolve(root, entry.affectedChecks.log))) === entry.affectedChecks.logSha256);
    });
  } catch { return false; }
}
function reusablePrebuild(root, results) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (config.scripts.prebuild !== 'node scripts/check-image-recovery.mjs') return false;
  const contracts = results.find(entry => entry.command === 'npm run test:contracts' && entry.exitCode === 0);
  if (!contracts) return false;
  const log = withinEvidence(root, path.resolve(root, contracts.log));
  if (hashFile(log) !== contracts.logSha256) return false;
  const summaries = fs.readFileSync(log, 'utf8').split('\n').flatMap(line => {
    try { const value = JSON.parse(line); return value.schema === 'contract-suites.v1' ? [value] : []; } catch { return []; }
  });
  const summary = summaries.at(-1);
  return summary?.results?.some(entry => entry.suite === 'scripts/check-image-recovery.mjs' && entry.exitCode === 0 && entry.passed === true) === true
    && summary.results.every(entry => entry.exitCode === 0 && entry.passed === true);
}
function reuseTypeOnlyContracts(root, previousFile) {
  const previous = JSON.parse(fs.readFileSync(previousFile, 'utf8'));
  const oldRoot = fs.realpathSync(previous.root);
  if (!/^\/data\/video-api-debugger\/managed-releases\/[a-f0-9]{40}$/.test(oldRoot)
    || withinEvidence(oldRoot, previousFile) !== fs.realpathSync(previousFile)
    || previous.schema !== 'equivalent-ci.v1' || previous.results?.length !== 5
    || previous.source !== path.basename(oldRoot)
    || fs.readFileSync(path.join(oldRoot, '.deployed-commit'), 'utf8').trim() !== previous.source) throw new Error('contracts-reuse-invalid-origin');
  const oldFingerprint = fingerprint(oldRoot), current = fingerprint(root);
  if (Object.keys(oldFingerprint).some(key => previous.fingerprint?.[key] !== oldFingerprint[key]
    || key !== 'sourceDigest' && current[key] !== oldFingerprint[key])) throw new Error('contracts-reuse-dependency-or-runtime-changed');
  for (const [index, entry] of previous.results.slice(0, 4).entries()) {
    if (entry.command !== `npm run ${COMMANDS[index]}` || entry.exitCode !== 0 || entry.signal !== null
      || hashFile(withinEvidence(oldRoot, path.resolve(oldRoot, entry.log))) !== entry.logSha256) throw new Error('contracts-reuse-original-check-failed');
  }
  if (!reusablePrebuild(oldRoot, previous.results)) throw new Error('contracts-reuse-original-recovery-failed');
  const old = file => fs.readFileSync(path.join(oldRoot, file), 'utf8');
  const changed = new Map([
    ['src/lib/http/route.ts', ['[request?: NextRequest]', '[request: NextRequest]']],
    ['scripts/hd-admin-engineering.ts', ['route.GET()', "route.GET(request as import('next/server').NextRequest)"]],
  ]);
  const replacements = new Map();
  for (const [file, [before, after]] of changed) {
    const original = old(file), updated = fs.readFileSync(path.join(root, file), 'utf8');
    if (!original.includes(before) || updated !== original.replace(before, after)) throw new Error('contracts-reuse-unreviewed-change:' + file);
    replacements.set(file, original);
  }
  const ts = require('typescript');
  const emit = value => ts.transpileModule(value, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  if (emit(old('src/lib/http/route.ts')) !== emit(fs.readFileSync(path.join(root, 'src/lib/http/route.ts'), 'utf8'))) throw new Error('contracts-reuse-runtime-changed');
  // These are the runner and its focused regression, not application dependencies.
  for (const file of ['.deployed-commit', 'scripts/equivalent-ci.cjs', 'scripts/test-api-route.cjs']) replacements.set(file, old(file));
  if (sourceDigest(root, replacements) !== oldFingerprint.sourceDigest) throw new Error('contracts-reuse-other-source-changed');
  return { entry: previous.results[2], oldRoot, origin: { source: previous.source, receipt: previousFile,
    receiptSha256: hashFile(previousFile), validatedAt: new Date().toISOString(),
    basis: 'All other source/dependencies/runtime identical; route emits identical JavaScript; changed fixture and regression rerun.' } };
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
  const contractsFrom = process.argv.find(arg => arg.startsWith('--contracts-from='))?.slice('--contracts-from='.length);
  const reusedContracts = contractsFrom ? reuseTypeOnlyContracts(root, contractsFrom) : null;
  const checksFrom = process.argv.find(arg => arg.startsWith('--checks-from='))?.slice('--checks-from='.length);
  if (checksFrom) {
    const previous = JSON.parse(fs.readFileSync(checksFrom, 'utf8'));
    const oldRoot = fs.realpathSync(previous.root);
    if (!/^\/data\/video-api-debugger\/managed-releases\/[a-f0-9]{40}$/.test(oldRoot)
      || previous.source !== path.basename(oldRoot) || withinEvidence(oldRoot, checksFrom) !== fs.realpathSync(checksFrom)
      || previous.results?.length !== 2) throw new Error('equivalent-ci-checks-origin-mismatch');
    const original = fingerprint(oldRoot);
    if (Object.keys(original).some(key => previous.fingerprint?.[key] !== original[key]
      || key !== 'sourceDigest' && receipt.fingerprint[key] !== original[key])) throw new Error('equivalent-ci-checks-environment-changed');
    const replacements = new Map(['.deployed-commit', 'scripts/equivalent-ci.cjs'].map(file => [file, fs.readFileSync(path.join(oldRoot, file))]));
    if (sourceDigest(root, replacements) !== original.sourceDigest) throw new Error('equivalent-ci-checks-source-changed');
    for (const [index, entry] of previous.results.entries()) {
      const originalLog = withinEvidence(oldRoot, path.resolve(oldRoot, entry.log));
      if (entry.command !== `npm run ${COMMANDS[index]}` || entry.exitCode !== 0 || entry.signal !== null
        || hashFile(originalLog) !== entry.logSha256) throw new Error('equivalent-ci-checks-failed');
      const retainedLog = path.join(directory, COMMANDS[index] + '-original.log');
      fs.copyFileSync(originalLog, retainedLog);
      receipt.results.push({ ...entry, log: path.relative(root, retainedLog) });
    }
    receipt.checksReusedFrom = { source: previous.source, receipt: checksFrom, sha256: hashFile(checksFrom),
      reason: 'Only standalone check launcher changed; all TypeScript, lint inputs, dependencies and runtime identical. Original times retained.' };
  }
  const resumeFile = process.argv.find(arg => arg.startsWith('--resume='))?.slice('--resume='.length);
  if (resumeFile) {
    const previousFile = withinEvidence(root, resumeFile);
    const previous = JSON.parse(fs.readFileSync(previousFile, 'utf8'));
    if (previous.source !== source || previous.root !== root || previous.results?.length !== 5
      || Object.keys(receipt.fingerprint).some(key => previous.fingerprint?.[key] !== receipt.fingerprint[key])) throw new Error('equivalent-ci-resume-mismatch');
    for (let index = 0; index < 4; index++) {
      const entry = previous.results[index];
      if (entry.command !== `npm run ${COMMANDS[index]}` || entry.exitCode !== 0 || entry.signal !== null
        || hashFile(withinEvidence(root, path.resolve(root, entry.log))) !== entry.logSha256) throw new Error('equivalent-ci-resume-failed-check');
    }
    const failed = previous.results[4];
    const failedLog = withinEvidence(root, path.resolve(root, failed.log));
    if (failed.command !== 'npm run build' || failed.exitCode === 0 || hashFile(failedLog) !== failed.logSha256
      || !fs.readFileSync(failedLog, 'utf8').includes('Root inputs have already been consumed; prepare a fresh isolated run')
      || !reusablePrebuild(root, previous.results)) throw new Error('equivalent-ci-resume-not-consumed-prebuild');
    receipt.results = previous.results.slice(0, 4);
    receipt.resumedFrom = { file: path.relative(root, previousFile), sha256: hashFile(previousFile) };
  }
  const save = () => fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  save();
  for (const name of COMMANDS.slice(receipt.results.length)) {
    if (name === 'test:contracts' && reusedContracts) {
      const log = path.join(directory, 'contracts-affected.log');
      const fd = fs.openSync(log, 'wx', 0o600);
      try {
        for (const args of [['scripts/test-api-route.cjs'], ['scripts/test-equivalent-ci.cjs'],
          ['--import', 'tsx', 'scripts/hd-admin-engineering.ts']]) {
          const result = spawnSync(process.execPath, args, { cwd: root, stdio: ['ignore', fd, fd],
            env: { ...process.env, NODE_ENV: 'test', IMAGE_RECOVERY_GATE_RUN_ID: require('node:crypto').randomUUID(),
              NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(path.join(root, 'scripts/server-runtime.cjs'))}`.trim() } });
          if (result.error || result.status !== 0 || result.signal) throw new Error('contracts-affected-check-failed:' + args.at(-1));
        }
      } finally { fs.closeSync(fd); }
      const originalLog = withinEvidence(reusedContracts.oldRoot, path.resolve(reusedContracts.oldRoot, reusedContracts.entry.log));
      const retainedLog = path.join(directory, 'test-contracts-original.log');
      fs.copyFileSync(originalLog, retainedLog);
      receipt.results.push({ ...reusedContracts.entry, log: path.relative(root, retainedLog), reusedFrom: reusedContracts.origin,
        affectedChecks: { log: path.relative(root, log), logSha256: hashFile(log) } });
      save();
      console.log(JSON.stringify(receipt.results.at(-1)));
      continue;
    }
    const log = path.join(directory, name.replace(':', '-') + '.log');
    const fd = fs.openSync(log, 'wx', 0o600);
    const startedAt = new Date().toISOString();
    let result;
    const reusePrebuild = name === 'build' && reusablePrebuild(root, receipt.results);
    try {
      result = spawnSync('npm', ['run', name], { cwd: root, stdio: ['ignore', fd, fd],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`,
          ...(reusePrebuild ? { npm_config_ignore_scripts: 'true' } : {}) } });
    } finally { fs.closeSync(fd); }
    receipt.results.push({ command: `npm run ${name}`, startedAt, finishedAt: new Date().toISOString(),
      exitCode: result.status, signal: result.signal, log: path.relative(root, log), logSha256: hashFile(log),
      ...(reusePrebuild ? { prebuildReusedFrom: 'npm run test:contracts' } : {}) });
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
module.exports = { COMMANDS, fingerprint, verifyEquivalentCi, hashFile, reusablePrebuild, reuseTypeOnlyContracts };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
