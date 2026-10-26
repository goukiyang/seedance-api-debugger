import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rootFile, sha, call, writeJsonExclusive } from './common.mjs';

const SERVICE = 'sd2-backup.service';
const TIMER = 'sd2-backup.timer';
const DROPIN = '/etc/systemd/system/sd2-backup.service.d/90-multiview-works.conf';
const CONTROL_DIRECTORY = '/data/video-api-debugger/controls/multiview-backup-v1';
const CONTROL_PARENT = path.dirname(CONTROL_DIRECTORY);
const DATA_MOUNT = '/data';
const PROJECT_ROOT = '/data/video-api-debugger';
const BACKUP_PARENT = PROJECT_ROOT + '/backups';
const VAR_LIB = PROJECT_ROOT + '/var-lib';
const STORAGE_ROOT = VAR_LIB + '/storage';
const WORKS_ROOT = STORAGE_ROOT + '/multiview-works';
const UPLOADS_ROOT = PROJECT_ROOT + '/var-lib/uploads';
const ENGINEERING_ROOT = '/data/video-api-debugger-engineering';
const MINIMUM_FREE = 5 * 1024 ** 3;
const SCRIPT = 'scripts/backup-multiview-works.py';
const CAPTURE = 'multiview-backup-before.json';
const TRANSITION = 'multiview-backup-transition.json';
const PUBLISHED = 'multiview-backup-published.json';
const PREOPEN = 'multiview-private-preopen.json';
const R17_BACKUP_ORIGIN = Object.freeze({
  schema: 'sd2-multiview-r17-recovered-guard.v1',
  runId: '19a7cc3d-b11e-44c8-a754-d79e9c5624d1',
  manifestSha256: '00d4c9fa89a4368d0761adff3017ff2e58dcd8e58cc76b7698c3bab167cce7c8',
  mainSource: 'd6c611d353b6f3da665993fe62a1a5b4dbe65f81',
  guardSource: '31bff5a6544a3d18d433b81fa7735ed57b0d012c',
  scriptSha256: 'b22f9b49d1bc6571425661fe795d8b6dcdf48bc2cd860ab910d148648161c00d',
  backupCaptureSha256: '9968b7d35f258f185e79b51bea38c6e5566dcdc4f9998d8333da1f87a06461d6',
  backupTransitionSha256: '01fbea5139db7184ae14238c6b11bf317b648b5bba248e698dcb09a1d2e0a97f',
  backupPublishedSha256: '78d22884d7bacdbf9d20d8c2d491ab9898f7518100116f037cd5620d58d49e88',
  recoveryCompleteSha256: 'd4c3feb67e7441cd74b6df492a5ed2652e3a1e1473310f7952ee2a09651dce9b',
});

const SERVICE_FIELDS = [
  'Id', 'LoadState', 'FragmentPath', 'DropInPaths', 'Type', 'User', 'Group', 'UMask', 'WorkingDirectory',
  'RootDirectory', 'ExecStart', 'ExecStartPre', 'ExecStartPost', 'ExecCondition', 'Environment',
  'EnvironmentFiles', 'TimeoutStartUSec', 'TimeoutStopUSec', 'RemainAfterExit', 'KillMode', 'KillSignal',
  'SendSIGKILL',
];
const TIMER_FIELDS = [
  'Id', 'LoadState', 'FragmentPath', 'DropInPaths', 'Unit', 'TimersMonotonic', 'TimersCalendar',
  'AccuracyUSec', 'RandomizedDelayUSec', 'FixedRandomDelay', 'Persistent', 'WakeSystem', 'RemainAfterElapse',
];
const HASH = /^[a-f0-9]{64}$/;
const RELEASE_SCRIPT = /\/data\/video-api-debugger\/releases\/[a-f0-9]{40}\/scripts\/backup-multiview-works\.py/g;
const CONTROL_SCRIPT = /\/data\/video-api-debugger\/controls\/multiview-backup-v1\/[a-f0-9]{64}\.py/g;

