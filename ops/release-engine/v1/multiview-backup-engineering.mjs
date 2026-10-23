import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha, writeJsonExclusive } from './common.mjs';
import { captureMultiviewBackupProtection, publishMultiviewBackupControl,
  inspectMultiviewBackupProtection, privateMultiviewBackupFileProtection } from './multiview-backup-control.mjs';

const SERVICE = 'sd2-backup.service';
const TIMER = 'sd2-backup.timer';
const DROPIN = '/etc/systemd/system/sd2-backup.service.d/90-multiview-works.conf';
const CONTROL = '/data/video-api-debugger/controls/multiview-backup-v1';
const CONTROL_PARENT = path.dirname(CONTROL);
const DATA = '/data', PROJECT = '/data/video-api-debugger';
const BACKUPS = PROJECT + '/backups', STORAGE = PROJECT + '/var-lib/storage';
const WORKS = STORAGE + '/multiview-works', UPLOADS = PROJECT + '/var-lib/uploads';
const DATABASE = PROJECT + '/var-lib/dev.db', ENGINEERING = '/data/video-api-debugger-engineering';
const MINIMUM_FREE = 5 * 1024 ** 3;
const SCRIPT = 'scripts/backup-multiview-works.py';
const SOURCE = 'a'.repeat(40), GUARD = 'b'.repeat(40), OLD = 'c'.repeat(40);
const oldScript = '/data/video-api-debugger/releases/' + OLD + '/' + SCRIPT;
const baseCommand = '{ path=/usr/local/bin/sd2-backup.sh ; argv[]=/usr/local/bin/sd2-backup.sh ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }';

