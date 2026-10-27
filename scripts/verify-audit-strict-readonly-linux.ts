// Lead's isolated Linux server ONLY. All data is synthetic under mkdtemp.
// The child mounts only that directory read-only in a private mount namespace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { HdReadRepository } from '../src/lib/media/hd-read-repository';

type FixtureDb = { exec(sql: string): void; close(): void };
type FixtureSqlite = { DatabaseSync: new (file: string) => FixtureDb };
const entry = path.resolve(process.argv[1]);
let proofPhase = 'startup';
const canonical = (value: unknown) => JSON.parse(JSON.stringify(value));
async function collect(repo: HdReadRepository) {
  const cursor = { at: new Date(1000).toISOString(), id: 'a' }, captured = new Date(2000);
  return canonical({ asset: await repo.assetById('a'), reference: await repo.referenceById('r'),
    urls: (await repo.assetsAtUrls(['/uploads/a.png'])).sort((a, b) => a.id.localeCompare(b.id)),
    refs: await repo.referencesAtUrls(['/uploads/r.png']), assets: await repo.nextAssets(cursor, captured, 45),
    tasks: await repo.nextTasks({ at: new Date(1000).toISOString(), id: 't1' }, captured, 45),
    taskAsset: await repo.taskAsset('a', 'owner'), wrongOwner: await repo.taskAsset('a', 'wrong'),
    count: await repo.countActiveImageAssets(), inventoryAssets: await repo.inventoryAssets(), inventoryReferences: await repo.inventoryReferences() });
}
function seed(file: string, wal = false) {
  const { DatabaseSync } = createRequire(path.join(process.cwd(), 'package.json'))('node:sqlite') as FixtureSqlite;
  const db = new DatabaseSync(file);
  if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec(`CREATE TABLE User(id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE Asset(id TEXT PRIMARY KEY,owner_id TEXT,original_url TEXT,metadata_json TEXT,status TEXT,type TEXT,created_at DATETIME);
    CREATE INDEX Asset_original_url_idx ON Asset(original_url);
    CREATE TABLE ReferenceAlbum(id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE ReferenceImage(id TEXT PRIMARY KEY,owner_user_id TEXT,url TEXT,status TEXT,asset_id TEXT,album_id TEXT,created_at DATETIME);
    CREATE INDEX ReferenceImage_url_idx ON ReferenceImage(url);
    CREATE TABLE ImageStudioTask(id TEXT PRIMARY KEY,owner_id TEXT,status TEXT,usage_json TEXT,finished_at DATETIME,asset_id TEXT,deleted_at DATETIME);
    INSERT INTO User VALUES ('owner','active'),('inactive','disabled');
    INSERT INTO Asset VALUES ('a','owner','/uploads/a.png','{}','active','image',1000),('b','owner','/uploads/a.png',NULL,'active','image',1000),
      ('c','inactive','/uploads/c.png',NULL,'active','image',2000),('d','owner','/uploads/d.png',NULL,'deleted','image',3000);
    INSERT INTO ReferenceAlbum VALUES ('album','active'),('deleted','deleted');
    INSERT INTO ReferenceImage VALUES ('r','owner','/uploads/r.png','active',NULL,'album',1000),('r2','inactive','/uploads/r2.png','active',NULL,'album',1000),
      ('r3','owner','/uploads/r3.png','active',NULL,'deleted',1000),('r4','owner','/uploads/r4.png','active','a','album',1000);
    INSERT INTO ImageStudioTask VALUES ('t1','owner','succeeded',NULL,1000,'a',NULL),
      ('t2','owner','rate_uncertain','{"code":"generated_dimensions_mismatch"}',1000,'a',NULL),
      ('t3','owner','failed','{}',1000,'a',NULL),('t4','owner','succeeded',NULL,1000,'a',1000);`);
  return db;
}
function snapshot(root: string) {
  return Object.fromEntries(fs.readdirSync(root).filter(name => /\.db(?:-wal|-shm|-journal)?$/.test(name)).sort().map(name => {
    const file = path.join(root, name), info = fs.statSync(file, { bigint: true });
    return [name, { hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), size: String(info.size), mtime: String(info.mtimeNs), ctime: String(info.ctimeNs) }];
  }));
}
function readonlyDescriptors(file: string) {
  let main = 0, total = 0;
  for (const fd of fs.readdirSync('/proc/self/fd')) {
    let target: string;
    try { target = fs.readlinkSync('/proc/self/fd/' + fd); } catch { continue; }
    if (target !== file && !target.startsWith(file + '-')) continue;
    const flags = /^flags:\s+([0-7]+)$/m.exec(fs.readFileSync('/proc/self/fdinfo/' + fd, 'utf8'));
    assert.ok(flags); assert.equal(parseInt(flags[1], 8) & 3, 0, 'all original DB/sidecar descriptors must be O_RDONLY');
    if (target === file) main++; total++;
  }
  assert.ok(main > 0); return total;
}
async function child(root: string) {
  proofPhase = 'readonly_mount';
  if (!path.basename(root).startsWith('sd2-strict-ro-') || !path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('synthetic_root_required');
  execFileSync('mount', ['--bind', root, root]);
  execFileSync('mount', ['-o', 'remount,bind,ro', root]);
  const { hdReadRepository: repo } = await import('../src/lib/media/hd-readonly-db');
  proofPhase = 'native_query_parity';
  process.env.DATABASE_URL = `file:${path.join(root, 'clean.db')}`;
  const rows = await collect(repo), flags = readonlyDescriptors(path.join(root, 'clean.db'));
  assert.throws(() => (repo as unknown as { exec: () => void }).exec());
  assert.throws(() => (repo as unknown as { $transaction: () => void }).$transaction());
  await repo.close();
  process.env.DATABASE_URL = `file:${path.join(root, 'active.db')}`;
  proofPhase = 'active_wal_before_commit';
  assert.equal((await repo.assetById('a'))?.original_url, '/uploads/wal-v1.png');
  const walFlags = readonlyDescriptors(path.join(root, 'active.db'));
  console.log(JSON.stringify({ stage: 'ready', rows, descriptors: flags + walFlags }));
  const input = createInterface({ input: process.stdin });
  for await (const line of input) { assert.equal(line, 'committed'); break; }
  input.close();
  proofPhase = 'active_wal_after_commit';
  assert.equal((await repo.assetById('a'))?.original_url, '/uploads/wal-v2.png', 'live committed WAL data, not immutable/stale snapshot');
  await repo.close();
  for (const name of ['hot.db', 'missing-shm.db']) {
    proofPhase = name === 'hot.db' ? 'hot_recovery_refusal' : 'missing_sidecar_refusal';
    process.env.DATABASE_URL = `file:${path.join(root, name)}`;
    await assert.rejects(repo.assetById('a'), error => {
      const code = Number((error as { errcode?: number }).errcode) & 255;
      return code === 8 || code === 14; // SQLITE_READONLY / SQLITE_CANTOPEN only
    });
    await repo.close().catch(() => {});
  }
  process.env.DATABASE_URL = `file:${path.join(root, 'missing.db')}`;
  proofPhase = 'missing_db_refusal';
  await assert.rejects(repo.assetById('a'), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
  await repo.close().catch(() => {});
  assert.equal(fs.existsSync(path.join(root, 'missing.db')), false);
  console.log(JSON.stringify({ stage: 'complete', refusedRecovery: true, refusedMissingSidecar: true, missingDbNotCreated: true }));
}
async function parent() {
  proofPhase = 'fixture_setup';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-strict-ro-'));
  let active: FixtureDb | undefined, missing: FixtureDb | undefined;
  let childProcess: ChildProcess | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    seed(path.join(root, 'clean.db')).close();
    process.env.DATABASE_URL = `file:${path.join(root, 'clean.db')}`;
    const { sharedPrismaHdRepository } = await import('../src/lib/media/hd-prisma-read');
    proofPhase = 'prisma_query_parity';
    const writerRead = sharedPrismaHdRepository();
    const expected = await collect(writerRead);
    assert.equal(expected.count, 3); assert.deepEqual(expected.inventoryAssets.map((row: { id: string }) => row.id), ['a', 'b']);
    assert.deepEqual(expected.inventoryReferences.map((row: { id: string }) => row.id), ['r']);
    assert.deepEqual(expected.tasks.map((row: { id: string }) => row.id), ['t2']);
    assert.equal(expected.wrongOwner, null); await writerRead.close();
    active = seed(path.join(root, 'active.db'), true); active.exec("UPDATE Asset SET original_url='/uploads/wal-v1.png' WHERE id='a'");
    missing = seed(path.join(root, 'missing-shm.db'), true); fs.unlinkSync(path.join(root, 'missing-shm.db-shm'));
    const makeHot = `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA page_size=512; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=1; CREATE TABLE Asset(id TEXT PRIMARY KEY,owner_id TEXT,original_url TEXT,metadata_json TEXT,status TEXT,type TEXT,created_at DATETIME); WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO Asset SELECT 'a'||x,'owner','/uploads/a.png',hex(zeroblob(400)),'active','image',1000 FROM n; BEGIN IMMEDIATE; UPDATE Asset SET metadata_json=hex(randomblob(400));"); process.kill(process.pid,'SIGKILL');`;
    const crashed = spawnSync(process.execPath, ['-e', makeHot, path.join(root, 'hot.db')]);
    proofPhase = 'hot_journal_fixture';
    assert.equal(crashed.signal, 'SIGKILL');
    assert.equal(fs.readFileSync(path.join(root, 'hot.db-journal')).subarray(0, 8).toString('hex'), 'd9d505f920a163d7', 'genuine hot rollback journal required');
    const args = process.env.AUD_RO_ROOT_NAMESPACE === '1' ? ['--mount', '--fork'] : ['--user', '--map-root-user', '--mount', '--fork'];
    proofPhase = 'readonly_namespace';
    const worker = spawn('unshare', [...args, process.execPath, ...process.execArgv, entry, '--child', root], {
      env: { ...process.env, NODE_ENV: 'production', SD2_DATABASE_MODE: 'readonly', FEISHU_FEEDBACK_ENABLED: 'false' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    childProcess = worker; timeout = setTimeout(() => worker.kill('SIGKILL'), 90000);
    const exited = new Promise<number | null>((resolve, reject) => { worker.once('error', reject); worker.once('close', resolve); });
    const lines = createInterface({ input: worker.stdout }); let before: ReturnType<typeof snapshot> | undefined, completed = false;
    let stderr = ''; worker.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
    for await (const line of lines) {
      const result = JSON.parse(line);
      if (result.stage === 'ready') {
        assert.deepEqual(result.rows, expected); assert.ok(result.descriptors > 0);
        active.exec("UPDATE Asset SET original_url='/uploads/wal-v2.png' WHERE id='a'");
        before = snapshot(root); worker.stdin.end('committed\n');
      } else if (result.stage === 'complete') { completed = true; }
    }
    const code = await exited;
    if (code !== 0 && stderr.includes('Operation not permitted')) throw new Error('namespace_not_permitted');
    assert.equal(code, 0, `readonly namespace proof failed; runtime/mount support required (${stderr.includes('Operation not permitted') ? 'namespace_not_permitted' : 'child_contract_failure'})`);
    proofPhase = 'main_and_sidecar_hashes';
    assert.equal(completed, true); assert.ok(before); assert.deepEqual(snapshot(root), before);
    console.log(JSON.stringify({ syntheticOnly: true, nativeOpenDescriptorsReadonly: true, allQueryShapesMatchPrisma: true,
      activeWalFreshCommit: true, missingDbNotCreated: true, recoveryAndMissingSidecarRefused: true, mainAndSidecarHashesUnchanged: true }));
  } finally {
    if (timeout) clearTimeout(timeout); childProcess?.kill('SIGKILL');
    active?.close(); missing?.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}
async function main() {
  if (process.platform !== 'linux' || process.env.AUD_STRICT_RO_SYNTHETIC_SERVER !== '1') throw new Error('isolated_linux_opt_in_required');
  if (process.argv[2] === '--child') await child(process.argv[3]);
  else { assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.SD2_DATABASE_MODE, 'writer'); await parent(); }
}
void main().catch(error => {
  const reason = ['namespace_not_permitted', 'isolated_linux_opt_in_required', 'readonly_sqlite_runtime_required',
    'readonly_database_mount_required', 'database_process_mode_required'].includes(error?.message) ? error.message : 'runtime_or_contract_failure';
  console.error(JSON.stringify({ error: 'strict_readonly_linux_proof_failed', phase: proofPhase, reason })); process.exitCode = 1;
});
