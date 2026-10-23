import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { call, rootFile, sha, writeJsonExclusive } from './common.mjs';

const MINIMUM_FREE_BYTES = 2 * 1024 ** 3;
const TRUSTED_GROUP_WRITABLE_PARENT = '/data/video-api-debugger/var-lib/storage';
const TRUSTED_GROUP_PROBE = String.raw`import errno,grp,json,os,pwd
directory='/data/video-api-debugger/var-lib/storage'
def sources(name):
 with open('/etc/nsswitch.conf','r',encoding='utf-8') as f:
  for raw in f:
   line=raw.split('#',1)[0].strip()
   if line and ':' in line:
    key,value=line.split(':',1)
    if key.strip()==name:return value.split()
 raise RuntimeError('missing nss database')
def acl_absent(name):
 try:os.getxattr(directory,name,follow_symlinks=False)
 except OSError as e:return e.errno==errno.ENODATA
 return False
uid=os.getuid();gid=os.getgid();group=grp.getgrgid(gid)
print(json.dumps(dict(runtimeUid=uid,runtimeGid=gid,
 primaryGroupUids=sorted({entry.pw_uid for entry in pwd.getpwall() if entry.pw_gid==gid}),
 explicitMemberUids=sorted({pwd.getpwnam(name).pw_uid for name in group.gr_mem}),
 passwdSources=sources('passwd'),groupSources=sources('group'),
 accessAclAbsent=acl_absent('system.posix_acl_access'),defaultAclAbsent=acl_absent('system.posix_acl_default')),
 separators=(',',':'),sort_keys=True))`;
const exists = file => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
const dataMount = file => {
  const mount = call('findmnt', ['-n', '-o', 'TARGET', '-T', file]);
  assert.ok(mount === '/data' || mount.startsWith('/data/'), 'Upload private directory must stay on the real data volume');
  return mount;
};
const identity = file => {
  const stat = fs.lstatSync(file);
  return { dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid, gid: stat.gid,
    mode: stat.mode & 0o7777, kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'other' };
};
function paths(m) {
  assert.equal(m.projectRoot, '/data/video-api-debugger');
  const canonical = m.projectRoot + '/var-lib/storage/verified-uploads';
  const alias = m.storageRoot + '/verified-uploads';
  const receipt = m.stage + '/upload-directory-prepared.json';
  assert.equal(m.uploadPrivateDirectory?.canonical, canonical);
  assert.equal(m.uploadPrivateDirectory?.alias, alias);
  assert.equal(m.uploadPrivateDirectory?.preparedReceipt, receipt);
  return { canonical, alias, receipt };
}
function trustedGroupWritableParent(file, appUser, uid, gid) {
  assert.equal(file, TRUSTED_GROUP_WRITABLE_PARENT);
  const interpreter = fs.lstatSync('/usr/bin/python3'); assert.ok(interpreter.isSymbolicLink() && interpreter.uid === 0);
  const realInterpreter = fs.realpathSync('/usr/bin/python3'), realInterpreterStat = fs.lstatSync(realInterpreter);
  assert.equal(fs.readlinkSync('/usr/bin/python3'), 'python3.12'); assert.equal(realInterpreter, '/usr/bin/python3.12');
  assert.ok(realInterpreterStat.isFile() && !realInterpreterStat.isSymbolicLink()
    && realInterpreterStat.uid === 0 && !(realInterpreterStat.mode & 0o022));
  const value = JSON.parse(call('/usr/sbin/runuser', ['-u', appUser, '--', 'env', '-i', 'PATH=/usr/bin:/bin',
    'LANG=C', 'LC_ALL=C', '/usr/bin/python3', '-I', '-c', TRUSTED_GROUP_PROBE], {
    timeout: 2000, maxBuffer: 4096,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  }));
  assert.deepEqual(Object.keys(value).sort(), ['accessAclAbsent', 'defaultAclAbsent', 'explicitMemberUids',
    'groupSources', 'passwdSources', 'primaryGroupUids', 'runtimeGid', 'runtimeUid']);
  assert.equal(value.runtimeUid, uid); assert.equal(value.runtimeGid, gid);
  assert.deepEqual(value.primaryGroupUids, [uid]);
  assert.ok(Array.isArray(value.explicitMemberUids) && value.explicitMemberUids.length <= 1
    && value.explicitMemberUids.every(memberUid => memberUid === uid));
  assert.deepEqual(value.passwdSources, ['files', 'systemd']); assert.deepEqual(value.groupSources, ['files', 'systemd']);
  assert.equal(value.accessAclAbsent, true); assert.equal(value.defaultAclAbsent, true);
}
function trustedParent(file, appUser, uid, gid) {
  assert.equal(fs.realpathSync(file), file, 'Upload directory parent aliases are refused');
  const stat = fs.lstatSync(file);
  const rootOwned = stat.uid === 0 && !(stat.mode & 0o022);
  const sameAppIdentity = stat.uid === uid && stat.gid === gid && !(stat.mode & 0o002)
    && (!(stat.mode & 0o020) || (file === TRUSTED_GROUP_WRITABLE_PARENT && (stat.mode & 0o7777) === 0o775));
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && (rootOwned || sameAppIdentity),
    'Untrusted upload directory parent: ' + file);
  if (sameAppIdentity && (stat.mode & 0o020)) trustedGroupWritableParent(file, appUser, uid, gid);
}
function trustedCanonicalParents(m, uid, gid) {
  for (const directory of [path.dirname(m.projectRoot), m.projectRoot, m.projectRoot + '/var-lib',
    m.projectRoot + '/var-lib/storage']) trustedParent(directory, m.appUser, uid, gid);
  trustedParent(m.storageRoot, m.appUser, uid, gid);
}
function inspect(m) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const { canonical, alias, receipt } = paths(m);
  const uid = Number(call('id', ['-u', m.appUser])), gid = Number(call('id', ['-g', m.appUser]));
  assert.ok(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0);
  trustedCanonicalParents(m, uid, gid);
  assert.equal(fs.realpathSync(canonical), canonical, 'Canonical upload directory must be a real directory, not an alias');
  const final = fs.lstatSync(canonical);
  assert.ok(final.isDirectory() && !final.isSymbolicLink() && final.uid === uid && final.gid === gid
    && (final.mode & 0o7777) === 0o700, 'Canonical upload directory must be app-owned 0700');
  const storage = fs.lstatSync(m.storageRoot), system = fs.statSync('/');
  assert.ok(final.dev === storage.dev && final.dev !== system.dev, 'Canonical upload directory must share the real storage data device');
  const aliasStat = fs.lstatSync(alias);
  assert.ok(aliasStat.isSymbolicLink() && [0, uid].includes(aliasStat.uid), 'Only the fixed storage leaf may be an alias');
  assert.equal(fs.readlinkSync(alias), canonical, 'Upload leaf must name the fixed absolute canonical directory');
  assert.equal(fs.realpathSync(alias), canonical, 'Upload leaf escaped the fixed canonical directory');
  dataMount(canonical); dataMount(alias); dataMount(m.storageRoot);
  const freeKiB = Number(call('df', ['-Pk', canonical]).split('\n').at(-1).trim().split(/\s+/)[3]);
  assert.ok(Number.isFinite(freeKiB) && freeKiB * 1024 >= MINIMUM_FREE_BYTES, 'Insufficient upload staging capacity');
  call('runuser', ['-u', m.appUser, '--', 'test', '-r', canonical]);
  call('runuser', ['-u', m.appUser, '--', 'test', '-w', canonical]);
  call('runuser', ['-u', m.appUser, '--', 'test', '-x', canonical]);
  return { schema: 'upload-private-directory-layout.v1', runId: m.runId, canonical, alias, receipt,
    canonicalIdentity: identity(canonical), aliasIdentity: identity(alias), storageRootIdentity: identity(m.storageRoot),
    mount: '/data', minimumFreeBytes: MINIMUM_FREE_BYTES, appUser: m.appUser, uid, gid,
    readOnly: true, changedFilesystem: false };
}