function fixture(label, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiview-backup-' + label + '-'));
  const stage = path.join(root, 'stage'), calls = [], currentUid = process.getuid();
  const currentGid = process.getgid(), appUid = currentUid === 0 ? 1004 : currentUid;
  const appGid = currentUid === 0 ? 1004 : currentGid;
  // Stage/receipt files already use physical paths in this one isolated tree;
  // production-shaped source/unit names are virtual and mapped exactly once.
  // Never fall through to a real absolute path outside the fixture.
  const inside = (file, directory) => file === directory || file.startsWith(directory + path.sep);
  const logical = file => {
    assert.ok(typeof file === 'string' && path.isAbsolute(file) && path.normalize(file) === file);
    if (inside(file, root)) return file;
    assert.ok(file === DATA || inside(file, PROJECT) || inside(file, ENGINEERING) || inside(file, '/etc/systemd'),
      'Unexpected path outside the isolated backup fixture');
    return path.join(root, file.slice(1));
  };
  assert.equal(logical(stage), stage);
  assert.equal(logical(root), root);
  assert.equal(logical(logical(DROPIN)), logical(DROPIN));
  assert.throws(() => logical('/data/video-api-debugger-other/unexpected'));
  assert.throws(() => logical('/etc/passwd'));
  const put = (file, bytes, mode = 0o644) => {
    const target = logical(file); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, bytes, { mode }); fs.chmodSync(target, mode); return target;
  };
  const makeDirectory = (file, mode, uid = currentUid, gid = currentGid) => {
    const target = logical(file); fs.mkdirSync(target, { recursive: true, mode }); fs.chmodSync(target, mode);
    if (currentUid === 0) fs.chownSync(target, uid, gid); return target;
  };
  fs.mkdirSync(stage, { mode: 0o700 });
  makeDirectory(DATA, 0o755); makeDirectory(PROJECT, 0o755);
  makeDirectory(CONTROL_PARENT, 0o750, currentUid, appGid);
  makeDirectory(PROJECT + '/var-lib', 0o755, appUid, appGid);
  makeDirectory(STORAGE, 0o775, appUid, appGid); makeDirectory(WORKS, 0o700, appUid, appGid);
  makeDirectory(UPLOADS, 0o775, appUid, appGid); makeDirectory(BACKUPS, 0o700, appUid, appGid);
  makeDirectory(ENGINEERING, 0o755);
  const runParent = ENGINEERING + '/11111111-1111-4111-8111-111111111111';
  if (!options.missingRunParent) makeDirectory(runParent, 0o755);
  const database = put(DATABASE, Buffer.alloc(8192), 0o640);
  if (currentUid === 0) fs.chownSync(database, appUid, appGid);
  const serviceFragment = '/etc/systemd/system/sd2-backup.service';
  const timerFragment = '/etc/systemd/system/sd2-backup.timer';
  put(serviceFragment, '[Service]\nType=oneshot\nExecStart=/usr/local/bin/sd2-backup.sh\n');
  put(timerFragment, '[Timer]\nOnCalendar=*-*-* 04:00:00\nPersistent=true\n');
  const originalDropin = Buffer.from('[Service]\nTimeoutStartSec=100min\nExecStart=/usr/bin/python3 ' + oldScript
    + ' --database /data/video-api-debugger/var-lib/dev.db --source-root /data/video-api-debugger/var-lib/storage/multiview-works'
    + ' --destination /data/video-api-debugger/backups/multiview-works-${INVOCATION_ID}\n');
  put(DROPIN, originalDropin);
  const program = Buffer.from('#!/usr/bin/python3\nprint("reviewed")\n');
  const mainProgram = program, guardProgram = options.guardMismatch ? Buffer.concat([program, Buffer.from('# mismatch\n')]) : program;
  const scriptHash = sha(mainProgram), guardHash = sha(guardProgram);
  for (const [kind, source, body, digest] of [['main', SOURCE, mainProgram, scriptHash], ['guard', GUARD, guardProgram, guardHash]]) {
    const directory = '/data/video-api-debugger/managed-releases/' + source;
    const candidate = put(directory + '/' + SCRIPT, body);
    if (currentUid === 0) fs.chownSync(candidate, appUid, appUid);
    fs.mkdirSync(path.join(stage, kind), { recursive: true, mode: 0o700 });
    writeJsonExclusive(path.join(stage, kind, 'source-manifest.json'), { schema: 'rate-impl2-source-manifest.v1',
      project: 'video-api-debugger', kind, source, version: kind === 'main' ? '0.103.0' : '0.103.0-guard.1', files: { [SCRIPT]: digest } });
  }
  const m = { schema: 'rate-impl2-release.v1', project: 'video-api-debugger', runId: '11111111-1111-4111-8111-111111111111',
    stage, mainSource: SOURCE, guardSource: GUARD, appUser: 'gouki', database: DATABASE,
    main: { source: SOURCE, root: '/data/video-api-debugger/managed-releases/' + SOURCE, version: '0.103.0', sourceManifest: path.join(stage, 'main/source-manifest.json') },
    guard: { source: GUARD, root: '/data/video-api-debugger/managed-releases/' + GUARD, version: '0.103.0-guard.1', sourceManifest: path.join(stage, 'guard/source-manifest.json') } };
  writeJsonExclusive(path.join(stage, 'manifest.json'), m);
  let loadedDropin = originalDropin, extraDropin = false, timerCalendar = '*-*-* 04:00:00';
  let timerNextElapse = 'Fri 2026-10-23 04:00:00 UTC';
  let availableBytes = options.availableBytes ?? MINIMUM_FREE + 1024 ** 3;
  const serviceExec = () => {
    const text = loadedDropin.toString('utf8');
    const selected = text.match(/ExecStart=\/usr\/bin\/python3 ([^\n]+)/)?.[1]; assert.ok(selected);
    return baseCommand + ' { path=/usr/bin/python3 ; argv[]=/usr/bin/python3 ' + selected
      + ' ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }';
  };
  const values = (name, field) => {
    const service = { Id: SERVICE, LoadState: 'loaded', FragmentPath: serviceFragment,
      DropInPaths: DROPIN + (extraDropin ? ' /etc/systemd/system/sd2-backup.service.d/99-extra.conf' : ''),
      Type: 'oneshot', User: 'gouki', Group: 'gouki', UMask: '0022', WorkingDirectory: '', RootDirectory: '',
      ExecStart: serviceExec(), ExecStartPre: '', ExecStartPost: '', ExecCondition: '', Environment: '', EnvironmentFiles: '',
      TimeoutStartUSec: '1h 40min', TimeoutStopUSec: '1min 30s', RemainAfterExit: 'no', KillMode: 'control-group',
      KillSignal: '15', SendSIGKILL: 'yes', UnitFileState: 'static', ActiveState: 'inactive', SubState: 'dead', MainPID: '0', ControlPID: '0' };
    const timer = { Id: TIMER, LoadState: 'loaded', FragmentPath: timerFragment, DropInPaths: '', Unit: SERVICE,
      TimersMonotonic: '{ OnUnitActiveUSec=6h ; next_elapse=6h }',
      TimersCalendar: '{ OnCalendar=' + timerCalendar + ' ; next_elapse=' + timerNextElapse + ' }',
      AccuracyUSec: '1min', RandomizedDelayUSec: '0',
      FixedRandomDelay: 'no', Persistent: 'yes', WakeSystem: 'no', RemainAfterElapse: 'yes', UnitFileState: 'enabled',
      ActiveState: 'active', SubState: 'waiting' };
    return (name === SERVICE ? service : timer)[field] ?? '';
  };
  const adapter = { expectedUid: currentUid, resolvePath: logical, readBytes: file => fs.readFileSync(logical(file)),
    exists: file => fs.existsSync(logical(file)), entryExists: file => { try { fs.lstatSync(logical(file)); return true; }
      catch (error) { if (error?.code === 'ENOENT') return false; throw error; } },
    attributes: () => '----------------------', assertPrivileged: () => {}, now: () => Date.now(),
    rootDevice: Number(fs.lstatSync(logical(DATA)).dev) + 1, availableBytes: () => availableBytes,
    call(bin, args) {
      calls.push([bin, ...args]);
      if (bin === 'findmnt') {
        assert.deepEqual(args.slice(0, 4), ['-n', '-o', 'TARGET', '-T']);
        const target = args[4];
        assert.ok([DATA, PROJECT, CONTROL_PARENT, CONTROL].includes(target), 'Unexpected backup mount probe');
        return options.mounts?.[target] || (target === CONTROL ? options.controlMount : options.parentMount) || DATA;
      }
      if (bin === 'id') {
        assert.ok(args[0] === '-u' || args[0] === '-g'); assert.equal(args[1], 'gouki');
        return String(args[0] === '-u' ? appUid : appGid);
      }
      assert.equal(bin, 'systemctl');
      if (args[0] === 'daemon-reload') {
        if (options.reloadFailure) throw new Error('synthetic daemon-reload failure');
        loadedDropin = fs.readFileSync(logical(DROPIN)); return '';
      }
      assert.equal(args[0], 'show'); const field = args.find(value => value.startsWith('--property=')).slice('--property='.length);
      return values(args[1], field);
    } };
  return { root, stage, m, adapter, calls, originalDropin, logical, put, makeDirectory, appUid, appGid, runParent,
    program, scriptHash,
    createRunParent() { if (!fs.existsSync(logical(runParent))) makeDirectory(runParent, 0o755); },
    setAvailableBytes(value) { availableBytes = value; },
    setExtraDropin(value) { extraDropin = value; if (value) put('/etc/systemd/system/sd2-backup.service.d/99-extra.conf', '[Service]\n'); },
    setTimerCalendar(value) { timerCalendar = value; }, setTimerNextElapse(value) { timerNextElapse = value; },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); } };
}

