import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readHdStorageProtection, assertHdStorageProtection } from './hd-storage-preflight.mjs';
import { APPROVED_HD_LEGACY_READY, APPROVED_HD_HISTORICAL_VERSIONS } from './hd-legacy-ready-allowlist.mjs';
import { MV_DIRECT, assertMvDirectReady, assertProtectedIncrement } from './release-contract.mjs';
import { inspectUsageRoleProtection } from './usage-role-control.mjs';
import { inspectMultiviewWorksProtection, privateMultiviewRecipeProtection } from './multiview-works-control.mjs';
import { inspectMultiviewBackupProtection, privateMultiviewBackupFileProtection } from './multiview-backup-control.mjs';
import { assertCanvasBatchSchemaInput } from './canvas-batch-schema-contract.mjs';
import { assertDeployedContinuationMode } from './normal-continuation.mjs';
import { assertRecoveredGuardInput } from './recovered-guard-baseline.mjs';
import { isSharedEngine, assertSharedEngineContext } from './engine-context.mjs';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function parseReleaseTimestamp(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : NaN;
  const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return NaN;
  const parsed = Date.parse(value), normalized = match[1] + '.' + (match[2] || '').padEnd(3, '0') + 'Z';
  return Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === normalized ? parsed : NaN;
}
export const call = (bin, args, extra = {}) => execFileSync(bin, args, {
  encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024,
  env: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' }, ...extra,
}).trim();
export function rootFile(file, maximum = 32 * 1024 * 1024) {
  assert.equal(fs.realpathSync(file), file, 'Input path alias refused');
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === 0
    && !(stat.mode & 0o022) && stat.size > 0 && stat.size <= maximum, 'Untrusted root input: ' + file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    assert.equal(opened.dev, stat.dev); assert.equal(opened.ino, stat.ino);
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'gid', 'nlink']) assert.equal(after[key], stat[key]);
    assert.equal(fs.lstatSync(file).ino, stat.ino);
    return bytes;
  } finally { fs.closeSync(fd); }
}
export function writeJsonExclusive(file, value) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  return file;
}
export function unit(name) {
  assert.match(name, /^sd2-[a-z-]+\.service$/);
  const fields = ['Id', 'WorkingDirectory', 'MainPID', 'ControlPID', 'ActiveState', 'SubState', 'InvocationID', 'Result',
    'NRestarts', 'ExecMainStartTimestampMonotonic', 'SendSIGKILL', 'TimeoutStopUSec'];
  const value = Object.fromEntries(call('systemctl', ['show', name, ...fields.flatMap(key => ['-p', key])]).split('\n')
    .map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  for (const field of fields) assert.ok(Object.hasOwn(value, field), 'Missing service field: ' + field);
  return value;
}
export function liveArtifactSource(root) {
  assert.equal(fs.realpathSync(root), root);
  const marker = root + '/.deployed-commit';
  if (fs.existsSync(marker)) {
    const source = fs.readFileSync(marker, 'utf8').trim();
    assert.match(source, /^[a-f0-9]{40}$/); return source;
  }
  const legacySources = ['649e361095f47556e12a6bf377d4c36d0be2fecd',
    '5a59c00aaba195c42d90c612a37224ad59b12ee0', '047d732bf09d4c323fdbb15595a8708036f87d37'];
  const source = path.basename(root);
  assert.ok(legacySources.includes(source) && root === '/data/video-api-debugger/releases/' + source,
    'Only the three observed immutable legacy release roots lack deployed markers');
  return source;
}
export function validateManifest(m) {
  assertMvDirectReady();
  const shared = isSharedEngine(m);
  if (shared) assertSharedEngineContext(m);
  assert.deepEqual(m.protectedIncrement || null, MV_DIRECT.protectedIncrement || null);
  assertProtectedIncrement(m.protectedIncrement, m);
  assert.equal(m.privateMultiviewInstall === true, MV_DIRECT.privateMultiviewInstall === true);
  assert.equal(m.schema, 'rate-impl2-release.v1'); assert.equal(m.project, 'video-api-debugger');
  assert.match(m.runId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.equal(m.projectRoot, '/data/video-api-debugger'); assert.equal(m.stage, m.projectRoot + '/release-staging/' + m.runId);
  for (const kind of ['main', 'guard']) {
    const c = m[kind]; assert.match(c.source, /^[a-f0-9]{40}$/); assert.equal(m[kind + 'Source'], c.source);
    assert.equal(c.root, m.projectRoot + '/managed-releases/' + c.source);
    assert.equal(c.archive, m.stage + '/' + kind + '/source.tar.gz');
    assert.equal(c.sourceManifest, m.stage + '/' + kind + '/source-manifest.json'); assert.equal(c.buildDist, '.next-prod-candidate');
  }
  assert.notEqual(m.mainSource, m.guardSource); assert.equal(m.mainSource, MV_DIRECT.mainSource);
  assert.deepEqual(m.normalContinuation || null, MV_DIRECT.normalContinuation || null);
  assert.deepEqual(m.deployedUsageSchema || null, MV_DIRECT.deployedUsageSchema || null);
  assert.deepEqual(m.recoveredGuardBaseline || null, MV_DIRECT.recoveredGuardBaseline || null);
  if (m.recoveredGuardBaseline) {
    assertRecoveredGuardInput(m.recoveredGuardBaseline);
    assert.ok(m.deployedUsageSchema && m.privateMultiviewInstall);
    assert.equal(m.normalContinuation || null, null);
    if (!shared) assert.equal(m.reuseBuilds || null, null);
  }
  assert.deepEqual(m.canvasVideoBatchSchema || null, MV_DIRECT.canvasVideoBatchSchema || null);
  assert.deepEqual(m.deployedCanvasBatchSchema || null, MV_DIRECT.deployedCanvasBatchSchema || null);
  const sharedReuse = shared && Boolean(m.reuseBuilds);
  const deployedContinuation = m.normalContinuation?.schema === 'sd2-normal-continuation-input.v2'
    || m.reuseBuilds?.sourceRun === 'e6044ae3-4f29-4dfd-8f12-93a94cdfa9ff';
  if (deployedContinuation) {
    assertDeployedContinuationMode(m);
  }
  if (m.deployedCanvasBatchSchema) {
    assert.ok(m.canvasVideoBatchSchema && m.deployedUsageSchema);
    if (!deployedContinuation && !sharedReuse) {
      assert.equal(m.normalContinuation || null, null);
      assert.equal(m.reuseBuilds || null, null);
    }
  }
  if (m.canvasVideoBatchSchema) { assertCanvasBatchSchemaInput(m.canvasVideoBatchSchema); assert.ok(m.deployedUsageSchema); }
  assert.ok(!(m.normalContinuation && m.deployedUsageSchema) || deployedContinuation, 'Schema adoption modes are mutually exclusive outside exact same-pair continuation');
  if (m.deployedUsageSchema && !deployedContinuation && !sharedReuse) assert.equal(m.reuseBuilds || null, null, 'A new deployed-schema pair requires complete fresh builds');
  assert.equal(m.main.version, MV_DIRECT.versions.main); assert.equal(m.guard.version, MV_DIRECT.versions.guard);
  assert.equal(m.database, m.projectRoot + '/var-lib/dev.db'); assert.equal(m.uploadsRoot, m.projectRoot + '/var-lib/uploads');
  assert.equal(m.videosRoot, m.projectRoot + '/var-lib/videos'); assert.equal(m.envFile, '/srv/video-api-debugger/app/.env');
  assert.equal(m.storageRoot, m.projectRoot + '/releases/80d5cf6f1ec489ea93257d42e8dd5c7e4e782560/storage');
  assert.equal(m.hdRoot, m.projectRoot + '/var-lib/storage/hd-derivatives');
  assert.equal(m.hdForkRoot, m.projectRoot + '/releases/5a59c00aaba195c42d90c612a37224ad59b12ee0/storage/hd-derivatives');
  assert.equal(m.hdWorkerLockPath, m.projectRoot + '/var-lib/storage/hd-worker.lock');
  assert.deepEqual(m.hdLegacyReady, APPROVED_HD_LEGACY_READY, 'Historical HD acceptance is limited to the frozen original inventory');
  assert.deepEqual(m.hdHistoricalVersions, APPROVED_HD_HISTORICAL_VERSIONS, 'Historical preservation never authorizes current-version reuse');
  assert.deepEqual(m.uploadPrivateDirectory, {
    canonical: m.projectRoot + '/var-lib/storage/verified-uploads',
    alias: m.storageRoot + '/verified-uploads',
    preparedReceipt: m.stage + '/upload-directory-prepared.json',
  });
  assert.equal(m.appUser, 'gouki'); assert.equal(m.publicOrigin, 'https://sd2.youdooart.com');
  assert.equal(m.windowFile, m.stage + '/window.json'); assert.ok(m.minimumFreeBytes >= 5 * 1024 ** 3);
  if (m.reuseBuilds) {
    assert.equal(m.reuseBuilds.schema, 'sd2-original-build-reuse-input.v1');
    assert.match(m.reuseBuilds.sourceRun, /^[a-f0-9-]{36}$/);
    assert.notEqual(m.reuseBuilds.sourceRun, m.runId);
    for (const kind of ['main', 'guard']) {
      assert.equal(m.reuseBuilds[kind].file, m.projectRoot + '/release-staging/' + m.reuseBuilds.sourceRun + '/' + kind + '-immutable-success.json');
      assert.match(m.reuseBuilds[kind].sha256, /^[a-f0-9]{64}$/);
    }
  }
  const units = { web: 'sd2-gray.service', image: 'sd2-image-studio.service', hd: 'sd2-hd-derivatives.service',
    works: 'sd2-multiview-works.service', role: 'sd2-role-coordinator.service', template: 'sd2-template-prompts.service' };
  for (const [role, name] of Object.entries(units)) {
    const v = m.live[role]; assert.equal(v.unit, name); assert.match(v.source, /^[a-f0-9]{40}$/);
    assert.ok(path.isAbsolute(v.root) && v.root.startsWith(m.projectRoot + '/') || role === 'template' && v.root === '/srv/video-api-debugger/app');
    assert.ok(typeof v.build === 'string' && v.build && typeof v.version === 'string' && v.version);
    assert.ok(Number.isSafeInteger(v.pid) && v.pid > 1); assert.match(v.invocation, /^[a-f0-9]{32}$/);
  }
  for (const role of ['web', 'image', 'hd']) assert.equal(m.live[role].source, MV_DIRECT.baselineSource);
  assert.equal(m.live.web.root, m.live.image.root); assert.equal(m.protectedTaskIds.length, 9);
  assert.deepEqual(m.retiredPricingRoots, MV_DIRECT.retiredPricingSources.map(source => m.projectRoot + '/managed-releases/' + source));
  rejectedPricingRoots(m);
  assert.deepEqual(m.protectedVideoTaskIds, MV_DIRECT.protectedVideoTaskIds);
  for (const id of m.protectedTaskIds) assert.match(id, /^[a-f0-9]{64}-0$/);
  assert.ok(m.protectedFiles.includes(m.envFile));
  for (const file of m.protectedFiles) { assert.ok(path.isAbsolute(file)); assert.match(m.expectedProtectedFileSha256[file], /^[a-f0-9]{64}$/); }
  return m;
}
export function rejectedPricingRoots(m) {
  const targets = [m.main.root, m.guard.root];
  assert.notEqual(targets[0], targets[1]);
  const retired = m.retiredPricingRoots || [];
  assert.ok(retired.every(root => !targets.includes(root)), 'A valid candidate cannot be declared retired');
  const roots = [...new Set([...retired, ...['web', 'image'].map(role => m.live[role].root).filter(root => !targets.includes(root))])].sort();
  assert.ok(roots.length > 0, 'An explicit retired source must remain rejected');
  return roots;
}
export function assertReleaseWindow(m) {
  validateManifest(m); assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  assert.equal(call('findmnt', ['-n', '-o', 'TARGET', '-T', m.stage]), '/data');
  const freeKiB = Number(call('df', ['-Pk', m.stage]).split('\n').at(-1).trim().split(/\s+/)[3]);
  assert.ok(freeKiB * 1024 >= m.minimumFreeBytes, 'Insufficient data-volume capacity');
  const w = JSON.parse(rootFile(m.windowFile, 65536));
  for (const key of ['project', 'runId', 'mainSource', 'guardSource']) assert.equal(w[key], m[key]);
  const age = Date.now() - Date.parse(w.issuedAt); assert.ok(Number.isFinite(age) && age >= -30000 && age < 300000, 'Release window expired');
  assert.equal(w.reservation?.confirmed, true); assert.match(w.reservation.registrySha256, /^[a-f0-9]{64}$/);
  for (const item of [m.project, m.runId, m.mainSource, m.publicOrigin]) assert.ok(w.reservation.line.includes(item));
  return w;
}

// Static reconciliation has the real fresh window as its outer bound. Only
// natural discovery-lock release consumes the separate cumulative 15 seconds.
// Pin once; a per-file observation must not spawn findmnt/df thousands of times.
export function sharedReadOnlyHdBounds(m) {
  assertSharedEngineContext(m);
  const window = assertReleaseWindow(m), files = [m.windowFile, m.stage + '/manifest.json'];
  const identity = stat => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, stat[key]]));
  const pinned = files.map(file => {
    const bytes = rootFile(file), stat = identity(fs.lstatSync(file));
    return { file, stat, sha256: sha(bytes) };
  });
  assert.deepEqual(JSON.parse(rootFile(m.stage + '/manifest.json')), m);
  const issuedAt = parseReleaseTimestamp(window.issuedAt), scanDeadline = issuedAt + 300000;
  assert.ok(Number.isSafeInteger(issuedAt) && issuedAt <= Date.now() && scanDeadline > Date.now());
  const check = () => {
    assert.ok(Date.now() < scanDeadline, 'Fresh read-only HD scan window expired');
    for (const item of pinned) assert.deepEqual(identity(fs.lstatSync(item.file)), item.stat, 'Pinned HD admission input changed: ' + item.file);
  };
  check(); return { scanDeadline, check, waitBudgetMs: 15000 };
}

