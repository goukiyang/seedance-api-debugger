import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// The full application contract is separate from the frozen 31b increment.
// It describes reviewed inputs; none of its booleans are runtime evidence.
export const FULL_RELEASE_SCHEMA = 'sd2-full-release-contract.v1';
export const FULL_ROLES = ['web', 'image', 'hd', 'works', 'role', 'template'];
export const FULL_SQL = 'prisma/migrations/20261023000000_video_creation_flow_v2/migration.sql';
export const REUSE_SEAL_FILES = ['src/app/api/tasks/[id]/reuse/route.ts',
  'src/lib/navigation/task-reuse-operation.server.ts', 'src/lib/navigation/task-reuse-intent.ts'];
const HASH = /^[a-f0-9]{64}$/, SOURCE = /^[a-f0-9]{40}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const invoke = (bin, args, options = {}) => execFileSync(bin, args, { encoding: 'utf8', timeout: 120000,
  maxBuffer: 32 * 1024 * 1024, env: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' }, ...options }).trim();
const keys = (v, expected) => { assert.ok(v && typeof v === 'object' && !Array.isArray(v));
  assert.deepEqual(Object.keys(v).sort(), [...expected].sort()); };
function input(file, maximum = 32 * 1024 * 1024) {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file); assert.equal(fs.realpathSync(file), file);
  const s = fs.lstatSync(file); assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && !(s.mode & 0o022)
    && s.size > 0 && s.size <= maximum);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const opened = fs.fstatSync(fd); const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    for (const k of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) {
      assert.equal(opened[k], s[k]); assert.equal(after[k], s[k]); assert.equal(fs.lstatSync(file)[k], s[k]);
    } return bytes;
  } finally { fs.closeSync(fd); }
}
function rootInput(file, maximum) { assert.equal(fs.lstatSync(file).uid, 0); return input(file, maximum); }
function legacyTemplatePackageSnapshot(root, expected) {
  // This unchanged independent service predates immutable source archives.
  // Only its live package/version snapshot admits its observed group-write bit;
  // this is never an immutable source or candidate-build authority.
  assert.equal(root, '/srv/video-api-debugger/app'); assert.equal(fs.realpathSync(root), root);
  const file = root + '/package.json'; assert.equal(fs.realpathSync(file), file);
  assert.match(expected.source, SOURCE); assert.ok(typeof expected.build === 'string' && expected.build.length > 0 && expected.build.length <= 256);
  const marker = root + '/.deployed-commit', buildAlias = root + '/.next-prod/BUILD_ID', buildFile = fs.realpathSync(buildAlias);
  const binding = [marker, buildFile].map(file => ({ file, stat: fs.lstatSync(file), bytes: input(file) }));
  assert.equal(binding[0].bytes.toString().trim(), expected.source); assert.equal(binding[1].bytes.toString().trim(), expected.build);

  const uid = Number(invoke('id', ['-u', 'gouki'])), gid = Number(invoke('id', ['-g', 'gouki']));
  assert.ok(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0);
  const before = fs.lstatSync(file);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.uid === uid && before.gid === gid
    && !(before.mode & 0o7002) && before.size > 0 && before.size <= 64 * 1024);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), named = fs.lstatSync(file);
    for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) {
      assert.equal(opened[key], before[key]); assert.equal(after[key], before[key]); assert.equal(named[key], before[key]);
    }
    assert.equal(bytes.length, before.size); assert.equal(fs.realpathSync(file), file);
    assert.equal(fs.realpathSync(buildAlias), buildFile);
    for (const value of binding) {
      assert.deepEqual(input(value.file), value.bytes);
      const afterBinding = fs.lstatSync(value.file);
      for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(afterBinding[key], value.stat[key]);
    }

    return { bytes, snapshot: { schema: 'sd2-live-template-package-snapshot.v1', file,
      dev: String(before.dev), ino: String(before.ino), uid, gid, mode: before.mode & 0o7777,
      size: before.size, sha256: hash(bytes), source: expected.source, build: expected.build,
      version: JSON.parse(bytes).version, markerSha256: hash(binding[0].bytes), buildIdSha256: hash(binding[1].bytes), immutableSourceEvidence: false } };
  } finally { fs.closeSync(fd); }
}