const checks = [], failures = [];
function withFixture(label, options, body) {
  const f = fixture(label, options);
  try { body(f); checks.push(label); }
  catch (error) { failures.push({ check: label, name: error.name, code: error.code || null }); }
  finally { f.cleanup(); }
}
function approvePreopen(f, captured) {
  writeJsonExclusive(path.join(f.stage, 'multiview-private-preopen.json'), { schema: 'multiview-private-preopen.v1',
    stage: 'private-preopen', runId: f.m.runId, manifestSha256: captured.manifestSha256, kind: 'main', mode: 'switch',
    healthy: { source: f.m.mainSource }, maintenance: [{ status: 503 }, { status: 503 }], at: new Date().toISOString() });
}
function prepareRecoveredAdoption(f) {
  const captured = captureMultiviewBackupProtection(f.m, f.adapter); approvePreopen(f, captured);
  const priorPublished = publishMultiviewBackupControl(f.m, f.adapter);
  const originStage = PROJECT + '/release-staging/' + f.m.runId;
  f.makeDirectory(PROJECT + '/release-staging', 0o755); f.makeDirectory(originStage, 0o700);
  for (const name of ['manifest.json', 'multiview-backup-before.json', 'multiview-backup-transition.json',
    'multiview-backup-published.json'])
    fs.copyFileSync(path.join(f.stage, name), f.logical(originStage + '/' + name));
  const complete = { schema: 'mv-hd-upload-fault-recovery.v1', runId: f.m.runId,
    manifestSha256: sha(fs.readFileSync(f.logical(originStage + '/manifest.json'))), route: 'fixed-guard',
    completed: true, source: f.m.guardSource, businessDataRestored: false, originalProofAndReceiptsPreserved: true };
  writeJsonExclusive(f.logical(originStage + '/guard-recovery-complete.json'), complete);
  const digest = name => sha(fs.readFileSync(f.logical(originStage + '/' + name)));
  const input = { schema: 'sd2-multiview-r17-recovered-guard.v1', runId: f.m.runId,
    manifestSha256: digest('manifest.json'), backupCaptureSha256: digest('multiview-backup-before.json'),
    backupTransitionSha256: digest('multiview-backup-transition.json'),
    backupPublishedSha256: digest('multiview-backup-published.json'),
    recoveryCompleteSha256: digest('guard-recovery-complete.json') };
  const origin = { ...input, mainSource: f.m.mainSource, guardSource: f.m.guardSource, scriptSha256: f.scriptHash };
  const runId = '22222222-2222-4222-8222-222222222222', stage = path.join(f.root, 'adoption-stage');
  fs.mkdirSync(stage, { mode: 0o700 });
  const m = { ...structuredClone(f.m), runId, stage, recoveredGuardBaseline: input };
  for (const kind of ['main', 'guard']) {
    fs.mkdirSync(path.join(stage, kind), { recursive: true, mode: 0o700 });
    const sourceManifest = path.join(stage, kind, 'source-manifest.json');
    fs.copyFileSync(f.m[kind].sourceManifest, sourceManifest); m[kind].sourceManifest = sourceManifest;
  }
  f.makeDirectory(ENGINEERING + '/' + runId, 0o755);
  writeJsonExclusive(path.join(stage, 'manifest.json'), m); f.adapter.recoveredBackupOrigin = origin;
  return { f: { ...f, m, stage }, m, stage, input, origin, target: priorPublished.target,
    reloads: f.calls.filter(call => call[0] === 'systemctl' && call[1] === 'daemon-reload').length };
}

withFixture('existing_strict_control_directory_and_same_sha_script_are_read_only_admitted', {}, f => {
  f.makeDirectory(CONTROL, 0o755); const target = CONTROL + '/' + f.scriptHash + '.py';
  f.put(target, f.program, 0o644);
  const captured = captureMultiviewBackupProtection(f.m, f.adapter);
  assert.ok(captured.controlInventory.directory); assert.equal(captured.controlInventory.script.sha256, f.scriptHash);
  approvePreopen(f, captured); const published = publishMultiviewBackupControl(f.m, f.adapter);
  assert.equal(published.target, target); assert.deepEqual(fs.readFileSync(f.logical(target)), f.program);
});

withFixture('existing_bad_control_directory_is_rejected_at_capture', {}, f => {
  f.makeDirectory(CONTROL, 0o777);
  assert.throws(() => captureMultiviewBackupProtection(f.m, f.adapter), /Writable trusted directory/);
});