function environment(adapter = {}) {
  const resolve = adapter.resolvePath || (file => file);
  const readBytes = adapter.readBytes || (file => rootFile(resolve(file)));
  const exists = adapter.exists || (file => fs.existsSync(resolve(file)));
  const attributes = adapter.attributes || (file => call('lsattr', ['-d', '--', resolve(file)]).split(/\s+/)[0]);
  const expectedUid = adapter.expectedUid ?? 0;
  const fileState = adapter.fileState || (file => {
    const physical = resolve(file), stat = fs.lstatSync(physical);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'Untrusted backup control file: ' + file);
    assert.equal(stat.uid, expectedUid, 'Unexpected backup control owner: ' + file);
    assert.equal(stat.gid, expectedUid, 'Unexpected backup control group: ' + file);
    assert.equal(stat.mode & 0o022, 0, 'Writable backup control file: ' + file);
    return { identity: [String(stat.dev), String(stat.ino)], uid: stat.uid, gid: stat.gid,
      mode: stat.mode & 0o7777, sha256: sha(fs.readFileSync(physical)), attributes: attributes(file) };
  });
  const writeJson = adapter.writeJsonExclusive || ((file, value) => writeJsonExclusive(resolve(file), value));
  const entryExists = adapter.entryExists || (file => {
    try { fs.lstatSync(resolve(file)); return true; }
    catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  });
  const writeExclusive = adapter.writeExclusive || ((file, bytes, mode) => {
    const fd = fs.openSync(resolve(file), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | fs.constants.O_NOFOLLOW, mode);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const directory = fs.openSync(path.dirname(resolve(file)), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  });
  const rename = adapter.rename || ((from, to) => {
    fs.renameSync(resolve(from), resolve(to));
    const directory = fs.openSync(path.dirname(resolve(to)), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  });
  const mkdir = adapter.mkdir || (directory => fs.mkdirSync(resolve(directory), { mode: 0o755 }));
  const availableBytes = adapter.availableBytes || (directory => {
    const state = fs.statfsSync(resolve(directory)); return Number(state.bavail) * Number(state.bsize);
  });
  return { resolve, readBytes, exists, entryExists, attributes, expectedUid, fileState, writeJson, writeExclusive, rename, mkdir,
    availableBytes, rootDevice: adapter.rootDevice ?? fs.statSync('/').dev,
    recoveredBackupOrigin: adapter.recoveredBackupOrigin || R17_BACKUP_ORIGIN,
    invoke: adapter.call || call, now: adapter.now || (() => Date.now()),
    assertPrivileged: adapter.assertPrivileged || (() => {
      assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
    }) };
}

function json(a, file, maximum = 32 * 1024 * 1024) {
  const bytes = a.readBytes(file, maximum);
  return JSON.parse(bytes.toString('utf8'));
}
function candidateBytes(a, file, expectedUid, maximum = 32 * 1024 * 1024) {
  const physical = a.resolve(file);
  assert.equal(fs.realpathSync(physical), physical, 'Candidate script path alias refused');
  const named = fs.lstatSync(physical);
  assert.ok(named.isFile() && !named.isSymbolicLink() && named.nlink === 1
    && named.uid === expectedUid && !(named.mode & 0o022)
    && named.size > 0 && named.size <= maximum, 'Untrusted app-owned candidate script: ' + file);
  const fd = fs.openSync(physical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'gid', 'nlink'])
      assert.equal(opened[key], named[key], 'Candidate changed while opening: ' + file);
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), final = fs.lstatSync(physical);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'gid', 'nlink']) {
      assert.equal(after[key], opened[key], 'Opened candidate changed while reading: ' + file);
      assert.equal(final[key], opened[key], 'Named candidate changed while reading: ' + file);
    }
    assert.equal(bytes.length, opened.size); return bytes;
  } finally { fs.closeSync(fd); }
}
function manifestSha(m, a) {
  const bytes = a.readBytes(m.stage + '/manifest.json', 1024 * 1024);
  assert.deepEqual(JSON.parse(bytes), m, 'Use the exact immutable release manifest');
  return sha(bytes);
}
function bound(m, a, value, schema) {
  assert.equal(value.schema, schema); assert.equal(value.runId, m.runId);
  assert.equal(value.manifestSha256, manifestSha(m, a));
  assert.equal(value.mainSource, m.mainSource); assert.equal(value.guardSource, m.guardSource);
  return value;
}
function property(a, name, field) {
  return a.invoke('systemctl', ['show', name, '--property=' + field, '--value']);
}
function execField(body, name) {
  const marker = name + '=', start = body.indexOf(marker);
  assert.ok(start >= 0, 'Missing ExecStart field: ' + name);
  const valueStart = start + marker.length, end = body.indexOf(' ; ', valueStart);
  return body.slice(valueStart, end < 0 ? body.length : end).trim();
}
function parseExecStart(value) {
  if (!value.trim()) return [];
  const commands = []; let depth = 0, start = -1, outside = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '{') {
      if (depth === 0) { outside += value.slice(start < 0 ? 0 : start, index); start = index + 1; }
      depth += 1;
    } else if (character === '}') {
      assert.ok(depth > 0, 'Unbalanced ExecStart closing brace'); depth -= 1;
      if (depth === 0) {
        const body = value.slice(start, index);
        commands.push({ path: execField(body, 'path'), argv: execField(body, 'argv[]'),
          ignore_errors: execField(body, 'ignore_errors') });
        start = index + 1;
      }
    }
  }
  assert.equal(depth, 0, 'Unbalanced ExecStart opening brace'); outside += value.slice(start < 0 ? 0 : start);
  assert.equal(outside.trim(), '', 'Unexpected text outside ExecStart command blocks');
  assert.ok(commands.length > 0, 'Unparseable ExecStart configuration');
  return commands;
}
function parseTimerSettings(value, calendar) {
  if (!value.trim()) return [];
  const settings = [], pattern = /\{([^{}]*)\}/g; let match;
  while ((match = pattern.exec(value))) {
    const fields = match[1].trim().split(/\s+;\s+/).filter(Boolean).filter(field => !field.startsWith('next_elapse='));
    assert.equal(fields.length, 1, 'Unexpected timer setting fields');
    const at = fields[0].indexOf('='); assert.ok(at > 0);
    const name = fields[0].slice(0, at), setting = fields[0].slice(at + 1);
    if (calendar) assert.equal(name, 'OnCalendar');
    else assert.match(name, /^On[A-Za-z]+USec$/);
    assert.ok(setting); settings.push({ name, setting });
  }
  assert.ok(settings.length > 0, 'Unparseable timer configuration');
  assert.equal(value.replace(/\{[^{}]*\}/g, '').trim(), '', 'Unexpected timer configuration text');
  return settings;
}
function paths(value) {
  if (!value.trim()) return [];
  const result = value.trim().split(/\s+/);
  for (const file of result) assert.ok(path.isAbsolute(file) && !file.includes('..'), 'Unsafe systemd path');
  return result;
}
function observeUnit(a, name, fields) {
  const values = {};
  for (const field of fields) {
    const value = property(a, name, field);
    values[field] = field === 'ExecStart' ? parseExecStart(value)
      : field === 'TimersCalendar' ? parseTimerSettings(value, true)
        : field === 'TimersMonotonic' ? parseTimerSettings(value, false) : value;
  }
  const filePaths = [...new Set([values.FragmentPath, ...paths(values.DropInPaths)])];
  assert.ok(filePaths[0] && path.isAbsolute(filePaths[0]));
  const files = Object.fromEntries(filePaths.map(file => [file, {
    state: a.fileState(file), bytesBase64: a.readBytes(file).toString('base64'),
  }]));
  return { static: values, unitFileState: property(a, name, 'UnitFileState'),
    activeState: property(a, name, 'ActiveState'), subState: property(a, name, 'SubState'), files };
}
function observe(a) {
  const service = observeUnit(a, SERVICE, SERVICE_FIELDS), timer = observeUnit(a, TIMER, TIMER_FIELDS);
  const runtime = { MainPID: property(a, SERVICE, 'MainPID'), ControlPID: property(a, SERVICE, 'ControlPID') };
  return { service, timer, runtime };
}
function projection(observed) {
  return { service: observed.service, timer: observed.timer };
}
function assertStopped(observed) {
  assert.equal(observed.service.activeState, 'inactive');
  assert.equal(observed.runtime.MainPID, '0'); assert.equal(observed.runtime.ControlPID, '0');
}
function assertTimerRunning(observed) {
  assert.equal(observed.timer.unitFileState, 'enabled'); assert.equal(observed.timer.activeState, 'active');
}
function assertFiles(a, expected, except = null) {
  for (const [file, captured] of Object.entries(expected)) {
    if (file === except) continue;
    assert.deepEqual(a.fileState(file), captured.state, 'Protected systemd file changed: ' + file);
    assert.equal(a.readBytes(file).toString('base64'), captured.bytesBase64, 'Protected systemd bytes changed: ' + file);
  }
}
function readCapture(m, a) {
  const value = bound(m, a, json(a, m.stage + '/' + CAPTURE), 'sd2-multiview-backup-capture.v1');
  assert.equal(value.controlPathBinding?.schema, 'sd2-multiview-backup-control-path-binding.v1',
    'Backup capture lacks the required control path binding');
  assert.equal(value.backupPathPreflight?.schema, 'sd2-multiview-backup-path-preflight.v1',
    'Backup capture lacks the required backup path preflight');
  assert.equal(value.controlInventory?.schema, 'sd2-multiview-backup-control-inventory.v1',
    'Backup capture lacks the required control inventory');
  const configured = configuredScript(value);
  if (configured.startsWith(CONTROL_DIRECTORY + '/')) {
    assert.ok(value.adoptionOrigin, 'A managed backup script requires its exact recovered adoption origin');
    assert.deepEqual(value.adoptionOrigin, exactRecoveredBackupOrigin(m, a, value),
      'Recovered backup adoption origin changed');
  } else {
    assert.equal(value.adoptionOrigin, undefined, 'A release backup script cannot carry a recovered adoption origin');
    assert.equal(value.oldScriptPath, oldScript(value));
  }
  return value;
}
function scriptSources(m, a) {
  const result = {};
  for (const kind of ['main', 'guard']) {
    const bytes = a.readBytes(m[kind].sourceManifest);
    const source = JSON.parse(bytes);
    assert.equal(source.schema, 'rate-impl2-source-manifest.v1'); assert.equal(source.project, m.project);
    assert.equal(source.kind, kind); assert.equal(source.source, m[kind].source);
    assert.equal(source.version, m[kind].version); assert.match(source.files?.[SCRIPT], HASH);
    result[kind] = { source: m[kind].source, sourceManifest: m[kind].sourceManifest,
      sourceManifestSha256: sha(bytes), scriptSha256: source.files[SCRIPT] };
  }
  assert.equal(result.main.scriptSha256, result.guard.scriptSha256,
    'Main and guard backup programs must be byte-identical');
  return result;
}
function configuredScript(captured) {
  const commands = captured.original.service.static.ExecStart;
  assert.equal(commands.length, 2, 'The reviewed backup service must have exactly two ordered ExecStart commands');
  const patterns = [RELEASE_SCRIPT, CONTROL_SCRIPT];
  const matches = patterns.flatMap(pattern => commands[1].argv.match(pattern) || []);
  assert.equal(matches.length, 1, 'The second ExecStart must contain one reviewed backup script');
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    assert.equal(commands[0].argv.match(pattern), null, 'The base backup command must remain independent');
    pattern.lastIndex = 0;
  }
  return matches[0];
}
function oldScript(captured) {
  const configured = configuredScript(captured);
  RELEASE_SCRIPT.lastIndex = 0;
  const match = RELEASE_SCRIPT.exec(configured); RELEASE_SCRIPT.lastIndex = 0;
  assert.ok(match && match[0] === configured, 'Only a reviewed immutable release backup script may be replaced');
  return configured;
}
function exactRecoveredBackupOrigin(m, a, captured) {
  const input = m.fullRelease?.privateRecipeOrigin || m.recoveredGuardBaseline, origin = a.recoveredBackupOrigin;
  for (const key of ['schema', 'runId', 'manifestSha256', 'backupCaptureSha256', 'backupTransitionSha256',
    'backupPublishedSha256', 'recoveryCompleteSha256'])
    assert.equal(input?.[key], origin[key], 'The managed backup script lacks the exact R17 recovery origin: ' + key);
  const stage = PROJECT_ROOT + '/release-staging/' + origin.runId;
  const get = (name, expected) => {
    const bytes = a.readBytes(stage + '/' + name);
    assert.equal(sha(bytes), expected, 'Recovered backup origin changed: ' + name);
    return JSON.parse(bytes.toString('utf8'));
  };
  const priorManifest = get('manifest.json', origin.manifestSha256);
  assert.equal(priorManifest.schema, 'rate-impl2-release.v1'); assert.equal(priorManifest.runId, origin.runId);
  assert.equal(priorManifest.mainSource, origin.mainSource);
  assert.equal(priorManifest.guardSource, origin.guardSource);
  const priorCapture = get(CAPTURE, origin.backupCaptureSha256);
  assert.equal(priorCapture.schema, 'sd2-multiview-backup-capture.v1');
  assert.equal(priorCapture.runId, origin.runId);
  assert.equal(priorCapture.manifestSha256, origin.manifestSha256);
  assert.equal(priorCapture.mainSource, origin.mainSource);
  assert.equal(priorCapture.guardSource, origin.guardSource);
  assert.equal(priorCapture.sources?.main?.scriptSha256, origin.scriptSha256);
  assert.equal(priorCapture.sources?.guard?.scriptSha256, origin.scriptSha256);
  const priorTransition = get(TRANSITION, origin.backupTransitionSha256);
  assert.equal(priorTransition.schema, 'sd2-multiview-backup-transition.v1');
  assert.equal(priorTransition.runId, origin.runId);
  assert.equal(priorTransition.manifestSha256, origin.manifestSha256);
  assert.equal(priorTransition.mainSource, origin.mainSource);
  assert.equal(priorTransition.guardSource, origin.guardSource);
  assert.equal(priorTransition.captureSha256, origin.backupCaptureSha256);
  assert.equal(priorTransition.scriptSha256, origin.scriptSha256);
  const target = CONTROL_DIRECTORY + '/' + origin.scriptSha256 + '.py';
  assert.equal(priorTransition.target, target); assert.equal(priorTransition.control?.sha256, origin.scriptSha256);
  assert.equal(priorTransition.dropin?.path, DROPIN);
  assert.equal(priorTransition.dropin?.bytesSha256, priorTransition.dropin?.next?.sha256);
  const priorPublished = get(PUBLISHED, origin.backupPublishedSha256);
  assert.equal(priorPublished.schema, 'sd2-multiview-backup-published.v1');
  assert.equal(priorPublished.runId, origin.runId);
  assert.equal(priorPublished.manifestSha256, origin.manifestSha256);
  assert.equal(priorPublished.mainSource, origin.mainSource);
  assert.equal(priorPublished.guardSource, origin.guardSource);
  assert.equal(priorPublished.transitionSha256, origin.backupTransitionSha256);
  assert.equal(priorPublished.target, target); assert.deepEqual(priorPublished.control, priorTransition.control);
  assert.deepEqual(priorPublished.dropin, priorTransition.dropin.next);
  assert.equal(priorPublished.timerUnchanged, true); assert.equal(priorPublished.serviceStarted, false);
  assert.equal(priorPublished.timerStartedOrEnabled, false);
  const complete = get('guard-recovery-complete.json', origin.recoveryCompleteSha256);
  assert.equal(complete.schema, 'mv-hd-upload-fault-recovery.v1');
  assert.equal(complete.runId, origin.runId); assert.equal(complete.manifestSha256, origin.manifestSha256);
  assert.equal(complete.route, 'fixed-guard');
  assert.equal(complete.completed, true); assert.equal(complete.source, origin.guardSource);
  assert.equal(complete.businessDataRestored, false);
  assert.equal(complete.originalProofAndReceiptsPreserved, true);

  assert.equal(configuredScript(captured), target);
  assert.equal(captured.sources.main.scriptSha256, origin.scriptSha256);
  assert.equal(captured.sources.guard.scriptSha256, origin.scriptSha256);
  assert.ok(captured.controlInventory.directory && captured.controlInventory.script,
    'The recovered managed backup control inventory is incomplete');
  assert.deepEqual(captured.controlInventory.script, priorPublished.control,
    'The recovered managed backup script identity changed');
  assert.deepEqual(captured.original.service, expectedNewService(priorCapture, target, priorTransition.dropin.next),
    'The current backup service is not the exact recovered R17 publication');
  assert.deepEqual(captured.original.timer, priorCapture.original.timer,
    'The current backup timer is not the exact recovered R17 timer');
  assertFiles(a, priorCapture.original.service.files, DROPIN); assertFiles(a, priorCapture.original.timer.files);
  assert.deepEqual(a.fileState(DROPIN), priorPublished.dropin, 'The recovered backup drop-in identity changed');
  assert.equal(sha(a.readBytes(DROPIN)), priorTransition.dropin.bytesSha256,
    'The recovered backup drop-in bytes changed');
  assert.deepEqual(a.fileState(target), priorPublished.control, 'The recovered backup control script identity changed');
  return { schema: 'sd2-multiview-backup-r17-adoption-origin.v1', recoveredGuardSchema: input.schema,
    recoveredRunId: input.runId, recoveredManifestSha256: input.manifestSha256,
    backupCaptureSha256: input.backupCaptureSha256, backupTransitionSha256: input.backupTransitionSha256,
    backupPublishedSha256: input.backupPublishedSha256, recoveryCompleteSha256: input.recoveryCompleteSha256,
    target, scriptSha256: origin.scriptSha256 };
}
function transformDropin(captured, target) {
  const original = Buffer.from(captured.original.service.files[DROPIN].bytesBase64, 'base64');
  const text = original.toString('utf8'); assert.deepEqual(Buffer.from(text), original, 'Drop-in is not UTF-8');
  const executable = text.split(/(?<=\n)/).filter(line => /^\s*ExecStart=/.test(line));
  assert.equal(executable.length, 1, 'Only the reviewed second ExecStart may be changed');
  const old = captured.oldScriptPath;
  assert.equal(text.split(old).length, 2, 'Old release backup path must occur exactly once');
  assert.ok(executable[0].includes(old), 'Old release backup path must be in the drop-in ExecStart');
  const next = Buffer.from(text.replace(old, target));
  assert.equal(next.toString('utf8').split(target).length, 2);
  return next;
}
function expectedNewService(captured, target, nextState) {
  const expected = structuredClone(captured.original.service);
  assert.equal(expected.static.ExecStart.length, 2);
  const old = captured.oldScriptPath;
  assert.equal(expected.static.ExecStart[1].argv.split(old).length, 2);
  expected.static.ExecStart[1].argv = expected.static.ExecStart[1].argv.replace(old, target);
  const nextBytes = transformDropin(captured, target);
  expected.files[DROPIN] = { state: nextState, bytesBase64: nextBytes.toString('base64') };
  return expected;
}
function mountTarget(a, directory) {
  const target = a.invoke('findmnt', ['-n', '-o', 'TARGET', '-T', directory]).trim();
  assert.equal(target, DATA_MOUNT, 'Backup controls must stay on the real data mount: ' + directory);
  return target;
}
function state(stat) {
  return { identity: [String(stat.dev), String(stat.ino)], uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 };
}
function strictDirectory(a, directory, { uid = a.expectedUid, gid = null, mode = null, device = null } = {}) {
  const physical = a.resolve(directory), named = fs.lstatSync(physical);
  assert.equal(fs.realpathSync(physical), physical, 'Backup control ancestor path alias refused: ' + directory);
  assert.ok(named.isDirectory() && !named.isSymbolicLink(), 'Backup control path is not a real directory: ' + directory);
  assert.equal(named.uid, uid, 'Unexpected trusted directory owner: ' + directory);
  if (gid !== null) assert.equal(named.gid, gid, 'Unexpected trusted directory group: ' + directory);
  assert.equal(named.mode & 0o022, 0, 'Writable trusted directory: ' + directory);
  if (mode !== null) assert.equal(named.mode & 0o7777, mode, 'Unexpected trusted directory mode: ' + directory);
  if (device !== null) assert.equal(String(named.dev), String(device), 'Trusted directory left the data device: ' + directory);
  return state(named);
}
function controlPathBinding(a) {
  const mount = mountTarget(a, DATA_MOUNT), data = strictDirectory(a, DATA_MOUNT);
  assert.notEqual(String(data.identity[0]), String(a.rootDevice), 'The data path is not a separate mounted device');
  const ancestors = { [DATA_MOUNT]: data };
  for (const directory of [PROJECT_ROOT, CONTROL_PARENT]) {
    ancestors[directory] = strictDirectory(a, directory, { device: data.identity[0] });
    assert.equal(mountTarget(a, directory), mount, 'Backup control ancestor mount changed: ' + directory);
  }
  return { schema: 'sd2-multiview-backup-control-path-binding.v1', mount, ancestors };
}
function assertControlPathBinding(a, expected) {
  assert.equal(expected?.schema, 'sd2-multiview-backup-control-path-binding.v1',
    'Backup capture lacks the required control path binding');
  assert.deepEqual(controlPathBinding(a), expected, 'Backup control ancestor identity changed');
}
function resolvedState(a, file, { type, uid = null, gid = null, mode = null, device, noAlias = false }) {
  const physical = a.resolve(file), resolved = fs.realpathSync(physical);
  const data = fs.realpathSync(a.resolve(DATA_MOUNT));
  assert.ok(resolved === data || resolved.startsWith(data + path.sep), 'Resolved backup path left the data tree: ' + file);
  const named = fs.lstatSync(physical), target = fs.lstatSync(resolved);
  if (noAlias) assert.equal(resolved, physical, 'Backup consumer path alias refused: ' + file);
  assert.ok(type === 'directory' ? target.isDirectory() : target.isFile() && target.nlink === 1,
    'Unexpected backup path type: ' + file);
  assert.ok(!target.isSymbolicLink(), 'Resolved backup target is a symbolic link: ' + file);
  if (uid !== null) assert.equal(target.uid, uid, 'Unexpected backup path owner: ' + file);
  if (gid !== null) assert.equal(target.gid, gid, 'Unexpected backup path group: ' + file);
  if (mode !== null) assert.equal(target.mode & 0o7777, mode, 'Unexpected backup path mode: ' + file);
  assert.equal(String(target.dev), String(device), 'Backup path left the data device: ' + file);
  return { path: file, resolved, logicalAlias: named.isSymbolicLink() || resolved !== physical, type,
    ...state(target), ...(type === 'file' ? { bytes: target.size } : {}) };
}
function targetPath(m, kind) {
  if (kind === 'backup') return BACKUP_PARENT + '/multiview-private-' + m.runId;
  return ENGINEERING_ROOT + '/' + m.runId + '/restore-' + m.mainSource;
}
function backupPathPreflight(m, a, { requireRunParent = false, requireVacant = true, requireSpace = true } = {}) {
  assert.ok(typeof m.database === 'string' && path.isAbsolute(m.database) && path.normalize(m.database) === m.database
    && m.database.startsWith(VAR_LIB + path.sep), 'Private multiview database must remain under the production var-lib tree');
  assert.match(m.runId, /^[a-f0-9-]{36}$/); assert.match(m.mainSource, /^[a-f0-9]{40}$/);
  const data = strictDirectory(a, DATA_MOUNT), device = data.identity[0];
  assert.notEqual(String(device), String(a.rootDevice), 'The data path is not a separate mounted device');
  assert.equal(mountTarget(a, DATA_MOUNT), DATA_MOUNT);
  const paths = {
    backups: resolvedState(a, BACKUP_PARENT, { type: 'directory', mode: 0o700, device, noAlias: true }),
    storage: resolvedState(a, STORAGE_ROOT, { type: 'directory', device, noAlias: true }),
    works: resolvedState(a, WORKS_ROOT, { type: 'directory', device, noAlias: true }),
    uploads: resolvedState(a, UPLOADS_ROOT, { type: 'directory', device, noAlias: true }),
    database: resolvedState(a, m.database, { type: 'file', device, noAlias: true }),
    engineering: strictDirectory(a, ENGINEERING_ROOT, { uid: a.expectedUid, device }),
  };
  const runParent = ENGINEERING_ROOT + '/' + m.runId;
  if (a.entryExists(runParent)) paths.runParent = strictDirectory(a, runParent,
    { uid: a.expectedUid, device });
  else assert.equal(requireRunParent, false, 'Isolated restore parent is not ready: ' + runParent);
  const destinations = { backup: targetPath(m, 'backup'), restore: targetPath(m, 'restore') };
  if (requireVacant) for (const destination of Object.values(destinations))
    assert.equal(a.entryExists(destination), false, 'Future backup or restore target is already occupied: ' + destination);
  const availableBytes = a.availableBytes(BACKUP_PARENT), knownInputBytes = paths.database.bytes;
  if (requireSpace) assert.ok(availableBytes >= MINIMUM_FREE + knownInputBytes,
    'Backup space is below the reserve plus known input requirement');
  return { schema: 'sd2-multiview-backup-path-preflight.v1', paths, destinations,
    capacity: { availableBytes, minimumFreeBytes: MINIMUM_FREE, knownInputBytes, mediaInventoryComplete: false } };
}
function prepareControlDirectory(a, expected) {
  assertControlPathBinding(a, expected);
  if (!a.entryExists(CONTROL_DIRECTORY)) a.mkdir(CONTROL_DIRECTORY);
  const dataDevice = expected.ancestors[DATA_MOUNT].identity[0];
  const control = strictDirectory(a, CONTROL_DIRECTORY,
    { uid: a.expectedUid, gid: a.expectedUid, mode: 0o755, device: dataDevice });
  assert.equal(mountTarget(a, CONTROL_DIRECTORY), expected.mount, 'Backup control directory uses an independent mount');
  assertControlPathBinding(a, expected);
  return { binding: expected, control };
}
function controlInventory(a, scriptSha256, binding) {
  if (!a.entryExists(CONTROL_DIRECTORY)) return { schema: 'sd2-multiview-backup-control-inventory.v1',
    directory: null, script: null };
  const directory = strictDirectory(a, CONTROL_DIRECTORY, { uid: a.expectedUid, gid: a.expectedUid, mode: 0o755,
    device: binding.ancestors[DATA_MOUNT].identity[0] });
  assert.equal(mountTarget(a, CONTROL_DIRECTORY), binding.mount, 'Backup control directory uses an independent mount');
  const file = CONTROL_DIRECTORY + '/' + scriptSha256 + '.py'; let script = null;
  if (a.entryExists(file)) {
    script = a.fileState(file); assert.equal(script.mode, 0o644); assert.equal(script.sha256, scriptSha256);
  }
  return { schema: 'sd2-multiview-backup-control-inventory.v1', directory, script };
}
function assertControlInventory(m, a, captured) {
  const current = controlInventory(a, captured.sources.main.scriptSha256, captured.controlPathBinding);
  if (!a.exists(m.stage + '/' + TRANSITION)) {
    assert.deepEqual(current, captured.controlInventory, 'Backup control inventory changed since capture'); return current;
  }
  const approved = transition(m, a, true);
  assert.ok(current.directory, 'Approved backup control directory disappeared');
  if (captured.controlInventory.directory) assert.deepEqual(current.directory, captured.controlInventory.directory,
    'Captured backup control directory identity changed');
  assert.deepEqual(current.script, approved.control, 'Approved backup control script changed');
  return current;
}
function assertControlDirectory(a, expected) {
  assertControlPathBinding(a, expected.binding);
  assert.deepEqual(strictDirectory(a, CONTROL_DIRECTORY, { uid: a.expectedUid, gid: a.expectedUid, mode: 0o755,
    device: expected.binding.ancestors[DATA_MOUNT].identity[0] }), expected.control,
  'Backup control directory identity changed');
  assert.equal(mountTarget(a, CONTROL_DIRECTORY), expected.binding.mount, 'Backup control directory mount changed');
}
function safeControl(a, file, bytes) {
  strictDirectory(a, path.dirname(file), { uid: a.expectedUid, gid: a.expectedUid, mode: 0o755 });
  if (!a.entryExists(file)) a.writeExclusive(file, bytes, 0o644);
  const state = a.fileState(file);
  assert.equal(state.mode, 0o644); assert.equal(state.sha256, sha(bytes));
  assert.deepEqual(a.readBytes(file), bytes);
  return state;
}
function adoptedTransition(m, a, captured, target, control) {
  assert.ok(captured.adoptionOrigin, 'A read-only backup adoption requires an exact recovered origin');
  const original = captured.original.service.files[DROPIN];
  return { schema: 'sd2-multiview-backup-adopted-transition.v1', runId: m.runId,
    manifestSha256: manifestSha(m, a), mainSource: m.mainSource, guardSource: m.guardSource,
    captureSha256: sha(a.readBytes(m.stage + '/' + CAPTURE)), scriptSha256: captured.sources.main.scriptSha256,
    target, control, origin: captured.adoptionOrigin,
    dropin: { path: DROPIN, state: original.state, bytesSha256: sha(Buffer.from(original.bytesBase64, 'base64')) },
    adopted: true, newPublication: false };
}
function adoptedReceipt(m, a, captured, approved) {
  assert.equal(approved.schema, 'sd2-multiview-backup-adopted-transition.v1');
  return { schema: 'sd2-multiview-backup-adopted.v1', runId: m.runId,
    manifestSha256: manifestSha(m, a), mainSource: m.mainSource, guardSource: m.guardSource,
    transitionSha256: sha(a.readBytes(m.stage + '/' + TRANSITION)), target: approved.target,
    control: approved.control, dropin: approved.dropin.state, origin: captured.adoptionOrigin,
    adopted: true, newPublication: false, controlScriptCreated: false, pendingCreated: false,
    dropinRenamed: false, daemonReloaded: false, timerUnchanged: true, serviceStarted: false,
    timerStartedOrEnabled: false };
}
function transition(m, a, required = false) {
  const file = m.stage + '/' + TRANSITION;
  if (!a.exists(file)) { assert.equal(required, false, 'Missing approved backup transition'); return null; }
  const raw = json(a, file), captured = readCapture(m, a);
  if (raw.schema === 'sd2-multiview-backup-adopted-transition.v1') {
    const value = bound(m, a, raw, raw.schema);
    assert.ok(captured.adoptionOrigin, 'An adopted transition cannot be used without its recovered origin');
    const target = CONTROL_DIRECTORY + '/' + captured.sources.main.scriptSha256 + '.py';
    assert.deepEqual(value, adoptedTransition(m, a, captured, target, a.fileState(target)),
      'Recovered backup adoption transition changed');
    return value;
  }
  const value = bound(m, a, raw, 'sd2-multiview-backup-transition.v1');
  assert.equal(value.captureSha256, sha(a.readBytes(m.stage + '/' + CAPTURE)));
  assert.equal(value.scriptSha256, captured.sources.main.scriptSha256);
  assert.equal(value.target, CONTROL_DIRECTORY + '/' + value.scriptSha256 + '.py');
  assert.equal(value.dropin.path, DROPIN); assert.deepEqual(value.dropin.original, captured.original.service.files[DROPIN].state);
  assert.equal(value.dropin.bytesSha256, sha(transformDropin(captured, value.target)));
  return value;
}