function write(file, value) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
export function assertFullReleaseInput(value) {
  if (!value) return false;
  keys(value, ['schema', 'liveRoles', 'schemaChange', 'capabilities', 'dependencyAdoption', 'dependencyCapsule', 'privateRecipeOrigin', 'legacyReuseProof']);
  assert.equal(value.schema, FULL_RELEASE_SCHEMA); keys(value.liveRoles, FULL_ROLES);
  keys(value.dependencyCapsule, ['file', 'sha256', 'kind', 'sourceRun']);
  assert.match(value.dependencyCapsule.sha256, HASH); assert.ok(['main', 'guard'].includes(value.dependencyCapsule.kind));
  assert.match(value.dependencyCapsule.sourceRun, /^[a-f0-9-]{36}$/);
  assert.equal(value.dependencyCapsule.file, '/data/video-api-debugger/release-staging/' + value.dependencyCapsule.sourceRun + '/' + value.dependencyCapsule.kind + '-immutable-success.json');
  assert.equal(value.privateRecipeOrigin?.schema, 'sd2-multiview-r17-recovered-guard.v1');
  assert.equal(value.privateRecipeOrigin?.runId, '19a7cc3d-b11e-44c8-a754-d79e9c5624d1');
  assert.equal(value.privateRecipeOrigin?.installedRecipeReceiptSha256, 'ab71ea60b1a7c54f405910ce76389a0a21181058fbb7a81715afd0a47a2349b3');
  for (const [role, v] of Object.entries(value.liveRoles)) {
    keys(v, ['root', 'source', 'version', 'build', 'sourceManifest', 'sourceManifestSha256', 'archive', 'archiveSha256']);
    assert.match(v.source, SOURCE);
    const legacyTemplate = role === 'template' && v.sourceManifest === null && v.archive === null;
    if (legacyTemplate) { assert.equal(v.sourceManifestSha256, null); assert.equal(v.archiveSha256, null); }
    else { assert.match(v.sourceManifestSha256, HASH); assert.match(v.archiveSha256, HASH); }
    assert.ok(v.root === '/data/video-api-debugger/managed-releases/' + v.source
      || v.root === '/data/video-api-debugger/releases/' + v.source || role === 'template' && v.root === '/srv/video-api-debugger/app');
    for (const k of legacyTemplate ? [] : ['sourceManifest', 'archive']) assert.ok(path.isAbsolute(v[k]) && path.resolve(v[k]) === v[k] && v[k].startsWith('/data/'));
    assert.ok(typeof v.version === 'string' && v.version && typeof v.build === 'string' && v.build);
  }
  const s = value.schemaChange; keys(s, ['previousPrismaSha256', 'newPrismaSha256', 'sqlSha256']);
  for (const v of Object.values(s)) assert.match(v, HASH); assert.notEqual(s.previousPrismaSha256, s.newPrismaSha256);
  keys(value.capabilities, ['main', 'guard']);
  for (const v of Object.values(value.capabilities)) {
    keys(v, ['pricingWrites', 'canvasVideoBatchWrites', 'multiviewGeneration', 'videoCreationV2']);
    for (const flag of Object.values(v)) assert.equal(typeof flag, 'boolean');
  }
  // Fixed guard understands all new persisted data, while charged/new-writer
  // capabilities remain closed. Enabling main is a separately reviewed choice.
  for (const flag of ['pricingWrites', 'canvasVideoBatchWrites', 'multiviewGeneration']) assert.equal(value.capabilities.guard[flag], false);
  assert.deepEqual(value.capabilities.main, { pricingWrites: false, canvasVideoBatchWrites: true, multiviewGeneration: true, videoCreationV2: true });
  assert.deepEqual(value.capabilities.guard, { pricingWrites: false, canvasVideoBatchWrites: false, multiviewGeneration: false, videoCreationV2: false });
  assert.ok(value.dependencyAdoption === null || value.dependencyAdoption === 'installed-smithy-node-http-handler-4.6.1');
  assert.equal(typeof value.legacyReuseProof, 'boolean');
  return value;
}
export function assertFullReleaseContext(context) {
  const full = assertFullReleaseInput(context.fullRelease); if (!full) return false;
  assert.equal(context.protectedIncrement || null, null); assert.equal(context.recoveredGuardBaseline || null, null);
  assert.equal(context.normalContinuation || null, null); assert.equal(context.privateMultiviewInstall, true);
  assert.ok(context.deployedUsageSchema && context.deployedCanvasBatchSchema && context.canvasVideoBatchSchema,
    'Full release retains the original deployed usage/canvas migration provenance');
  assert.equal(full.liveRoles.web.source, context.baselineSource ?? context.live?.web.source);
  return full;
}
export function captureFullReleaseLive(authorities) {
  keys(authorities, ['schema', 'roles']); assert.equal(authorities.schema, 'sd2-full-release-live-authorities.v1'); keys(authorities.roles, FULL_ROLES);
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const units = { web: 'sd2-gray.service', image: 'sd2-image-studio.service', hd: 'sd2-hd-derivatives.service',
    works: 'sd2-multiview-works.service', role: 'sd2-role-coordinator.service', template: 'sd2-template-prompts.service' };
  const liveRoles = {}, starts = {}, observed = {};
  for (const [role, name] of Object.entries(units)) {
    const fields = ['MainPID', 'ControlPID', 'ActiveState', 'SubState', 'WorkingDirectory', 'InvocationID', 'ExecMainStartTimestampMonotonic'];
    const state = Object.fromEntries(invoke('systemctl', ['show', name, ...fields.flatMap(k => ['-p', k])]).split('\n')
      .map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    assert.equal(state.ActiveState, 'active'); assert.equal(state.SubState, 'running'); assert.equal(state.ControlPID, '0');
    const pid = Number(state.MainPID); assert.ok(Number.isSafeInteger(pid) && pid > 1); assert.match(state.InvocationID, /^[a-f0-9]{32}$/);
    const root = fs.realpathSync(state.WorkingDirectory); assert.equal(fs.realpathSync('/proc/' + pid + '/cwd'), root);
    const source = input(root + '/.deployed-commit').toString().trim(); assert.match(source, SOURCE);
    const a = authorities.roles[role]; keys(a, ['sourceManifest', 'sourceManifestSha256', 'archive', 'archiveSha256']);
    const legacyTemplate = role === 'template' && a.sourceManifest === null;
    if (legacyTemplate) for (const value of Object.values(a)) assert.equal(value, null);
    const build = input(fs.realpathSync(root + '/.next-prod/BUILD_ID')).toString().trim();
    const packageSnapshot = legacyTemplate ? legacyTemplatePackageSnapshot(root, { source, build }) : null;
    const version = JSON.parse(packageSnapshot ? packageSnapshot.bytes : input(root + '/package.json')).version;
    if (!legacyTemplate) {
      const bytes = rootInput(a.sourceManifest), manifest = JSON.parse(bytes); assert.equal(hash(bytes), a.sourceManifestSha256);
      assert.equal(manifest.source, source); assert.equal(manifest.version, version); assert.equal(manifest.archiveSha256, a.archiveSha256);
      assert.equal(hash(rootInput(a.archive, 512 * 1024 * 1024)), a.archiveSha256);
      for (const file of ['package.json', 'prisma/schema.prisma']) assert.equal(hash(input(root + '/' + file)), manifest.files[file]);
    }
    liveRoles[role] = { root, source, version, build, ...a };
    starts[role] = [pid, state.InvocationID, state.ExecMainStartTimestampMonotonic]; observed[role] = { unit: name, ...state, ...(packageSnapshot ? { packageSnapshot: packageSnapshot.snapshot } : {}) };
  }
  const pricingRevision = JSON.parse(invoke('python3', ['-I', '-c',
    "import sqlite3,json; c=sqlite3.connect('file:/data/video-api-debugger/var-lib/dev.db?mode=ro',uri=True);c.execute('PRAGMA query_only=ON');r=c.execute(\"SELECT value_json FROM PlatformSetting WHERE key='pricing_policy_v1'\").fetchone();print(r[0] if r else 'null')"]));
  const allowed = rootInput('/data/video-api-debugger/controls/pricing-writer-v1/allowed.json');
  const observedAt = new Date().toISOString();
  return { schema: 'sd2-full-release-live-capture.v1', observedAt, liveRoles, observed,
    liveCapture: { observedAt, source: liveRoles.web.source, version: liveRoles.web.version, build: liveRoles.web.build,
      starts, pricingRevision: pricingRevision?.revision, allowedSha256: hash(allowed) }, servicesChanged: false, productionWrites: 0 };
}

export function assertFullLiveRoles(full, live) {
  assertFullReleaseInput(full);
  for (const role of FULL_ROLES) for (const k of ['root', 'source', 'version', 'build'])
    assert.equal(live[role][k], full.liveRoles[role][k], 'Full release live role drift: ' + role + ':' + k);
}
export function readFullLiveSourceFiles(m, files, role = 'web') {
  const full = assertFullReleaseInput(m.fullRelease); assert.ok(full && FULL_ROLES.includes(role));
  const v = full.liveRoles[role];
  if (role === 'template' && v.sourceManifest === null) {
    assert.deepEqual(files, ['package.json'], 'The unchanged legacy template has no archived source authority for other files');
    const { bytes, snapshot } = legacyTemplatePackageSnapshot(v.root, { source: v.source, build: v.build }); assert.equal(JSON.parse(bytes).version, v.version);
    assert.equal(input(v.root + '/.deployed-commit').toString().trim(), v.source);
    assert.equal(input(fs.realpathSync(v.root + '/.next-prod/BUILD_ID')).toString().trim(), v.build);
    return { source: v.source, root: v.root, sourceFiles: { 'package.json': hash(bytes) }, sourceManifestSha256: null,
      historicalArchiveAvailable: false, unchangedIndependentConsumer: true, immutableSourceEvidence: false, packageSnapshot: snapshot };
  }
  const bytes = rootInput(v.sourceManifest), manifest = JSON.parse(bytes);
  assert.equal(hash(bytes), v.sourceManifestSha256); assert.equal(manifest.source, v.source);
  assert.equal(manifest.version, v.version); assert.equal(manifest.archiveSha256, v.archiveSha256);
  assert.equal(hash(rootInput(v.archive, 512 * 1024 * 1024)), v.archiveSha256);
  const sourceFiles = Object.fromEntries(files.map(file => {
    assert.ok(file && !path.isAbsolute(file) && !file.split('/').some(p => !p || p === '.' || p === '..'));
    const expected = manifest.files?.[file]; assert.match(expected || '', HASH);
    assert.equal(hash(input(v.root + '/' + file)), expected, 'Current role source differs from the pinned source: ' + role + ':' + file);
    return [file, expected];
  }));
  return { source: v.source, root: v.root, sourceFiles, sourceManifestSha256: v.sourceManifestSha256 };
}
export function verifyFullCandidateSources(m) {
  const full = assertFullReleaseInput(m.fullRelease); if (!full) return null;
  const s = full.schemaChange;
  readFullLiveSourceFiles(m, ['prisma/schema.prisma'], 'image');
  assert.equal(hash(input(full.liveRoles.image.root + '/prisma/schema.prisma')), s.previousPrismaSha256);
  for (const kind of ['main', 'guard']) {
    const root = m[kind].root, manifest = JSON.parse(rootInput(m[kind].sourceManifest));
    assert.equal(manifest.files['prisma/schema.prisma'], s.newPrismaSha256);
    assert.equal(manifest.files[FULL_SQL], s.sqlSha256);
    assert.equal(hash(input(root + '/prisma/schema.prisma')), s.newPrismaSha256);
    assert.equal(hash(input(root + '/' + FULL_SQL)), s.sqlSha256);
    for (const [file, name, flag] of [['src/lib/pricing/build-mode.ts', 'PRICING_ADMIN_WRITES_ENABLED', 'pricingWrites'],
      ['src/lib/canvas-video-batches-build-mode.ts', 'CANVAS_VIDEO_BATCH_WRITES_ENABLED', 'canvasVideoBatchWrites'],
      ['src/lib/video/multiview-build-mode.ts', 'MULTIVIEW_GENERATION_WRITES_ENABLED', 'multiviewGeneration']])
      assert.equal(input(root + '/' + file).toString().trim(), `export const ${name}: boolean = ${full.capabilities[kind][flag]};`);
    for (const file of REUSE_SEAL_FILES) assert.equal(hash(input(root + '/' + file)), manifest.files[file]);
    const route = input(root + '/' + REUSE_SEAL_FILES[0]).toString(), helper = input(root + '/' + REUSE_SEAL_FILES[1]).toString();
    assert.ok(route.includes('taskReuseRequest(') && helper.includes('REUSE_PROTOCOL_UPGRADE_REQUIRED')
      && helper.includes('if (!request) throw new TaskReuseOperationError('), 'Unversioned reuse writes are not sealed');
  }
  return full;
}
export function assertFullDependencyAdoption(m, next, previous, installedRoot) {
  const full = assertFullReleaseInput(m.fullRelease); assert.ok(full?.dependencyAdoption === 'installed-smithy-node-http-handler-4.6.1');
  const a = structuredClone(next), b = structuredClone(previous), name = '@smithy/node-http-handler';
  assert.equal(a.packages?.['']?.dependencies?.[name], '4.6.1');
  assert.equal(a.packages?.['node_modules/' + name]?.version, '4.6.1');
  assert.equal(b.packages?.['node_modules/' + name]?.version, '4.6.1');
  assert.equal(JSON.parse(input(installedRoot + '/node_modules/' + name + '/package.json')).version, '4.6.1');
  delete a.packages[''].dependencies[name]; delete b.packages[''].dependencies[name];
  assert.deepEqual(a, b, 'Full release only adopts the already installed direct transformer declaration');
  return true;
}

export function prepareEngineeringRunDirectory(m) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  assert.match(m.runId, /^[a-f0-9-]{36}$/); assert.match(m.mainSource, SOURCE); assert.match(m.guardSource, SOURCE);
  const data = fs.lstatSync('/data'); assert.ok(data.isDirectory() && !data.isSymbolicLink() && data.dev !== fs.statSync('/').dev);
  assert.equal(invoke('findmnt', ['-n', '-o', 'TARGET', '-T', '/data']), '/data');
  const base = '/data/video-api-debugger-engineering', directory = base + '/' + m.runId;
  for (const file of [base, directory]) {
    if (!fs.existsSync(file)) fs.mkdirSync(file, { mode: file === base ? 0o755 : 0o700 });
    const s = fs.lstatSync(file); assert.equal(fs.realpathSync(file), file);
    assert.ok(s.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && s.gid === 0 && s.dev === data.dev && !(s.mode & 0o022));
    if (file === directory) assert.equal(s.mode & 0o777, 0o700);
  }
  const file = directory + '/release-binding.json';
  const value = { schema: 'sd2-engineering-run-directory.v1', runId: m.runId, mainSource: m.mainSource, guardSource: m.guardSource,
    manifestSha256: hash(rootInput(m.stage + '/manifest.json')), directory };
  if (fs.existsSync(file)) assert.deepEqual(JSON.parse(rootInput(file)), value); else write(file, value);
  return { ...value, receiptFile: file, receiptSha256: hash(rootInput(file)) };
}