for (const fault of ['mode', 'hash']) withFixture('existing_control_script_bad_' + fault + '_is_rejected_at_capture', {}, f => {
  f.makeDirectory(CONTROL, 0o755); const target = CONTROL + '/' + f.scriptHash + '.py';
  f.put(target, fault === 'hash' ? Buffer.from('wrong reviewed program\n') : f.program, fault === 'mode' ? 0o600 : 0o644);
  assert.throws(() => captureMultiviewBackupProtection(f.m, f.adapter));
});

withFixture('captured_existing_control_script_same_bytes_new_inode_is_rejected_before_publish', {}, f => {
  f.makeDirectory(CONTROL, 0o755); const target = CONTROL + '/' + f.scriptHash + '.py', file = f.put(target, f.program, 0o644);
  captureMultiviewBackupProtection(f.m, f.adapter);
  const retained = file + '.captured'; fs.renameSync(file, retained); fs.writeFileSync(file, f.program, { flag: 'wx', mode: 0o644 });
  assert.notEqual(fs.lstatSync(file).ino, fs.lstatSync(retained).ino);
  assert.throws(() => inspectMultiviewBackupProtection(f.m, f.adapter), /control inventory changed/);
});

withFixture('captured_existing_control_directory_identity_remains_bound_after_publish', {}, f => {
  f.makeDirectory(CONTROL, 0o755); const target = CONTROL + '/' + f.scriptHash + '.py';
  f.put(target, f.program, 0o644);
  const captured = captureMultiviewBackupProtection(f.m, f.adapter); approvePreopen(f, captured);
  publishMultiviewBackupControl(f.m, f.adapter);
  const directory = f.logical(CONTROL), retained = directory + '-captured', script = f.logical(target);
  const originalDirectory = fs.lstatSync(directory), originalScript = fs.lstatSync(script);
  assert.equal(originalScript.nlink, 1); assert.equal(sha(fs.readFileSync(script)), f.scriptHash);
  fs.renameSync(directory, retained); f.makeDirectory(CONTROL, 0o755);
  fs.renameSync(path.join(retained, f.scriptHash + '.py'), script);
  const movedScript = fs.lstatSync(script);
  assert.equal(String(movedScript.dev), String(originalScript.dev));
  assert.equal(String(movedScript.ino), String(originalScript.ino));
  assert.equal(movedScript.nlink, 1); assert.equal(sha(fs.readFileSync(script)), f.scriptHash);
  assert.equal(String(fs.lstatSync(retained).ino), String(originalDirectory.ino));
  assert.notEqual(String(fs.lstatSync(directory).ino), String(originalDirectory.ino));
  assert.throws(() => inspectMultiviewBackupProtection(f.m, f.adapter), /Captured backup control directory identity changed/);
});

withFixture('legal_unique_path_replacement_and_all_four_protections', {}, f => {
  assert.equal(fs.existsSync(f.logical(CONTROL)), false, 'The positive case must begin without the target directory');
  for (const source of [SOURCE, GUARD]) assert.equal(
    fs.lstatSync(f.logical('/data/video-api-debugger/managed-releases/' + source + '/' + SCRIPT)).uid, f.appUid);
  const captured = captureMultiviewBackupProtection(f.m, f.adapter);
  assert.equal(captured.original.service.static.ExecStart.length, 2);
  assert.equal(captured.original.service.static.ExecStart[0].path, '/usr/local/bin/sd2-backup.sh');
  assert.equal(captured.original.service.static.ExecStart[1].path, '/usr/bin/python3');
  assert.ok(captured.original.service.static.ExecStart[1].argv.includes('${INVOCATION_ID}'));
  assert.equal(captured.controlPathBinding.ancestors[CONTROL_PARENT].gid, f.appGid);
  assert.equal(captured.controlPathBinding.ancestors[CONTROL_PARENT].mode, 0o750);
  assert.equal(captured.backupPathPreflight.capacity.mediaInventoryComplete, false);
  assert.deepEqual(captured.controlInventory, { schema: 'sd2-multiview-backup-control-inventory.v1',
    directory: null, script: null });
  approvePreopen(f, captured);
  const published = publishMultiviewBackupControl(f.m, f.adapter);
  const next = fs.readFileSync(f.logical(DROPIN), 'utf8');
  assert.ok(next.includes(published.target) && !next.includes(oldScript));
  assert.ok(fs.lstatSync(f.logical(CONTROL)).isDirectory());
  assert.equal(fs.realpathSync(f.logical(CONTROL)), f.logical(CONTROL));
  const controlDirectory = fs.lstatSync(f.logical(CONTROL));
  assert.equal(controlDirectory.uid, process.getuid()); assert.equal(controlDirectory.gid, process.getuid());
  assert.equal(controlDirectory.mode & 0o7777, 0o755);
  const controlScript = fs.lstatSync(f.logical(published.target));
  assert.equal(controlScript.uid, process.getuid()); assert.equal(controlScript.gid, process.getuid());
  assert.equal(controlScript.mode & 0o7777, 0o644);
  for (const target of [DATA, PROJECT, CONTROL_PARENT, CONTROL]) assert.ok(
    f.calls.some(call => call[0] === 'findmnt' && call.at(-1) === target), 'Missing mount check for ' + target);
  assert.equal(next.replace(published.target, oldScript), f.originalDropin.toString('utf8'));
  assert.deepEqual(inspectMultiviewBackupProtection(f.m, f.adapter), captured.projection);
  const state = JSON.parse(fs.readFileSync(path.join(f.stage, 'multiview-backup-transition.json'))).dropin.next;
  assert.deepEqual(privateMultiviewBackupFileProtection(f.m, DROPIN, state, f.adapter),
    captured.original.service.files[DROPIN].state);
  assert.throws(() => privateMultiviewBackupFileProtection(f.m, '/etc/systemd/system/other.conf', state, f.adapter));
});