function fileState(file) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  return { identity: [String(stat.dev), String(stat.ino)], uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777,
    sha256: sha(fs.readFileSync(file)), attributes: call('lsattr', ['-d', '--', file]).split(/\s+/)[0] };
}
export function readProtection(m) {
  validateManifest(m); assert.equal(process.getuid(), 0);
  const program = String.raw`import sqlite3,json,hashlib,os,urllib.parse,sys,time
m=json.loads(sys.argv[1])
observedFrom=int(time.time()*1000)
def digest(v): return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def fh(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
with sqlite3.connect('file:'+m['database']+'?mode=ro',uri=True,timeout=10) as c:
 c.execute('PRAGMA query_only=ON');c.execute('BEGIN');c.row_factory=sqlite3.Row
 fields='id,owner_id,module_id,batch_id,ordinal,fingerprint,prompt,context,snapshot_json,reference_ids,model,quality,aspect_ratio,output_size,unit_credits,freeze_snapshot,billing_mode,billing_scope,billing_contract_json,deleted_at'
 tasks={};visibility={}
 for r in c.execute('SELECT '+fields+' FROM ImageStudioTask'):
  contract=dict(r);visibility[r['id']]=contract.pop('deleted_at');tasks[r['id']]=digest(contract)
 video={r['id']:digest(dict(r)) for r in c.execute('SELECT id,user_id,idempotency_key,request_fingerprint,estimated_cost,pricing_snapshot FROM VideoTask')}
 failedVideo={}
 for tid in m['protectedVideoTaskIds']:
  row=c.execute('SELECT id,user_id,idempotency_key,request_fingerprint,provider_task_id,local_status,estimated_cost,actual_cost,frozen_cost,refund_amount,credit_freeze_snapshot,pricing_snapshot FROM VideoTask WHERE id=?',(tid,)).fetchone()
  if not row:raise RuntimeError('protected_failed_video_missing')
  r=dict(row)
  if r['local_status']!='failed' or r['provider_task_id'] is not None or r['actual_cost']!=0 or r['frozen_cost']!=0 or r['refund_amount']!=57.9:raise RuntimeError('protected_failed_video_refund_changed')
  r['ledger']=[dict(x) for x in c.execute('SELECT * FROM CreditLedger WHERE related_task_id=? ORDER BY id',(tid,))]
  if sum(x['amount'] for x in r['ledger'] if x['type']=='task_failed_refund')!=57.9:raise RuntimeError('protected_failed_video_ledger_changed')
  failedVideo[tid]=digest(r)
 settings=[dict(r) for r in c.execute("SELECT key,value_json FROM PlatformSetting WHERE key LIKE 'image_generation_%' OR key LIKE 'banana_image_api_%' OR key LIKE 'pricing_policy_%' OR key LIKE 'multiview_rotation_preset_%' OR key IN ('pricing_authoring_v1','gpt_image_studio_v1','canvas_role_text_billing_v1','musk_api_v1','upload_similarity_settings_v1') ORDER BY key")]
 privateRecipeSettings={r['key']:hashlib.sha256(r['value_json'].encode()).hexdigest() for r in settings if r['key'].startswith('multiview_rotation_preset_')} if m.get('privateMultiviewInstall') else None
 if privateRecipeSettings is not None:settings=[r for r in settings if not r['key'].startswith('multiview_rotation_preset_')]
 multiviewSettings={r['key']:digest(dict(r)) for r in c.execute("SELECT key,value_json,updated_by,created_at,updated_at FROM PlatformSetting WHERE key LIKE 'multiview_settings_v1:%' ORDER BY key")}
 multiviewSettingsReceipts={r['id']:digest(dict(r)) for r in c.execute("SELECT * FROM OperationLog WHERE action='multiview_settings_save' ORDER BY id")}
 workIdentities={r['id']:digest(dict(r)) for r in c.execute("SELECT id,owner_id,source_task_id,source_version,project_id,video_card_id,parent_work_id,base_key,branch_key,created_at FROM MultiviewWork WHERE source_version IS NOT NULL ORDER BY id")}
 workMutationReceipts={r['id']:digest(dict(r)) for r in c.execute("SELECT * FROM MultiviewWorkMutation ORDER BY id")}
 uploadUnknown={}
 uploadReceipts={}
 for row in c.execute("SELECT key,value_json,updated_by,created_at,updated_at FROM PlatformSetting WHERE key LIKE 'raw_upload_attempt_v2:%' OR key LIKE 'upload_receipt_v2:%' ORDER BY key"):
  r=dict(row)
  if r['key'].startswith('upload_receipt_v2:'):
   uploadReceipts[r['key']]=digest(r)
   continue
  try: phase=json.loads(r['value_json']).get('phase')
  except Exception: phase=None
  if phase not in ('prepared','notAccepted','completed'): uploadUnknown[r['key']]=digest(r)
 protected={}
 for tid in m['protectedTaskIds']:
  row=c.execute('SELECT id,owner_id,asset_id,reference_ids,actual_credits,billing_settled_at,billing_mode,billing_scope,billing_contract_json,freeze_snapshot,deleted_at FROM ImageStudioTask WHERE id=?',(tid,)).fetchone()
  if not row:raise RuntimeError('protected_task_missing')
  r=dict(row);ids=set(json.loads(r['reference_ids'] or '[]'))
  if r['asset_id']:ids.add(r['asset_id'])
  assets=[]
  for aid in sorted(ids):
   ar=c.execute('SELECT * FROM Asset WHERE id=?',(aid,)).fetchone()
   if not ar:raise RuntimeError('protected_asset_missing')
   a=dict(ar);u=urllib.parse.urlsplit(a['original_url']);rel=u.path
   if (u.netloc and u.netloc!=urllib.parse.urlsplit(m['publicOrigin']).netloc) or not rel.startswith('/uploads/'):raise RuntimeError('protected_original_nonlocal')
   p=os.path.realpath(os.path.join(m['uploadsRoot'],rel[len('/uploads/'):]))
   if not p.startswith(os.path.realpath(m['uploadsRoot'])+os.sep):raise RuntimeError('protected_original_boundary')
   a['fileSha256']=fh(p);assets.append(a)
  r['assets']=assets
  r['ledger']=[dict(x) for x in c.execute('SELECT user_id,type,amount,balance_before,balance_after,frozen_before,frozen_after,related_task_id,idempotency_key,metadata_json FROM CreditLedger WHERE related_task_id=? OR idempotency_key IN (?,?,?) ORDER BY idempotency_key,id',(tid,'image-studio:freeze:'+tid,'image-studio:settle:'+tid,'image-studio:refund:'+tid))]
  protected[tid]=digest(r)
 pricingRevision=json.loads(next(r['value_json'] for r in settings if r['key']=='pricing_policy_v1'))['revision']
 usageAttribution={json.dumps([r['source_kind'],r['source_id']],separators=(',',':')):digest(dict(r)) for r in c.execute('SELECT * FROM UsageAttribution')} if m.get('deployedUsageSchema') else None
 print(json.dumps(dict(imageContracts=tasks,imageVisibility=dict(observedFrom=observedFrom,observedUntil=int(time.time()*1000),tasks=visibility),videoContracts=video,protectedFailedVideo=failedVideo,pricingRevision=pricingRevision,settingsSha256=digest(settings),protectedTasks=protected,
  uploadUnknown=uploadUnknown,uploadReceipts=uploadReceipts,multiviewSettings=multiviewSettings,multiviewSettingsReceipts=multiviewSettingsReceipts,
  workIdentities=workIdentities,workMutationReceipts=workMutationReceipts,**({'usageAttribution':usageAttribution} if m.get('deployedUsageSchema') else {}),
  **({'privateRecipeSettings':privateRecipeSettings} if privateRecipeSettings is not None else {}))))
 c.rollback()
`;
  const business = JSON.parse(call('python3', ['-I', '-c', program, JSON.stringify(m)]));
  const database = fs.statSync(m.database);
  const files = Object.fromEntries(m.protectedFiles.map(file => [file,
    m.privateMultiviewInstall && file === '/etc/systemd/system/sd2-backup.service.d/90-multiview-works.conf'
      ? privateMultiviewBackupFileProtection(m, file, fileState(file)) : fileState(file)]));
  for (const [file, state] of Object.entries(files)) {
    if (!file.startsWith('/etc/nginx/sites-available/')) assert.equal(state.sha256, m.expectedProtectedFileSha256[file], 'Pinned configuration changed: ' + file);
  }
  const marker = fileState(m.storageRoot + '/image-studio-drain');
  assert.equal(marker.uid, 0); assert.equal(marker.mode, 0o444); assert.ok(marker.attributes.includes('i'));
  const markerBody = JSON.parse(fs.readFileSync(m.storageRoot + '/image-studio-drain', 'utf8'));
  assert.deepEqual(Object.keys(markerBody).sort(), ['guard', 'installedAt', 'protocol', 'schema']);
  assert.equal(markerBody.schema, 'pricing-writer-isolation.v1'); assert.equal(markerBody.protocol, 'pricing-policy-v1');
  assert.equal(markerBody.guard, 'reject-legacy-image-writers');
  // HD is an explicitly managed consumer in this batch. Its full old/new
  // invocation, policy, lock and stop proof are checked by the switch path.
  const otherServices = Object.fromEntries(['template'].map(role => {
    const v = unit(m.live[role].unit); assert.equal(v.ActiveState, 'active');
    assert.equal(Number(v.MainPID), m.live[role].pid); assert.equal(v.InvocationID, m.live[role].invocation);
    assert.equal(fs.realpathSync('/proc/' + v.MainPID + '/cwd'), m.live[role].root);
    return [role, { pid: v.MainPID, invocation: v.InvocationID, root: fs.realpathSync(v.WorkingDirectory) }];
  }));
  otherServices.works = inspectMultiviewWorksProtection(m);
  if (m.privateMultiviewInstall) otherServices.multiviewBackup = inspectMultiviewBackupProtection(m);
  otherServices.role = inspectUsageRoleProtection(m);
  const storage = Object.fromEntries(fs.readdirSync(m.storageRoot).sort().map(name => {
    const real = fs.realpathSync(path.join(m.storageRoot, name)), s = fs.statSync(real);
    assert.ok(real.startsWith(m.projectRoot + '/'));
    return [name, { real, identity: [String(s.dev), String(s.ino)], kind: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other' }];
  }));
  return { databaseIdentity: [String(database.dev), String(database.ino)], files, marker, otherServices, storage,
    hdStorage: readHdStorageProtection(m), ...business,
    ...(business.privateRecipeSettings ? { privateRecipeSettings: privateMultiviewRecipeProtection(m, business.privateRecipeSettings) } : {}) };
}
export function assertProtection(before, after) {
  if (Object.hasOwn(before, 'privateRecipeSettings')) assert.deepEqual(after.privateRecipeSettings, before.privateRecipeSettings,
    'Private recipe changed outside the exact installed transaction');
  if (Object.hasOwn(before, 'usageAttribution')) {
    assert.ok(before.usageAttribution && after.usageAttribution);
    for (const [id, hash] of Object.entries(before.usageAttribution))
      assert.equal(after.usageAttribution[id], hash, 'Existing usage attribution changed: ' + id);
  }
  assertHdStorageProtection(before.hdStorage, after.hdStorage);
  for (const key of ['databaseIdentity', 'files', 'marker', 'otherServices', 'settingsSha256', 'protectedTasks', 'protectedFailedVideo']) assert.deepEqual(after[key], before[key], 'Protected state changed: ' + key);
  for (const key of ['imageContracts', 'videoContracts']) for (const [id, hash] of Object.entries(before[key])) assert.equal(after[key][id], hash, 'Existing frozen contract changed: ' + id);
  // Hiding a result is an ordinary owner action, not an immutable fee/input
  // contract. Never resurrect or alter an existing tombstone. A new tombstone
  // must be a real millisecond timestamp within these actual read snapshots.
  for (const state of [before, after]) {
    const view = state.imageVisibility;
    assert.ok(view && typeof view === 'object' && !Array.isArray(view));
    assert.deepEqual(Object.keys(view).sort(), ['observedFrom', 'observedUntil', 'tasks']);
    assert.ok(Number.isSafeInteger(view.observedFrom) && view.observedFrom > 0
      && Number.isSafeInteger(view.observedUntil) && view.observedUntil >= view.observedFrom);
    assert.ok(view.tasks && typeof view.tasks === 'object' && !Array.isArray(view.tasks));
    assert.deepEqual(Object.keys(view.tasks).sort(), Object.keys(state.imageContracts).sort(), 'Visibility and contract rows differ');
    for (const value of Object.values(view.tasks)) assert.ok(value === null
      || Number.isSafeInteger(value) && value > 0 && value <= view.observedUntil, 'Invalid deletion timestamp');
  }
  assert.ok(after.imageVisibility.observedFrom >= before.imageVisibility.observedFrom, 'Protection read order changed');
  for (const [id, value] of Object.entries(before.imageVisibility.tasks)) {
    const current = after.imageVisibility.tasks[id];
    if (value !== null) assert.equal(current, value, 'Existing hidden result changed: ' + id);
    else if (current !== null) assert.ok(current >= before.imageVisibility.observedFrom, 'New deletion predates this protection interval: ' + id);
  }
  for (const key of ['uploadUnknown', 'uploadReceipts', 'multiviewSettings', 'multiviewSettingsReceipts', 'workIdentities', 'workMutationReceipts']) for (const [id, hash] of Object.entries(before[key])) {
    assert.equal(after[key][id], hash, 'Existing upload recovery contract changed: ' + id);
  }
  for (const [name, binding] of Object.entries(before.storage)) assert.deepEqual(after.storage[name], binding, 'Existing storage binding changed: ' + name);
}

export { engineDirectory, isSharedEngine, assertSharedEngineContext } from './engine-context.mjs';