export const FULL_SCHEMA_PY = String.raw`
import sys,json,sqlite3,pathlib,hashlib,os,datetime,re
p=json.loads(sys.argv[1]); mode=p['mode']; db=p['database']; directory=pathlib.Path(p['directory'])
def sha(b):return hashlib.sha256(b).hexdigest()
def digest(o):return sha(json.dumps(o,separators=(',',':'),ensure_ascii=True,sort_keys=True).encode())
def file_sha(file):
 h=hashlib.sha256()
 with open(file,'rb') as stream:
  for block in iter(lambda:stream.read(1048576),b''):h.update(block)
 return h.hexdigest()
def schema(c):return {r[0]:[r[1],r[2],r[3]] for r in c.execute("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")}
def save(file,v):
 with open(file,'x') as f:
  os.chmod(file,0o600);json.dump(v,f,indent=2);f.flush();os.fsync(f.fileno())
def identity():
 s=os.stat(db);assert not os.path.islink(db) and s.st_nlink==1;return [str(s.st_dev),str(s.st_ino)]
def ro(file):
 c=sqlite3.connect(pathlib.Path(file).as_uri()+'?mode=ro',uri=True,timeout=30);c.execute('PRAGMA query_only=ON');return c
def rows(c, columns):
 result={}
 for table,names in columns.items():
  quoted=','.join('"'+x.replace('"','""')+'"' for x in names)
  values=c.execute('SELECT '+quoted+' FROM "'+table.replace('"','""')+'"').fetchall()
  encode=lambda row:json.dumps([{'blob':x.hex()} if isinstance(x,bytes) else x for x in row],separators=(',',':'),ensure_ascii=True)
  result[table]=sha('\n'.join(sorted(encode(row) for row in values)).encode())
 return result
receipt=directory/'receipt.json';intent=directory/'intent.json';backup=directory/'consistent-backup.sqlite'
if mode=='projection':
 if not receipt.exists():
  assert not intent.exists(),'Full schema intent exists without completion; resume exact stopped-writer migration first'
  print('null');sys.exit()
 r=json.loads(receipt.read_text());assert r['identity']==p['identity'] and r['databaseIdentity']==identity()
 assert file_sha(backup)==r['backupSha256']
 with ro(db) as c:assert digest(schema(c))==r['newSchemaSha256']
 print(json.dumps(r));sys.exit()
assert mode=='apply'
if not directory.exists():directory.mkdir(mode=0o700)
if not intent.exists():
 with ro(db) as original:
  original.execute('BEGIN');before=schema(original)
  columns={n:[r[1] for r in original.execute('PRAGMA table_info("'+n.replace('"','""')+'")')] for n,v in before.items() if v[0]=='table'}
  beforeRows=rows(original,columns)
  assert not backup.exists()
  with sqlite3.connect(backup) as b:
   os.chmod(backup,0o600);original.backup(b);assert b.execute('PRAGMA integrity_check').fetchall()==[('ok',)]
   assert schema(b)==before and rows(b,columns)==beforeRows
 value={'identity':p['identity'],'databaseIdentity':identity(),'beforeSchema':before,'beforeColumns':columns,'beforeRows':beforeRows,
  'backupSha256':file_sha(backup),'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 save(intent,value)
v=json.loads(intent.read_text());assert v['identity']==p['identity'] and v['databaseIdentity']==identity()
assert file_sha(backup)==v['backupSha256']
source=pathlib.Path(p['sqlFile']).read_text();assert sha(source.encode())==p['identity']['sqlSha256']
statements=[];pending=''
for line in source.splitlines(keepends=True):
 if line.lstrip().startswith('--'):continue
 pending+=line
 if sqlite3.complete_statement(pending):
  statement=pending.strip();pending=''
  if re.fullmatch(r'(?:BEGIN IMMEDIATE|COMMIT|PRAGMA foreign_keys=(?:OFF|ON)|PRAGMA foreign_key_check);',statement,re.I):continue
  assert not re.search(r'\b(?:ATTACH|DETACH|VACUUM|TRIGGER)\b',statement,re.I)
  statements.append(statement)
assert not pending.strip() and statements
# The preview is a private copy of the original consistent backup, never a new
# interpretation of an already partially migrated production database.
with sqlite3.connect(':memory:',isolation_level=None) as preview:
 with ro(backup) as b:b.backup(preview)
 preview.execute('PRAGMA foreign_keys=OFF');preview.execute('BEGIN IMMEDIATE')
 for sql in statements:preview.execute(sql)
 expected=schema(preview);assert preview.execute('PRAGMA foreign_key_check').fetchall()==[]
 assert rows(preview,v['beforeColumns'])==v['beforeRows']
 added=set(expected)-set(v['beforeSchema']);changed={k for k in v['beforeSchema'] if expected.get(k)!=v['beforeSchema'][k]}
 allowed={'VideoTask','CanvasVideoBatch','CanvasVideoBatchChild','ApprovalRecord','ApprovalUsage'}
 assert all(v['beforeSchema'][k][1] in allowed for k in changed),'Unexpected existing schema mutation'
 assert {'VideoCreationIntent','VideoDeliverySelection'}.issubset(added)
 assert all(expected[k][1] in allowed|{'VideoCreationIntent','VideoDeliverySelection'} for k in added)
 for n in added:
  if expected[n][0]=='table':assert preview.execute('SELECT COUNT(*) FROM "'+n+'"').fetchone()[0]==0
with sqlite3.connect(db,isolation_level=None,timeout=30) as c:
 c.execute('PRAGMA foreign_keys=OFF');c.execute('BEGIN IMMEDIATE')
 try:
  current=schema(c)
  assert current==v['beforeSchema'] or current==expected,'Unknown partial schema; do not replay'
  assert rows(c,v['beforeColumns'])==v['beforeRows'],'Original business rows changed while stopped'
  if current==v['beforeSchema']:
   for sql in statements:c.execute(sql)
  assert schema(c)==expected and rows(c,v['beforeColumns'])==v['beforeRows']
  assert c.execute('PRAGMA foreign_key_check').fetchall()==[] and identity()==v['databaseIdentity'];c.execute('COMMIT')
 except BaseException:c.execute('ROLLBACK');raise
result={**v,'schema':'sd2-full-schema-adoption.v1','completed':True,'newSchemaSha256':digest(expected),
 'businessValuesChanged':False,'historyBackfilled':False,'beforeSchemaSha256':digest(v['beforeSchema']),
 'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
if receipt.exists():
 old=json.loads(receipt.read_text());assert old['identity']==result['identity'] and old['newSchemaSha256']==result['newSchemaSha256'];result=old
else:save(receipt,result)
print(json.dumps(result))
`;
function schemaArguments(m, mode) {
  const full = assertFullReleaseContext(m); assert.ok(full);
  return { mode, database: m.database, directory: m.stage + '/full-schema-adoption', sqlFile: m.main.root + '/' + FULL_SQL,
    identity: { runId: m.runId, source: m.mainSource, guardSource: m.guardSource,
      manifestSha256: hash(rootInput(m.stage + '/manifest.json')), ...full.schemaChange } };
}
export function fullSchemaProjection(m) {
  if (!m.fullRelease) return null;
  return JSON.parse(invoke('python3', ['-I', '-c', FULL_SCHEMA_PY, JSON.stringify(schemaArguments(m, 'projection'))]));
}
export function applyFullSchema(m, assertWritersStopped, check) {
  if (!m.fullRelease) return null;
  verifyFullCandidateSources(m); check(m); assertWritersStopped();
  const result = JSON.parse(invoke('python3', ['-I', '-c', FULL_SCHEMA_PY, JSON.stringify(schemaArguments(m, 'apply'))], { timeout: 180000 }));
  assertWritersStopped(); check(m); assert.equal(result.completed, true);
  for (const name of ['consistent-backup.sqlite', 'intent.json', 'receipt.json']) invoke('chattr', ['+i', m.stage + '/full-schema-adoption/' + name]);
  return result;
}
export function fullSchemaBefore(m) { return fullSchemaProjection(m)?.beforeSchema || null; }

