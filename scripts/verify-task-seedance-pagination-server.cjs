// Lead's isolated Linux server only. Two synthetic tables, no application DB,
// provider, browser, fee, migrations, or service operations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let phase = 'guard';
async function main() {
  if (process.platform !== 'linux' || process.env.AUD_TASK_PAGE_SYNTHETIC_SERVER !== '1'
    || process.env.NODE_ENV !== 'test' || process.env.SD2_DATABASE_MODE !== 'writer') throw new Error('isolated_linux_opt_in_required');
  const root = path.resolve(__dirname, '..');
  assert.ok(fs.existsSync(path.join(root, 'src/lib/pagination/cursor.ts')), 'shared helper must be integrated first');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-task-paging-'));
  const file = path.join(directory, 'synthetic.db');
  assert.equal(fs.realpathSync(path.dirname(file)), directory); assert.equal(fs.existsSync(file), false);
  const { DatabaseSync } = require('node:sqlite');
  new DatabaseSync(file).close();
  process.env.DATABASE_URL = `file:${file}`; process.env.FEISHU_FEEDBACK_ENABLED = 'false';
  let forbidden = 0;
  const denyNetwork = () => { forbidden++; throw new Error('synthetic_network_prohibited'); };
  globalThis.fetch = denyNetwork;
  require('node:http').request = denyNetwork; require('node:http').get = denyNetwork;
  require('node:https').request = denyNetwork; require('node:https').get = denyNetwork;
  let prisma;
  try {
    assert.equal(Reflect.get(globalThis, Symbol.for('video-api.database-client.v1')), undefined, 'no preloaded client may be reused');
    assert.equal(Reflect.get(globalThis, 'prisma'), undefined);
    const { harness, allPages, taskRoutes, syntheticTasks, syntheticAssets } = require('./task-seedance-pagination-fixture.cjs');
    const { sharedCursor } = require('./audit-task-pagination-loader.cjs');
    assert.equal(path.resolve(sharedCursor), path.join(root, 'src/lib/pagination/cursor.ts'));
    ({ prisma } = require('../src/lib/prisma.ts'));
    phase = 'synthetic_schema';
    const quote = name => '"' + name.replace(/"/g, '""') + '"';
    async function seed(table, rows) {
      const columns = Object.keys(rows[0]);
      await prisma.$executeRawUnsafe(`CREATE TABLE ${quote(table)} (${columns.map(name => `${quote(name)} ${name.endsWith('_at') ? 'DATETIME' : 'TEXT'}${name === 'id' ? ' PRIMARY KEY' : ''}`).join(',')})`);
      const width = Math.max(1, Math.floor(900 / columns.length));
      for (let start = 0; start < rows.length; start += width) {
        const batch = rows.slice(start, start + width), values = batch.flatMap(row => columns.map(name => row[name] instanceof Date ? row[name].getTime() : row[name]));
        await prisma.$executeRawUnsafe(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES ${batch.map(() => '(' + columns.map(() => '?').join(',') + ')').join(',')}`, ...values);
      }
    }
    const tasks = syntheticTasks(), rows = syntheticAssets();
    await seed('VideoTask', tasks); await seed('SeedanceAsset', rows);
    const h = harness({ prisma, tasks, rows }), results = [];
    phase = 'native_task_pages';
    for (const route of taskRoutes) {
      const result = await allPages(h, route); assert.equal(result.total, 1000); results.push({ route, total: result.total, pages: result.pages });
    }
    phase = 'native_seedance_scopes';
    assert.equal((await allPages(h, 'src/app/api/assets/list/route.ts', 'assets')).total, 1000);
    assert.equal((await allPages(h, 'src/app/api/assets/list/route.ts', 'assets', 'limit=100&includeDeleted=true')).total, 1001);
    h.setUser({ id: 'admin', role: 'admin', account_type: 'internal' });
    assert.equal((await allPages(h, 'src/app/api/assets/list/route.ts', 'assets')).total, 1002);
    assert.equal((await allPages(h, 'src/app/api/assets/list/route.ts', 'assets', 'limit=100&includeDeleted=true')).total, 1003);
    const handler = h.load('src/app/api/assets/list/route.ts').GET;
    const first = await (await handler(h.request('limit=5'))).json();
    await prisma.seedanceAsset.delete({ where: { id: first.assets.at(-1).localId } });
    assert.equal((await handler(h.request('cursor=' + encodeURIComponent(first.pagination.nextCursor)))).status, 409);
    assert.equal(forbidden, 0);
    console.log(JSON.stringify({ syntheticOnly: true, actualPrisma: true, taskPages: results, ownerDefault: 1000, ownerDeleted: 1001,
      adminDefault: 1002, adminDeleted: 1003, responseLimit: 100, lookaheadLimit: 101, missingAnchor409: true, externalRequests: forbidden }));
  } finally { if (prisma) await prisma.$disconnect(); fs.rmSync(directory, { recursive: true, force: true }); }
}
void main().catch(() => { console.error(JSON.stringify({ error: 'task_pagination_server_proof_failed', phase })); process.exitCode = 1; });