function publishedReceipt(m, a, captured, required = false) {
  const file = m.stage + '/' + PUBLISHED;
  if (!a.exists(file)) { assert.equal(required, false, 'Missing backup publication or adoption receipt'); return null; }
  const value = json(a, file);
  if (value.schema === 'sd2-multiview-backup-adopted.v1') {
    const approved = transition(m, a, true);
    assert.equal(approved.schema, 'sd2-multiview-backup-adopted-transition.v1');
    assert.deepEqual(value, adoptedReceipt(m, a, captured, approved), 'Recovered backup adoption receipt changed');
    return value;
  }
  return bound(m, a, value, 'sd2-multiview-backup-published.v1');
}

export function captureMultiviewBackupProtection(m, adapter = {}) {
  const a = environment(adapter); a.assertPrivileged(); const digest = manifestSha(m, a);
  const file = m.stage + '/' + CAPTURE;
  if (a.exists(file)) {
    const captured = readCapture(m, a); assert.deepEqual(scriptSources(m, a), captured.sources);
    assert.deepEqual(inspectMultiviewBackupProtection(m, adapter), captured.projection); return captured;
  }
  const controlBinding = controlPathBinding(a);
  const pathPreflight = backupPathPreflight(m, a, { requireRunParent: false, requireVacant: true, requireSpace: true });
  const original = observe(a); assertStopped(original); assertTimerRunning(original);
  assert.deepEqual(paths(original.service.static.DropInPaths), [DROPIN], 'The backup service must have one reviewed drop-in');
  assert.equal(original.service.static.Id, SERVICE); assert.equal(original.timer.static.Id, TIMER);
  assert.equal(original.timer.static.Unit, SERVICE); assert.equal(original.service.files[DROPIN].state.mode, 0o644);
  const sources = scriptSources(m, a);
  const existingControl = controlInventory(a, sources.main.scriptSha256, controlBinding);
  const value = { schema: 'sd2-multiview-backup-capture.v1', runId: m.runId, manifestSha256: digest,
    mainSource: m.mainSource, guardSource: m.guardSource, sources, oldScriptPath: null,
    controlPathBinding: controlBinding, backupPathPreflight: pathPreflight, controlInventory: existingControl,
    original, projection: projection(original) };
  const configured = configuredScript(value);
  if (configured.startsWith(CONTROL_DIRECTORY + '/')) {
    value.oldScriptPath = configured;
    value.adoptionOrigin = exactRecoveredBackupOrigin(m, a, value);
  } else value.oldScriptPath = oldScript(value);
  a.writeJson(file, value); return readCapture(m, a);
}