withFixture('wrong_parent_mount_rejected_before_control_directory_creation', { parentMount: '/' }, f => {
  assert.throws(() => captureMultiviewBackupProtection(f.m, f.adapter), /real data mount/);
  assert.equal(fs.existsSync(f.logical(CONTROL)), false);
});

withFixture('world_writable_parent_rejected_before_control_directory_creation', {}, f => {
  fs.chmodSync(f.logical(CONTROL_PARENT), 0o777);
  assert.throws(() => captureMultiviewBackupProtection(f.m, f.adapter), /Writable trusted directory/);
  assert.equal(fs.existsSync(f.logical(CONTROL)), false);
});

withFixture('non_root_control_ancestor_rejected_at_capture', {}, f => {
  if (process.getuid() === 0) fs.chownSync(f.logical(PROJECT), f.appUid, f.appGid);
  else f.adapter.expectedUid += 1;
  assert.throws(() => captureMultiviewBackupProtection(f.m, f.adapter), /trusted directory owner/);
});

withFixture('symlinked_control_ancestor_rejected_at_capture', {}, f => {
  const parent = f.logical(CONTROL_PARENT), retained = parent + '-retained';
  fs.renameSync(parent, retained); fs.symlinkSync(retained, parent);
  assert.throws(() => captureMultiviewBackupProtection(f.m, f.adapter), /path alias refused/);
});

withFixture('captured_control_parent_mode_drift_rejected', {}, f => {
  captureMultiviewBackupProtection(f.m, f.adapter); fs.chmodSync(f.logical(CONTROL_PARENT), 0o700);
  assert.throws(() => inspectMultiviewBackupProtection(f.m, f.adapter), /ancestor identity changed/);
});

withFixture('captured_control_parent_gid_drift_rejected', {}, f => {
  captureMultiviewBackupProtection(f.m, f.adapter);
  if (process.getuid() === 0) fs.chownSync(f.logical(CONTROL_PARENT), 0, f.appGid + 1);
  else fs.chmodSync(f.logical(CONTROL_PARENT), 0o700);
  assert.throws(() => inspectMultiviewBackupProtection(f.m, f.adapter), /ancestor identity changed/);
});

withFixture('captured_control_parent_identity_drift_rejected', {}, f => {
  captureMultiviewBackupProtection(f.m, f.adapter);
  const parent = f.logical(CONTROL_PARENT), retained = parent + '-captured';
  fs.renameSync(parent, retained); f.makeDirectory(CONTROL_PARENT, 0o750, process.getuid(), f.appGid);
  assert.notEqual(fs.lstatSync(parent).ino, fs.lstatSync(retained).ino);
  assert.throws(() => inspectMultiviewBackupProtection(f.m, f.adapter), /ancestor identity changed/);
});

for (const [field, message] of [['controlPathBinding', /lacks the required control path binding/],
  ['backupPathPreflight', /lacks the required backup path preflight/],
  ['controlInventory', /lacks the required control inventory/]]) {
  withFixture('capture_without_' + field + '_is_never_defaulted', {}, f => {
    captureMultiviewBackupProtection(f.m, f.adapter);
    const file = path.join(f.stage, 'multiview-backup-before.json'), captured = JSON.parse(fs.readFileSync(file));
    delete captured[field]; fs.writeFileSync(file, JSON.stringify(captured));
    assert.throws(() => inspectMultiviewBackupProtection(f.m, f.adapter), message);
  });
}

withFixture('release_public_uploads_alias_does_not_change_the_canonical_backup_input', {}, f => {
  const logicalUploads = f.logical(PROJECT + '/managed-releases/' + SOURCE + '/public/uploads');
  fs.mkdirSync(path.dirname(logicalUploads), { mode: 0o755 }); fs.symlinkSync(f.logical(UPLOADS), logicalUploads);
  const captured = captureMultiviewBackupProtection(f.m, f.adapter);
  assert.equal(fs.realpathSync(logicalUploads), f.logical(UPLOADS));
  assert.equal(fs.lstatSync(logicalUploads).isSymbolicLink(), true);
  assert.equal(captured.backupPathPreflight.paths.uploads.logicalAlias, false);
  assert.equal(captured.controlPathBinding.ancestors[CONTROL_PARENT].mode, 0o750);
});

withFixture('backup_consumer_no_follow_canonical_uploads_rejects_alias', {}, f => {
  const canonical = f.logical(UPLOADS), retained = f.logical(PROJECT + '/var-lib/uploads-resolved');
  fs.renameSync(canonical, retained); fs.symlinkSync(retained, canonical);
  assert.throws(() => captureMultiviewBackupProtection(f.m, f.adapter), /consumer path alias refused/);
});

