import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROLE_START_ROOT = '/data/video-api-debugger/controls/usage-role-writer-v1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clean = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
export function assertUsageRoleStart(contract, observed) {
  assert.equal(contract.schema, 'sd2-usage-role-start.v1');
  assert.match(contract.runId, /^[a-f0-9-]{36}$/);
  assert.equal(contract.releases.length, 2);
  assert.notEqual(contract.releases[0].source, contract.releases[1].source);
  assert.match(contract.schemaSha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(contract.appUid) && contract.appUid > 0);
  const candidate = contract.releases.find(item => item.root === observed.root);
  assert.ok(candidate, 'Role writer source is not in the compatible pair');
  assert.equal(candidate.root, '/data/video-api-debugger/managed-releases/' + candidate.source);
  assert.equal(observed.source, candidate.source);
  assert.equal(observed.version, candidate.version);
  assert.equal(observed.build, candidate.build);
  assert.deepEqual(observed.sourceSha256, candidate.sourceSha256);
  assert.equal(observed.schemaSha256, contract.schemaSha256);
  assert.ok(Object.hasOwn(candidate.sourceSha256, 'src/lib/admin/usage-attribution.ts'));
  assert.ok(Object.hasOwn(candidate.sourceSha256, 'src/lib/canvas-roles/execution.ts'));
  return { source: candidate.source, build: candidate.build, runId: contract.runId,
    sourceAndSchemaVerified: true, businessWrites: 0 };
}

function regular(file, owner = 0) {
  assert.equal(fs.realpathSync(file), file);
  const s = fs.lstatSync(file);
  assert.ok(s.isFile() && s.nlink === 1 && s.uid === owner && !(s.mode & 0o022));
  return fs.readFileSync(file);
}
export function verifyUsageRoleStart(contractFile = ROLE_START_ROOT + '/allowed.json') {
  assert.equal(process.platform, 'linux');
  assert.equal(contractFile, ROLE_START_ROOT + '/allowed.json');
  const contract = JSON.parse(regular(contractFile));
  return observeUsageRoleStart(contract);
}
export function observeUsageRoleStart(contract) {
  assert.equal(process.platform, 'linux');
  const root = fs.realpathSync(process.cwd());
  const candidate = contract.releases.find(item => item.root === root);
  assert.ok(candidate, 'Unapproved role cwd');
  const schemaSha256 = execFileSync('python3', ['-I', '-c', String.raw`
import sqlite3,hashlib,json
p='/data/video-api-debugger/var-lib/dev.db'
names=['UsageAttribution','UsageAttribution_owner_user_id_occurred_at_idx','UsageAttribution_project_id_occurred_at_idx','UsageAttribution_occurred_at_idx']
with sqlite3.connect('file:'+p+'?mode=ro',uri=True,timeout=10) as c:
 c.execute('PRAGMA query_only=ON')
 rows={r[0]:(r[1],r[2],r[3]) for r in c.execute("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name LIKE 'UsageAttribution%'")}
 assert set(rows)==set(names)
 print(hashlib.sha256(json.dumps({n:rows[n] for n in sorted(names)},separators=(',',':'),ensure_ascii=True).encode()).hexdigest())
`], { encoding: 'utf8', env: clean, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return assertUsageRoleStart(contract, {
    root, source: regular(root + '/.deployed-commit', contract.appUid).toString().trim(),
    version: JSON.parse(regular(root + '/package.json', contract.appUid)).version,
    build: regular(fs.realpathSync(root + '/.next-prod') + '/BUILD_ID', contract.appUid).toString().trim(),
    schemaSha256,
    sourceSha256: Object.fromEntries(Object.keys(candidate.sourceSha256).map(file => {
      assert.ok(!path.isAbsolute(file) && file.split('/').every(part => part && part !== '.' && part !== '..'));
      return [file, sha(regular(root + '/' + file, contract.appUid))];
    })),
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(verifyUsageRoleStart())); }
  catch { console.error('Role writer source or additive schema is not admitted; no worker started.'); process.exitCode = 1; }
}
