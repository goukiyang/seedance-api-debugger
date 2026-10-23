import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { FULL_SQL, FULL_SCHEMA_PY, assertFullReleaseInput } from './full-release-contract.mjs';
import { createControllerOwner, continueFailedAttempt, finishAttempt, readAttempt, recordAttemptEvent,
  startAttempt, startPhase, finishPhase } from './attempt-state.mjs';
import { fileURLToPath } from 'node:url';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const call = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024,
  env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } }).trim();
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
function failedContinuation(root) {
  const taskId = randomUUID(), attemptId = randomUUID(), owner = createControllerOwner(), now = Date.now();
  const artifacts = Object.fromEntries(['main', 'guard'].map((kind, i) => [kind, { schema: 'sd2-release-artifact-input.v1',
    kind, source: String(i + 1).repeat(40), version: '0.0.0-fixture', sourceManifestSha256: sha(kind), buildInputsSha256: sha(kind + 'inputs') }]));
  const bindings = { engine: { schema: 'sd2-release-engine-identity.v1', version: '1.0.0', sha256: sha('engine') },
    manifest: { schema: 'sd2-release-manifest-identity.v1', file: root + '/fixture-batch.json', sha256: sha('batch') }, artifacts };
  const window = { schema: 'sd2-release-window-reference.v1', attemptId, runId: attemptId,
    file: root + '/fixture-window.json', sha256: sha('window'), observedAt: now, expiresAt: now + 300000 };
  const facts = { effectsStarted: false, switchComplete: false }, scene = { schema: 'sd2-release-scene-summary.v1',
    capturedAt: now, sha256: sha(JSON.stringify(facts)), facts };
  const common = { root, taskId, attemptId, owner };
  startAttempt({ ...common, runId: attemptId, ...bindings, window, before: scene, now });
  let state = readAttempt({ root, taskId, attemptId });
  const intent = startPhase({ ...common, phase: 'prepare', dependencyEventSha256: state.derivedState.lastEventSha256, before: scene, now: now + 1 });
  finishPhase({ ...common, phase: 'prepare', intentSha256: intent.eventSha256, outcome: 'succeeded',
    child: { status: 0, signal: null, error: null }, after: scene, now: now + 2 });
  const failureHash = sha('original pre-child failure');
  recordAttemptEvent({ ...common, name: 'pre_child_failure', value: { sha256: failureHash }, now: now + 3 });
  const failed = finishAttempt({ ...common, outcome: 'failed', after: scene, now: now + 4 });
  const failedBytes = fs.readFileSync(root + '/' + taskId + '/attempts/' + attemptId + '/events/000005.json');
  const nextOwner = { ...owner, token: randomUUID() }, request = { ...common, owner: nextOwner, ...bindings,
    window, terminalEventSha256: failed.eventSha256, failureReceiptSha256: failureHash, before: scene, now: now + 5 };
  assert.throws(() => continueFailedAttempt({ ...request, inspectOwner: () => 'alive' }));
  assert.throws(() => continueFailedAttempt({ ...request, artifacts: { ...artifacts, main: { ...artifacts.main, sourceManifestSha256: sha('new time') } }, inspectOwner: () => 'dead' }));
  continueFailedAttempt({ ...request, inspectOwner: () => 'dead' });
  state = readAttempt({ root, taskId, attemptId });
  assert.equal(state.derivedState.status, 'running'); assert.equal(state.events[4].value.outcome, 'failed');
  assert.equal(state.events[5].value.kind, 'failure_continued');
  assert.deepEqual(fs.readFileSync(root + '/' + taskId + '/attempts/' + attemptId + '/events/000005.json'), failedBytes);
  assert.equal(state.events.filter(e => e.value.kind === 'phase_result' && e.value.outcome === 'succeeded').length, 1);
  return 'same_attempt_continuation_preserves_failed_receipt_and_prior_success';
}
function migration(root, sql, canvas) {
  const db = root + '/synthetic.sqlite', sqlFile = root + '/migration.sql'; fs.writeFileSync(sqlFile, sql, { flag: 'wx', mode: 0o600 });
  call('python3', ['-I', '-c', String.raw`
import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.executescript('CREATE TABLE User(id TEXT PRIMARY KEY);CREATE TABLE Project(id TEXT PRIMARY KEY);CREATE TABLE VideoCard(id TEXT PRIMARY KEY);CREATE TABLE VideoTask(id TEXT PRIMARY KEY,prompt TEXT);CREATE TABLE ApprovalRecord(id TEXT PRIMARY KEY);CREATE TABLE ApprovalUsage(id TEXT PRIMARY KEY,approval_id TEXT);')
c.executescript(sys.argv[2]);c.execute("INSERT INTO VideoTask VALUES ('original','unchanged prompt')");c.commit()
`, db, canvas.toString()]);
  const p = { mode: 'apply', database: db, directory: root + '/schema', sqlFile,
    identity: { runId: randomUUID(), source: 'a'.repeat(40), guardSource: 'b'.repeat(40), manifestSha256: sha('manifest'),
      previousPrismaSha256: sha('previous'), newPrismaSha256: sha('next'), sqlSha256: sha(sql) } };
  const run = value => JSON.parse(call('python3', ['-I', '-c', FULL_SCHEMA_PY, JSON.stringify(value)]));
  const first = run(p), second = run(p); assert.deepEqual(second, first);
  assert.equal(first.businessValuesChanged, false); assert.equal(first.historyBackfilled, false);
  assert.deepEqual(run({ ...p, mode: 'projection' }), first);
  const result = call('python3', ['-I', '-c', "import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1]);print(json.dumps(c.execute('SELECT id,prompt,creation_intent_id FROM VideoTask').fetchall()))", db]);
  assert.deepEqual(JSON.parse(result), [['original', 'unchanged prompt', null]]);
  assert.throws(() => run({ ...p, identity: { ...p.identity, sqlSha256: sha('changed') } }));
  return 'new_schema_preserves_original_values_and_same_run_backup_and_receipt';
}
export function runFullReleaseEngineering(manifestFile) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const m = JSON.parse(fs.readFileSync(manifestFile)); assertFullReleaseInput(m.fullRelease);
  const source = JSON.parse(fs.readFileSync(m.main.sourceManifest));
  const sql = execFileSync('tar', ['-xOzf', m.main.archive, '--', FULL_SQL]); assert.equal(sha(sql), source.files[FULL_SQL]);
  const canvasFile = 'prisma/migrations/20261021180000_canvas_video_batches/migration.sql';
  const canvas = execFileSync('tar', ['-xOzf', m.main.archive, '--', canvasFile]); assert.equal(sha(canvas), source.files[canvasFile]);
  const root = fs.mkdtempSync('/data/sd2-full-release-engineering-'); fs.chmodSync(root, 0o700);
  try {
    const checks = [failedContinuation(root), migration(root, sql, canvas)];
    const drift = structuredClone(m.fullRelease); drift.capabilities.guard.videoCreationV2 = true;
    assert.throws(() => assertFullReleaseInput(drift)); checks.push('compatible_guard_reads_new_schema_without_opening_new_writers');
    return { schema: 'sd2-full-release-engineering.v1', completed: true, checks, productionWrites: 0,
      serviceCalls: 0, completeBuildExecuted: false, paidRequests: 0, browserRuns: 0 };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(runFullReleaseEngineering(process.argv[2])));
