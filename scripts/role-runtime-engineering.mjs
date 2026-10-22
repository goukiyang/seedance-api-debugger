import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const root = realpathSync(process.cwd());
const ts = createRequire(import.meta.url)('typescript');
const reproduce = process.argv[2] === '--reproduce';
const sourceFile = reproduce ? process.argv[3] : path.join(root, 'scripts/canvas-role-coordinator.ts');
const destination = path.resolve(process.argv[reproduce ? 4 : 2] || '');
assert.ok(destination.startsWith(path.join(root, '.role-tests') + path.sep));
const source = readFileSync(sourceFile, 'utf8');
const ast = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function functionText(name) {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, 'Missing actual function: ' + name); return node.getText(ast);
}
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const directory = await fs.mkdtemp(path.join(root, '.role-tests/role-runtime-'));
const runtimePath = path.join(directory, 'runtime.json');
let activeWrites = 0, maximumWrites = 0;
const gates = [];
const context = vm.createContext({ startup: { pid: process.pid, sourceRoot: '/isolated', version: 'fixture' },
  runtimePath, process: { pid: process.pid }, running: new Map(), randomUUID,
  writeFile: async (...args) => {
    activeWrites++; maximumWrites = Math.max(maximumWrites, activeWrites);
    try {
      await fs.writeFile(...args);
      if (reproduce) await new Promise(resolve => { gates.push(resolve); if (gates.length === 2) gates.forEach(release => release()); });
      else await new Promise(resolve => setTimeout(resolve, 5));
    } finally { activeWrites--; }
  }, rename: fs.rename, unlink: fs.unlink, Promise, Date });
vm.runInContext(compile('let runtimeWrite: Promise<void> = Promise.resolve();\n' + functionText('publishRuntime')), context);
const publish = vm.runInContext('publishRuntime', context);
const outcomes = await Promise.allSettled([publish('stopping'), publish('stopped')]);
const checks = [];
if (reproduce) {
  assert.equal(maximumWrites, 2);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(value => value.status === 'rejected' && value.reason.code === 'ENOENT').length, 1);
  checks.push('actual_original_shared_temporary_path_concurrent_rename_reproduces_ENOENT');
} else {
  assert.ok(outcomes.every(value => value.status === 'fulfilled'));
  assert.equal(maximumWrites, 1);
  assert.equal(JSON.parse(await fs.readFile(runtimePath, 'utf8')).state, 'stopped');
  assert.deepEqual(await fs.readdir(directory), ['runtime.json']);
  checks.push('actual_runtime_writer_serializes_concurrent_atomic_publication');
  const denied = Object.assign(new Error('fixture_write_denied'), { code: 'EACCES' });
  context.writeFile = async () => { throw denied; };
  await assert.rejects(publish('active'), error => error.code === 'EACCES');
  context.writeFile = fs.writeFile;
  await publish('stopped');
  assert.equal(JSON.parse(await fs.readFile(runtimePath, 'utf8')).state, 'stopped');
  checks.push('write_failure_propagates_and_later_publication_recovers');

  const events = []; let timer, calls = 0;
  const mainContext = vm.createContext({ stopped: false, running: new Map(),
    isRoleCollaborationReadOnly: () => false, recordStartup: async () => {}, log: async () => {},
    setInterval: callback => { timer = callback; return 1; }, clearInterval: () => events.push('timer_cleared'),
    heartbeat: async () => {
      if (++calls === 1) { mainContext.stopped = true; queueMicrotask(() => timer()); return; }
      await new Promise(resolve => setTimeout(resolve, 10)); events.push('heartbeat_complete');
    }, recoverExpired: async () => {}, readOriginalResults: async () => {}, planReadyRuns: async () => {}, claimReady: async () => {},
    publishRuntime: async state => events.push('published_' + state),
    prisma: { $disconnect: async () => events.push('disconnected') }, Promise, Array });
  vm.runInContext(compile(functionText('main')), mainContext);
  await vm.runInContext('main()', mainContext);
  assert.ok(events.indexOf('heartbeat_complete') >= 0);
  assert.ok(events.indexOf('heartbeat_complete') < events.indexOf('published_stopped'));
  assert.ok(events.indexOf('published_stopped') < events.indexOf('disconnected'));
  checks.push('actual_shutdown_waits_pending_heartbeat_before_terminal_publication_and_disconnect');
}
const files = ['scripts/role-runtime-engineering.mjs', 'scripts/canvas-role-coordinator.ts'];
writeFileSync(destination, JSON.stringify({ schema: 'role-runtime-engineering.v1', completed: true, synthetic: true,
  mode: reproduce ? 'original-counterexample' : 'verify', checks, maximumWrites,
  rejectedCodes: outcomes.filter(value => value.status === 'rejected').map(value => value.reason.code),
  examinedSourceSha256: createHash('sha256').update(source).digest('hex'),
  sourceSha256: Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')])),
  applicationDatabaseOpened: false, forbiddenCalls: 0, productionWrites: 0, paidRequests: 0, browserRuns: 0,
  serviceStops: 0, scratch: directory }, null, 2), { flag: 'wx', mode: 0o600 });
console.log('ROLE_RUNTIME_ENGINEERING_RECEIPT=' + destination);
