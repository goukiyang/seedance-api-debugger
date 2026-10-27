// Explicit lead-only Linux proof. No existing DB, media, service or provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
let phase = 'guard';
async function main() {
  if (process.platform !== 'linux' || process.env.NODE_ENV !== 'test' || process.env.SD2_DATABASE_MODE !== 'writer'
    || process.env.AUD_MV_RECORDS_SYNTHETIC_SERVER !== '1') throw Error('isolated_linux_opt_in_required');
  require('./server-runtime.cjs');
  const root = path.resolve(__dirname, '..');
  assert.ok(fs.existsSync(path.join(root, 'src/lib/pagination/cursor.ts')), 'integrate final shared helper first');
  assert.equal(Reflect.get(globalThis, Symbol.for('video-api.database-client.v1')), undefined);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-mv-records-'));
  const file = path.join(directory, 'synthetic.db'); assert.equal(fs.existsSync(file), false);
  new (require('node:sqlite').DatabaseSync)(file).close();
  process.env.DATABASE_URL = 'file:' + file;
  process.env.FEISHU_FEEDBACK_ENABLED = 'false';
  process.env.CHECKPOINT_DISABLE = '1'; process.env.PRISMA_HIDE_UPDATE_MESSAGE = '1';
  let forbidden = 0, prisma;
  const deny = () => { forbidden++; throw Error('synthetic_network_prohibited'); };
  globalThis.fetch = deny;
  require('node:http').request = deny; require('node:http').get = deny;
  require('node:https').request = deny; require('node:https').get = deny;
  try {
    phase = 'fresh_schema';
    const target = await require('@prisma/get-platform').getBinaryTargetForCurrentPlatform();
    const engine = path.join(path.dirname(require.resolve('@prisma/engines')), '..', 'schema-engine-' + target);
    assert.ok(fs.existsSync(engine), 'preinstalled schema engine required; do not install or download');
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')],
      { cwd: root, env: { ...process.env, PRISMA_SCHEMA_ENGINE_BINARY: engine }, timeout: 120000, stdio: 'pipe' });
    ({ prisma } = require('../src/lib/prisma.ts'));
    const attached = await prisma.$queryRawUnsafe('PRAGMA database_list');
    assert.equal(attached.find(row => row.name === 'main').file, file);
    const { harness, synthetic, allPages } = require('./multiview-record-pagination-fixture.cjs');
    const { sharedCursor } = require('./audit-task-pagination-loader.cjs');
    assert.equal(path.resolve(sharedCursor), path.join(root, 'src/lib/pagination/cursor.ts'));
    const rows = synthetic();
    phase = 'synthetic_seed';
    await prisma.user.create({ data: { id: 'owner', name: 'Synthetic', username: 'synthetic-owner', email: 'synthetic-owner@example.invalid',
      password_hash: 'synthetic-unusable-password-hash', role: 'user', account_type: 'internal', user_profile: 'other', status: 'active' } });
    for (const project of rows.projects) await prisma.project.create({ data: { ...project, owner_user_id: 'owner', created_by: 'owner', type: 'personal' } });
    for (const task of rows.tasks) await prisma.videoTask.create({ data: { ...task, provider: 'synthetic', model: 'synthetic', generation_mode: 'text', prompt: 'synthetic-unread-private-sentinel' } });
    for (const source of rows.sources) await prisma.multiviewSource.create({ data: { ...source, source_version: 'synthetic-version', info_json: 'DO_NOT_PARSE_SOURCE_INFO',
      file_path: 'NONEXISTENT-SYNTHETIC.mp4', file_sha256: '0'.repeat(64), file_bytes: 1 } });
    for (const work of rows.works) await prisma.multiviewWork.create({ data: { ...work, recipe_json: 'DO_NOT_PARSE_RECIPE',
      ready_manifest_json: 'DO_NOT_PARSE_MANIFEST', source_info_json: 'DO_NOT_PARSE_WORK_INFO' } });
    const auth = require('../src/lib/video/multiview-works.ts');
    const user = await auth.multiviewWorkActor('owner');
    const { AuthError } = require('../src/lib/auth/session.ts');
    const h = harness({ rows, prisma, AuthError, reference: auth.assertMultiviewWorkReference, currentActor: auth.currentMultiviewActor }); h.setUser(user);
    phase = 'actual_prisma_record_pages';
    const result = await allPages(h); assert.equal(result.total, 1000); assert.equal(result.pages, 10);
    assert.equal((await h.list({ q: 'needle' })).total, 1000);
    const cross = await h.list({ q: '0001 Old needle' }); assert.equal(cross.total, 1);
    for (const item of result.items) { assert.equal(item.schemeCount, 2); assert.equal(item.title, 'Later ' + item.taskId.slice(-4)); }
    phase = 'actual_authorized_directory';
    const projects = await allPages(h, { directory: 'projects' }, 'projects'); assert.equal(projects.total, 667); assert.equal(projects.pages, 7);
    const first = await h.list({ limit: '2' });
    await prisma.project.update({ where: { id: 'project-0001' }, data: { status: 'deleted' } });
    await assert.rejects(h.list({ cursor: first.nextCursor }), error => error.status === 409);
    assert.equal((await h.list()).total, 999);
    assert.equal((await h.list({ directory: 'projects' })).total, 666);
    phase = 'binding_and_removed';
    await prisma.multiviewWork.create({ data: { ...rows.works[0], id: 'malformed-binding', source_id: 'source-0002', source_task_id: 'task-0000' } });
    assert.equal((await h.list()).total, 999);
    await prisma.multiviewWork.create({ data: { ...rows.works[0], id: 'removed-proof', removed_at: new Date(), title: 'removed' } });
    const removed = await h.list({ removed: true }); assert.equal(removed.total, 1); assert.equal(removed.items[0].coverUrl, null);
    for (const call of h.calls.filter(call => ['findMany', 'groupBy'].includes(call.method))) assert.ok(call.args.take <= 100);
    assert.equal(forbidden, 0);
    console.log(JSON.stringify({ syntheticOnly: true, actualPrisma: true, actualSourceAuthority: true, groups: result.total, pages: result.pages,
      directory: projects.total, laterTitleSearch: true, crossTitleSearch: true, revokedCursor409: true, deniedSourceExcluded: true,
      batchAndResponseMax: 100, privateSentinelsNeverParsed: true, externalRequests: forbidden }));
  } finally { if (prisma) await prisma.$disconnect(); fs.rmSync(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(JSON.stringify({ error: 'mv_record_native_proof_failed', phase,
  diagnostic: { name: error.name, code: error.code, message: error.message } })); process.exitCode = 1; });