withFixture('backup_consumer_no_follow_works_path_still_rejects_alias', {}, f => {
  const logicalWorks = f.logical(WORKS), resolvedWorks = f.logical(STORAGE + '/multiview-works-resolved');
  fs.renameSync(logicalWorks, resolvedWorks); fs.symlinkSync(resolvedWorks, logicalWorks);
  assert.throws(() => captureMultiviewBackupProtection(f.m, f.adapter), /consumer path alias refused/);
});

withFixture('unsafe_existing_backup_parent_rejected_at_capture', {}, f => {
  fs.chmodSync(f.logical(BACKUPS), 0o750);
  assert.throws(() => captureMultiviewBackupProtection(f.m, f.adapter), /backup path mode/);
});

withFixture('noncontractual_business_metadata_is_recorded_not_promoted_to_hard_limits', {}, f => {
  fs.chmodSync(f.logical(STORAGE), 0o750); fs.chmodSync(f.logical(WORKS), 0o750);
  fs.chmodSync(f.logical(UPLOADS), 0o700); fs.chmodSync(f.logical(DATABASE), 0o600);
  fs.chmodSync(f.logical(ENGINEERING), 0o700); fs.chmodSync(f.logical(f.runParent), 0o700);
  if (process.getuid() === 0) {
    fs.chownSync(f.logical(ENGINEERING), 0, f.appGid); fs.chownSync(f.logical(f.runParent), 0, f.appGid);
  }
  const captured = captureMultiviewBackupProtection(f.m, f.adapter);
  assert.equal(captured.backupPathPreflight.paths.storage.mode, 0o750);
  assert.equal(captured.backupPathPreflight.paths.works.mode, 0o750);
  assert.equal(captured.backupPathPreflight.paths.uploads.mode, 0o700);
  assert.equal(captured.backupPathPreflight.paths.database.mode, 0o600);
  assert.equal(captured.backupPathPreflight.paths.engineering.mode, 0o700);
});

for (const receipt of ['main-prepared.json', 'guard-prepared.json'])
  withFixture('early_capture_allows_absent_restore_parent_until_' + receipt, { missingRunParent: true }, f => {
    const captured = captureMultiviewBackupProtection(f.m, f.adapter);
    assert.equal(captured.backupPathPreflight.paths.runParent, undefined);
    assert.deepEqual(inspectMultiviewBackupProtection(f.m, f.adapter), captured.projection);
    writeJsonExclusive(path.join(f.stage, receipt), { prepared: true });
    assert.throws(() => inspectMultiviewBackupProtection(f.m, f.adapter), /restore parent is not ready/);
    f.createRunParent(); assert.deepEqual(inspectMultiviewBackupProtection(f.m, f.adapter), captured.projection);
  });

for (const kind of ['backup', 'restore']) withFixture('occupied_future_' + kind + '_target_rejected', {}, f => {
  const target = kind === 'backup' ? BACKUPS + '/multiview-private-' + f.m.runId
    : f.runParent + '/restore-' + f.m.mainSource;
  f.makeDirectory(target, 0o700, kind === 'backup' ? f.appUid : process.getuid(),
    kind === 'backup' ? f.appGid : process.getuid());
  assert.throws(() => captureMultiviewBackupProtection(f.m, f.adapter), /target is already occupied/);
});

withFixture('space_below_five_gib_plus_known_database_rejected', { availableBytes: MINIMUM_FREE + 8191 }, f => {
  assert.throws(() => captureMultiviewBackupProtection(f.m, f.adapter), /space is below/);
});

withFixture('independent_control_mount_rejected', { controlMount: CONTROL }, f => {
  const captured = captureMultiviewBackupProtection(f.m, f.adapter);
  approvePreopen(f, captured);
  assert.throws(() => publishMultiviewBackupControl(f.m, f.adapter), /real data mount/);
});

withFixture('symlinked_control_directory_rejected', {}, f => {
  const captured = captureMultiviewBackupProtection(f.m, f.adapter);
  const elsewhere = path.join(f.root, 'elsewhere'); fs.mkdirSync(elsewhere, { mode: 0o755 });
  fs.symlinkSync(elsewhere, f.logical(CONTROL));
  approvePreopen(f, captured);
  assert.throws(() => publishMultiviewBackupControl(f.m, f.adapter));
});

withFixture('world_writable_control_directory_rejected', {}, f => {
  const captured = captureMultiviewBackupProtection(f.m, f.adapter);
  fs.mkdirSync(f.logical(CONTROL), { mode: 0o755 }); fs.chmodSync(f.logical(CONTROL), 0o777);
  approvePreopen(f, captured);
  assert.throws(() => publishMultiviewBackupControl(f.m, f.adapter));
});

withFixture('unsafe_restore_parent_rejected_before_control_publication', {}, f => {
  const captured = captureMultiviewBackupProtection(f.m, f.adapter);
  fs.chmodSync(f.logical(f.runParent), 0o777); approvePreopen(f, captured);
  assert.throws(() => publishMultiviewBackupControl(f.m, f.adapter), /Writable trusted directory/);
  assert.equal(fs.existsSync(f.logical(CONTROL)), false);
});