function assertPreopen(m, a) {
  const value = json(a, m.stage + '/' + PREOPEN, 1024 * 1024);
  assert.equal(value.schema, 'multiview-private-preopen.v1'); assert.equal(value.stage, 'private-preopen');
  assert.equal(value.runId, m.runId); assert.equal(value.manifestSha256, manifestSha(m, a));
  assert.equal(value.kind, 'main'); assert.equal(value.mode, 'switch'); assert.equal(value.healthy?.source, m.mainSource);
  assert.ok(Array.isArray(value.maintenance) && value.maintenance.length >= 2
    && value.maintenance.every(item => item?.status === 503), 'Fresh maintenance observations must all be HTTP 503');
  const at = Date.parse(value.at), age = a.now() - at;
  assert.ok(Number.isFinite(at) && age >= -30000 && age < 90000, 'Backup publication pre-open proof expired');
  return value;
}

export function publishMultiviewBackupControl(m, adapter = {}) {
  const a = environment(adapter); a.assertPrivileged(); assertPreopen(m, a);
  const captured = readCapture(m, a), sources = scriptSources(m, a);
  assert.deepEqual(sources, captured.sources, 'Candidate backup manifests changed since capture');
  assertControlPathBinding(a, captured.controlPathBinding);
  backupPathPreflight(m, a, { requireRunParent: true, requireVacant: true, requireSpace: true });
  assertControlInventory(m, a, captured);
  const observed = observe(a); assertStopped(observed); assertTimerRunning(observed);
  const target = CONTROL_DIRECTORY + '/' + sources.main.scriptSha256 + '.py';
  const appUid = Number(a.invoke('id', ['-u', m.appUser]));
  assert.ok(Number.isSafeInteger(appUid) && appUid > 0, 'Invalid application UID');
  const scripts = ['main', 'guard'].map(kind => candidateBytes(a, m[kind].root + '/' + SCRIPT, appUid));
  assert.equal(sha(scripts[0]), sources.main.scriptSha256); assert.equal(sha(scripts[1]), sources.guard.scriptSha256);
  assert.deepEqual(scripts[0], scripts[1], 'Main and guard backup programs differ');
  const directory = prepareControlDirectory(a, captured.controlPathBinding);

  if (captured.adoptionOrigin) {
    assert.equal(target, captured.adoptionOrigin.target);
    assert.deepEqual(observed.service, captured.original.service, 'Recovered backup service changed before adoption');
    assert.deepEqual(observed.timer, captured.original.timer, 'Recovered backup timer changed before adoption');
    assertFiles(a, captured.original.service.files); assertFiles(a, captured.original.timer.files);
    assert.deepEqual(a.fileState(target), captured.controlInventory.script);
    assert.deepEqual(a.readBytes(target), scripts[0]); assertControlDirectory(a, directory);
    let approved = transition(m, a);
    if (!approved) {
      approved = adoptedTransition(m, a, captured, target, captured.controlInventory.script);
      a.writeJson(m.stage + '/' + TRANSITION, approved);
    }
    assert.deepEqual(approved, adoptedTransition(m, a, captured, target, captured.controlInventory.script));
    assert.equal(a.entryExists(DROPIN + '.' + m.runId + '.pending'), false,
      'A read-only backup adoption must not have a pending drop-in');
    assert.deepEqual(a.fileState(DROPIN), approved.dropin.state);
    assert.equal(sha(a.readBytes(DROPIN)), approved.dropin.bytesSha256);
    const receipt = adoptedReceipt(m, a, captured, approved), receiptFile = m.stage + '/' + PUBLISHED;
    if (a.exists(receiptFile)) assert.deepEqual(json(a, receiptFile), receipt);
    else a.writeJson(receiptFile, receipt);
    assert.deepEqual(publishedReceipt(m, a, captured, true), receipt);
    return receipt;
  }

  let approved = transition(m, a);
  if (!approved) {
    assert.deepEqual(observed.service, captured.original.service); assert.deepEqual(observed.timer, captured.original.timer);
    assertFiles(a, captured.original.service.files); assertFiles(a, captured.original.timer.files);
    const controlState = safeControl(a, target, scripts[0]);
    assertControlDirectory(a, directory);
    const nextBytes = transformDropin(captured, target);
    const pending = DROPIN + '.' + m.runId + '.pending';
    assert.equal(a.exists(pending), false, 'Unrecorded pending backup drop-in exists');
    a.writeExclusive(pending, nextBytes, 0o644);
    const nextState = a.fileState(pending); assert.equal(nextState.mode, 0o644);
    approved = { schema: 'sd2-multiview-backup-transition.v1', runId: m.runId,
      manifestSha256: manifestSha(m, a), mainSource: m.mainSource, guardSource: m.guardSource,
      captureSha256: sha(a.readBytes(m.stage + '/' + CAPTURE)), scriptSha256: sources.main.scriptSha256,
      target, control: controlState, dropin: { path: DROPIN, pending, original: captured.original.service.files[DROPIN].state,
        next: nextState, bytesSha256: sha(nextBytes) } };
    a.writeJson(m.stage + '/' + TRANSITION, approved);
  }
  assert.deepEqual(a.fileState(target), approved.control); assert.deepEqual(a.readBytes(target), scripts[0]);
  assertControlDirectory(a, directory);
  const originalState = captured.original.service.files[DROPIN].state;
  const currentState = a.fileState(DROPIN);
  if (a.exists(approved.dropin.pending)) {
    assert.deepEqual(currentState, originalState, 'Backup drop-in lost its compare-and-swap baseline');
    assert.deepEqual(a.fileState(approved.dropin.pending), approved.dropin.next);
    assert.equal(sha(a.readBytes(approved.dropin.pending)), approved.dropin.bytesSha256);
    a.rename(approved.dropin.pending, DROPIN);
  } else {
    assert.deepEqual(currentState, approved.dropin.next, 'Backup drop-in is neither original nor approved new state');
  }
  assert.deepEqual(a.fileState(DROPIN), approved.dropin.next);
  assert.equal(sha(a.readBytes(DROPIN)), approved.dropin.bytesSha256);

  a.invoke('systemctl', ['daemon-reload']);
  const fresh = observe(a); assertStopped(fresh); assertTimerRunning(fresh);
  assert.deepEqual(fresh.service, expectedNewService(captured, target, approved.dropin.next), 'Only the second backup ExecStart may change');
  assert.deepEqual(fresh.timer, captured.original.timer, 'Backup timer changed during control publication');
  assertFiles(a, captured.original.service.files, DROPIN); assertFiles(a, captured.original.timer.files);
  assert.deepEqual(a.fileState(target), approved.control);
  const receipt = { schema: 'sd2-multiview-backup-published.v1', runId: m.runId,
    manifestSha256: manifestSha(m, a), mainSource: m.mainSource, guardSource: m.guardSource,
    transitionSha256: sha(a.readBytes(m.stage + '/' + TRANSITION)), target, control: approved.control,
    dropin: approved.dropin.next, timerUnchanged: true, serviceStarted: false, timerStartedOrEnabled: false };
  const receiptFile = m.stage + '/' + PUBLISHED;
  if (a.exists(receiptFile)) assert.deepEqual(json(a, receiptFile), receipt);
  else a.writeJson(receiptFile, receipt);
  return receipt;
}