export function prepareUploadPrivateDirectory(m) {
  const { canonical, alias, receipt } = paths(m);
  assert.ok(!exists(receipt), 'Never overwrite upload directory preparation evidence');
  assert.ok(exists(canonical), 'Canonical upload directory must already exist; release preparation never creates or repairs it');
  assert.ok(exists(alias), 'Fixed upload alias must already exist; release preparation never creates or repairs it');
  const uid = Number(call('id', ['-u', m.appUser])), gid = Number(call('id', ['-g', m.appUser]));
  trustedCanonicalParents(m, uid, gid);
  const snapshot = { ...inspect(m), preparedAt: Date.now(), createdCanonical: false, createdAlias: false };
  writeJsonExclusive(receipt, snapshot); return { ...snapshot, receiptSha256: sha(rootFile(receipt, 65536)) };
}

export function verifyUploadPrivateDirectory(m) {
  const current = inspect(m), { receipt } = paths(m), bytes = rootFile(receipt, 65536), prepared = JSON.parse(bytes);
  for (const key of ['schema', 'runId', 'canonical', 'alias', 'receipt', 'canonicalIdentity', 'aliasIdentity',
    'storageRootIdentity', 'mount', 'minimumFreeBytes', 'appUser', 'uid', 'gid', 'readOnly',
    'changedFilesystem']) assert.deepEqual(current[key], prepared[key], key);
  assert.equal(prepared.createdCanonical, false); assert.equal(prepared.createdAlias, false);
  return { ...current, preparedAt: prepared.preparedAt, receiptSha256: sha(bytes), readOnlyVerifiedAt: Date.now() };
}