withFixture('changed_original_hash_refuses_cas_without_reload_or_start', {}, f => {
  captureMultiviewBackupProtection(f.m, f.adapter);
  const bytes = fs.readFileSync(f.logical(DROPIN)); fs.writeFileSync(f.logical(DROPIN), Buffer.concat([bytes, Buffer.from('# changed\n')]));
  const captured = JSON.parse(fs.readFileSync(path.join(f.stage, 'multiview-backup-before.json')));
  writeJsonExclusive(path.join(f.stage, 'multiview-private-preopen.json'), { schema: 'multiview-private-preopen.v1', stage: 'private-preopen',
    runId: f.m.runId, manifestSha256: captured.manifestSha256, kind: 'main', mode: 'switch', healthy: { source: f.m.mainSource },
    maintenance: [{ status: 503 }, { status: 503 }], at: new Date().toISOString() });
  assert.throws(() => publishMultiviewBackupControl(f.m, f.adapter));
  assert.ok(!f.calls.some(call => call.includes('daemon-reload') || call.includes('start') || call.includes('enable')));
});

withFixture('main_guard_script_mismatch_rejected_at_capture', { guardMismatch: true }, f => {
  assert.throws(() => captureMultiviewBackupProtection(f.m, f.adapter));
});

withFixture('extra_effective_dropin_rejected', {}, f => {
  const captured = captureMultiviewBackupProtection(f.m, f.adapter); f.setExtraDropin(true);
  assert.throws(() => inspectMultiviewBackupProtection(f.m, f.adapter));
  assert.deepEqual(privateMultiviewBackupFileProtection(f.m, DROPIN,
    captured.original.service.files[DROPIN].state, f.adapter), captured.original.service.files[DROPIN].state);
});

withFixture('same_bytes_new_inode_and_permission_change_rejected', {}, f => {
  const captured = captureMultiviewBackupProtection(f.m, f.adapter), file = f.logical(DROPIN), bytes = fs.readFileSync(file);
  // Keep the old inode allocated: unlink/recreate may immediately reuse it on
  // Linux, which would not actually construct the promised negative scenario.
  fs.renameSync(file, file + '.captured'); fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o644 });
  assert.notEqual(String(fs.lstatSync(file).ino), captured.original.service.files[DROPIN].state.identity[1]);
  assert.throws(() => inspectMultiviewBackupProtection(f.m, f.adapter));
  fs.chmodSync(file, 0o600); assert.throws(() => privateMultiviewBackupFileProtection(f.m, DROPIN,
    { ...captured.original.service.files[DROPIN].state, mode: 0o600 }, f.adapter));
});

withFixture('timer_static_change_rejected', {}, f => {
  captureMultiviewBackupProtection(f.m, f.adapter); f.setTimerCalendar('*-*-* 05:00:00');
  assert.throws(() => inspectMultiviewBackupProtection(f.m, f.adapter));
});

withFixture('timer_next_elapse_change_is_not_static_configuration', {}, f => {
  const captured = captureMultiviewBackupProtection(f.m, f.adapter);
  f.setTimerNextElapse('Sat 2026-10-24 04:00:00 UTC');
  assert.deepEqual(inspectMultiviewBackupProtection(f.m, f.adapter), captured.projection);
});

withFixture('reload_failure_never_starts_or_enables_and_keeps_new_guard', { reloadFailure: true }, f => {
  const captured = captureMultiviewBackupProtection(f.m, f.adapter);
  writeJsonExclusive(path.join(f.stage, 'multiview-private-preopen.json'), { schema: 'multiview-private-preopen.v1',
    stage: 'private-preopen', runId: f.m.runId, manifestSha256: captured.manifestSha256, kind: 'main', mode: 'switch',
    healthy: { source: f.m.mainSource }, maintenance: [{ status: 503 }, { status: 503 }], at: new Date().toISOString() });
  assert.throws(() => publishMultiviewBackupControl(f.m, f.adapter), /daemon-reload/);
  const next = fs.readFileSync(f.logical(DROPIN), 'utf8');
  assert.ok(next.includes(CONTROL + '/') && !next.includes(oldScript));
  assert.ok(!f.calls.some(call => call.includes('start') || call.includes('enable')));
});

withFixture('published_control_script_wrong_mode_is_rejected', {}, f => {
  const captured = captureMultiviewBackupProtection(f.m, f.adapter); approvePreopen(f, captured);
  const published = publishMultiviewBackupControl(f.m, f.adapter);
  fs.chmodSync(f.logical(published.target), 0o600);
  assert.throws(() => inspectMultiviewBackupProtection(f.m, f.adapter));
});

withFixture('published_control_script_same_bytes_new_inode_is_rejected', {}, f => {
  const captured = captureMultiviewBackupProtection(f.m, f.adapter); approvePreopen(f, captured);
  const published = publishMultiviewBackupControl(f.m, f.adapter), file = f.logical(published.target);
  const bytes = fs.readFileSync(file), retained = file + '.captured'; fs.renameSync(file, retained);
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o644 });
  assert.notEqual(fs.lstatSync(file).ino, fs.lstatSync(retained).ino);
  assert.throws(() => inspectMultiviewBackupProtection(f.m, f.adapter));
});