export function inspectMultiviewBackupProtection(m, adapter = {}) {
  const a = environment(adapter); a.assertPrivileged(); const captured = readCapture(m, a);
  assert.deepEqual(scriptSources(m, a), captured.sources);
  assertControlPathBinding(a, captured.controlPathBinding);
  const published = publishedReceipt(m, a, captured);
  const prepared = a.exists(m.stage + '/main-prepared.json') || a.exists(m.stage + '/guard-prepared.json');
  const preopen = a.exists(m.stage + '/' + PREOPEN);
  backupPathPreflight(m, a, { requireRunParent: prepared || preopen, requireVacant: !published, requireSpace: !published });
  assertControlInventory(m, a, captured);
  const observed = observe(a); assertStopped(observed); assertTimerRunning(observed);
  assert.deepEqual(observed.timer, captured.original.timer, 'Backup timer configuration or state changed');
  assertFiles(a, captured.original.timer.files);
  const state = a.fileState(DROPIN), original = captured.original.service.files[DROPIN].state;
  if (Object.is(JSON.stringify(state), JSON.stringify(original))) {
    assert.deepEqual(state, original); assert.deepEqual(observed.service, captured.original.service);
    assertFiles(a, captured.original.service.files); return captured.projection;
  }
  const approved = transition(m, a, true);
  assert.deepEqual(state, approved.dropin.next, 'Unapproved backup drop-in identity');
  assert.equal(sha(a.readBytes(DROPIN)), approved.dropin.bytesSha256);
  assert.deepEqual(a.fileState(approved.target), approved.control); assert.equal(a.fileState(approved.target).sha256, approved.scriptSha256);
  assert.deepEqual(observed.service, expectedNewService(captured, approved.target, approved.dropin.next), 'Unapproved effective backup service configuration');
  assertFiles(a, captured.original.service.files, DROPIN);
  return captured.projection;
}

export function privateMultiviewBackupFileProtection(m, file, state, adapter = {}) {
  assert.equal(file, DROPIN, 'Only the exact multiview backup drop-in has a private projection');
  const a = environment(adapter), captured = readCapture(m, a), original = captured.original.service.files[DROPIN].state;
  if (Object.is(JSON.stringify(state), JSON.stringify(original))) { assert.deepEqual(state, original); return state; }
  const approved = transition(m, a, true);
  assert.deepEqual(state, approved.dropin.next, 'Unknown multiview backup drop-in state');
  return original;
}