export function publishLegacyReuseWriterProof(m, assertWritersStopped) {
  const full = assertFullReleaseInput(m.fullRelease); if (!full?.legacyReuseProof) return null;
  assertWritersStopped(); verifyFullCandidateSources(m); assert.ok(fullSchemaProjection(m));
  const files = ['natural-stop-switch-web.json', 'natural-stop-intent-switch-web.json', 'pricing-pair-published.json',
    'hd-retired-caches-after-whole-service-drain.json'];
  const evidence = Object.fromEntries(files.map(name => [name, hash(rootInput(m.stage + '/' + name))]));
  const seal = Object.fromEntries(['main', 'guard'].map(kind => [kind, Object.fromEntries(REUSE_SEAL_FILES.map(file =>
    [file, hash(input(m[kind].root + '/' + file))]))]));
  const stop = JSON.parse(rootInput(m.stage + '/natural-stop-switch-web.json'));
  const binding = { schema: 'sd2-task-reuse-legacy-writer-proof.v1', runId: m.runId, mainSource: m.mainSource, guardSource: m.guardSource,
    manifestSha256: hash(rootInput(m.stage + '/manifest.json')), evidence, seal };
  const file = m.stage + '/task-reuse-legacy-writer-proof.json';
  if (fs.existsSync(file)) assert.deepEqual(JSON.parse(rootInput(file)), binding); else write(file, binding);
  const drainedAt = stop.completedAt;
  assert.ok(Number.isFinite(Date.parse(drainedAt)), 'Natural stop receipt has no original completion time');
  const value = { version: 1, legacyWritersStopped: true, unversionedWritesRejected: true,
    releaseId: m.runId + '/' + m.mainSource, proofSha256: hash(rootInput(file)), drainedAt };
  assertWritersStopped();
  const result = JSON.parse(invoke('python3', ['-I', '-c', String.raw`
import sys,json,sqlite3,datetime
p=json.loads(sys.argv[1]);c=sqlite3.connect(p['database'],timeout=30,isolation_level=None);c.execute('BEGIN IMMEDIATE')
key='task_reuse_legacy_writer_proof_v1';text=json.dumps(p['value'],separators=(',',':'));old=c.execute('SELECT value_json FROM PlatformSetting WHERE key=?',(key,)).fetchone()
if old and json.loads(old[0]).get('releaseId')==p['value']['releaseId']:assert json.loads(old[0])==p['value']
else:c.execute('INSERT INTO PlatformSetting (id,key,value_json,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at',('release-proof-'+p['value']['proofSha256'],key,text,p['value']['drainedAt'],datetime.datetime.now(datetime.timezone.utc).isoformat()))
c.execute('COMMIT');print(json.dumps({'key':key,'value':p['value'],'completed':True}))
`, JSON.stringify({ database: m.database, value })]));
  assertWritersStopped(); return { file, sha256: value.proofSha256, ...result };
}