withFixture('exact_r17_recovered_control_is_adopted_without_control_mutation_or_reload', {}, f => {
  const prepared = prepareRecoveredAdoption(f), target = f.logical(prepared.target);
  const beforeTarget = fs.lstatSync(target), beforeDropin = fs.lstatSync(f.logical(DROPIN));
  const captured = captureMultiviewBackupProtection(prepared.m, f.adapter);
  assert.equal(captured.adoptionOrigin.schema, 'sd2-multiview-backup-r17-adoption-origin.v1');
  approvePreopen(prepared.f, captured);
  const receipt = publishMultiviewBackupControl(prepared.m, f.adapter);
  assert.equal(receipt.schema, 'sd2-multiview-backup-adopted.v1'); assert.equal(receipt.adopted, true);
  assert.equal(receipt.newPublication, false); assert.equal(receipt.controlScriptCreated, false);
  assert.equal(receipt.pendingCreated, false);
  assert.equal(receipt.dropinRenamed, false); assert.equal(receipt.daemonReloaded, false);
  assert.deepEqual(publishMultiviewBackupControl(prepared.m, f.adapter), receipt);
  assert.equal(fs.lstatSync(target).ino, beforeTarget.ino); assert.equal(fs.lstatSync(f.logical(DROPIN)).ino, beforeDropin.ino);
  assert.equal(fs.existsSync(f.logical(DROPIN + '.' + prepared.m.runId + '.pending')), false);
  assert.equal(f.calls.filter(call => call[0] === 'systemctl' && call[1] === 'daemon-reload').length, prepared.reloads);
  assert.deepEqual(inspectMultiviewBackupProtection(prepared.m, f.adapter), captured.projection);
  assert.deepEqual(privateMultiviewBackupFileProtection(prepared.m, DROPIN,
    captured.original.service.files[DROPIN].state, f.adapter), captured.original.service.files[DROPIN].state);
});

withFixture('recovered_control_without_exact_manifest_origin_is_rejected', {}, f => {
  const prepared = prepareRecoveredAdoption(f);
  delete prepared.m.recoveredGuardBaseline.backupPublishedSha256;
  fs.writeFileSync(path.join(prepared.stage, 'manifest.json'), JSON.stringify(prepared.m, null, 2) + '\n');
  assert.throws(() => captureMultiviewBackupProtection(prepared.m, f.adapter), /exact R17 recovery origin/);
});

withFixture('recovered_control_with_drifted_recovery_pin_is_rejected', {}, f => {
  const prepared = prepareRecoveredAdoption(f);
  prepared.m.recoveredGuardBaseline.recoveryCompleteSha256 = '0'.repeat(64);
  fs.writeFileSync(path.join(prepared.stage, 'manifest.json'), JSON.stringify(prepared.m, null, 2) + '\n');
  assert.throws(() => captureMultiviewBackupProtection(prepared.m, f.adapter), /exact R17 recovery origin/);
});

withFixture('recovered_control_with_changed_candidate_script_hash_is_rejected', {}, f => {
  const prepared = prepareRecoveredAdoption(f), different = sha(Buffer.from('different candidate\n'));
  for (const kind of ['main', 'guard']) {
    const file = prepared.m[kind].sourceManifest, manifest = JSON.parse(fs.readFileSync(file));
    manifest.files[SCRIPT] = different; fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  }
  fs.writeFileSync(path.join(prepared.stage, 'manifest.json'), JSON.stringify(prepared.m, null, 2) + '\n');
  assert.throws(() => captureMultiviewBackupProtection(prepared.m, f.adapter));
});

withFixture('recovered_control_with_changed_target_identity_is_rejected', {}, f => {
  const prepared = prepareRecoveredAdoption(f), file = f.logical(prepared.target), retained = file + '.retained';
  fs.renameSync(file, retained); fs.writeFileSync(file, f.program, { flag: 'wx', mode: 0o644 });
  assert.notEqual(fs.lstatSync(file).ino, fs.lstatSync(retained).ino);
  assert.throws(() => captureMultiviewBackupProtection(prepared.m, f.adapter), /script identity changed/);
});

withFixture('recovered_control_with_changed_target_bytes_is_rejected', {}, f => {
  const prepared = prepareRecoveredAdoption(f);
  fs.writeFileSync(f.logical(prepared.target), Buffer.from('changed managed script\n'));
  assert.throws(() => captureMultiviewBackupProtection(prepared.m, f.adapter));
});

withFixture('recovered_control_with_unknown_managed_path_is_rejected', {}, f => {
  const prepared = prepareRecoveredAdoption(f), other = CONTROL + '/' + 'd'.repeat(64) + '.py';
  f.put(other, f.program, 0o644);
  const file = f.logical(DROPIN), bytes = fs.readFileSync(file, 'utf8').replace(prepared.target, other);
  fs.writeFileSync(file, bytes); f.adapter.call('systemctl', ['daemon-reload']);
  assert.throws(() => captureMultiviewBackupProtection(prepared.m, f.adapter));
});

withFixture('recovered_control_with_timer_drift_is_rejected', {}, f => {
  const prepared = prepareRecoveredAdoption(f); f.setTimerCalendar('*-*-* 05:00:00');
  assert.throws(() => captureMultiviewBackupProtection(prepared.m, f.adapter), /exact recovered R17 timer/);
});

console.log(JSON.stringify({ schema: 'sd2-multiview-backup-engineering.v1', completed: failures.length === 0, synthetic: true,
  productionWrites: 0, servicesChanged: false, timersStartedOrEnabled: false, checks, failures }));
if (failures.length) process.exitCode = 1;
