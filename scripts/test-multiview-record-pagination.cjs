const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { harness, allPages, synthetic } = require('./multiview-record-pagination-fixture.cjs');

test('actual MV records service refuses the forgeable old unsigned offset cursor', async () => {
  const h = harness({ rows: synthetic(10) });
  const scope = createHash('sha256').update(JSON.stringify([h.user.id, '', '', false])).digest('hex');
  const cursor = Buffer.from(JSON.stringify({ scope, offset: 3 })).toString('base64url');
  await assert.rejects(h.list({ cursor }), error => [400, 409].includes(error.status));
});
test('actual MV records service reads at most100 rows per batch', async () => {
  const h = harness(); await h.list({ limit: '24' });
  for (const call of h.calls.filter(call => ['findMany', 'groupBy'].includes(call.method))) assert.ok(call.args.take <= 100, `${call.name}.${call.method} take=${call.args.take}`);
});

test('actual1000 mixed groups page completely with ties, exact counts and bounded retained candidates', async () => {
  const h = harness(); let peak = 0;
  const splice = Array.prototype.splice;
  Array.prototype.splice = function (...args) {
    const result = splice.apply(this, args);
    if (this[0]?.taskId && this[0]?.schemeCount !== undefined) { peak = Math.max(peak, this.length); assert.ok(this.length <= 100); }
    return result;
  };
  try {
    const result = await allPages(h); assert.equal(result.total, 1000); assert.equal(result.pages, 10); assert.equal(peak, 100);
    const expected = [...result.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    assert.deepEqual(result.items, expected);
    for (const item of result.items) {
      const number = Number(item.taskId.slice(-4)), suffix = String(number).padStart(4, '0');
      assert.equal(item.schemeCount, 2); assert.equal(item.workId, 'work-' + suffix + '-1');
      assert.equal(item.title, 'Later ' + suffix); assert.equal(item.sourceVersion, 'version-' + suffix + '-1');
      assert.equal(item.sourceId, number % 3 === 2 ? 'source-' + suffix : null);
      assert.equal(item.projectId, number % 3 === 2 ? null : 'project-' + suffix);
      assert.equal(item.status, number % 3 === 0 ? 'succeeded' : 'ready');
      const source = number % 3 === 0 ? h.rows.tasks.find(row => row.id === item.taskId) : h.rows.works.find(row => row.id === item.workId);
      assert.equal(item.createdAt, source.created_at.toISOString());
      assert.ok(item.coverUrl.includes(item.workId)); assert.ok(item.coverUrl.includes(item.sourceVersion));
    }
    for (const call of h.calls.filter(call => ['findMany', 'groupBy'].includes(call.method))) assert.ok(call.args.take <= 100);
    const late = await h.list({ q: 'Old needle 0999' });
    assert.equal(late.total, 1); assert.equal(late.items[0].taskId, 'task-0999');
  } finally { Array.prototype.splice = splice; }
});

test('all later titles, task ids, project titles and cross-title matches remain searchable', async () => {
  const h = harness({ rows: synthetic(15) });
  assert.equal((await h.list({ q: 'NEEDLE' })).total, 15);
  assert.equal((await h.list({ q: 'task-0001' })).total, 1);
  assert.equal((await h.list({ q: 'Project 0001' })).total, 1);
  assert.equal((await h.list({ q: '0001 Old needle' })).total, 1);
  const base = h.rows.works[0]; base.title = 'deep oldest';
  for (let i = 0; i < 205; i++) h.rows.works.push({ ...base, id: 'extra-' + String(i).padStart(4, '0'),
    title: 'ordinary scheme ' + i, created_at: new Date(base.created_at.getTime() + (i + 10) * 1000) });
  const found = await h.list({ q: 'deep oldest' }); assert.equal(found.total, 1); assert.equal(found.items[0].schemeCount, 207);
  assert.ok(h.calls.filter(call => call.name === 'multiviewWork' && call.method === 'findMany' && call.args.select.title).length >= 3);
});

test('shared signed cursors deny owner, authority, filters, directory swaps and tampering', async () => {
  const h = harness({ rows: synthetic(12) }), first = await h.list({ limit: '2' });
  for (const change of [{ q: 'Later' }, { projectId: 'project-0001' }, { removed: true }, { directory: 'projects' },
    { cursor: first.nextCursor.slice(0, -1) + (first.nextCursor.endsWith('a') ? 'b' : 'a') }, { cursor: '' }]) {
    await assert.rejects(h.list({ cursor: first.nextCursor, ...change }), error => error.status === 400);
  }
  const user = { ...h.user }; h.setUser({ ...user, role: 'admin' });
  await assert.rejects(h.list({ cursor: first.nextCursor }), error => error.status === 400);
  h.setUser({ ...user, feature_profile_id: 'changed' });
  await assert.rejects(h.list({ cursor: first.nextCursor }), error => error.status === 400);
  h.setUser({ ...user, id: 'other' }); await assert.rejects(h.list({ cursor: first.nextCursor }), error => error.status === 400);
});

test('revoked/missing anchors and changed grouped content yield409, never an offset restart', async () => {
  for (const change of ['delete', 'revoke', 'title']) {
    const h = harness({ rows: synthetic(12) }), first = await h.list({ limit: '2' }), anchor = first.items.at(-1);
    if (change === 'delete') h.rows.works.splice(0, h.rows.works.length, ...h.rows.works.filter(row => row.source_task_id !== anchor.taskId));
    if (change === 'revoke') h.rows.projects.find(row => row.id === 'project-0001').denied = true;
    if (change === 'title') h.rows.works.find(row => row.id === anchor.workId).title = 'changed';
    await assert.rejects(h.list({ cursor: first.nextCursor }), error => error.status === 409);
  }
});

test('empty source ids follow falsy grouping, and removed/intent/denied bindings do not leak', async () => {
  const h = harness({ rows: synthetic(6) });
  h.rows.works.find(row => row.id === 'work-0001-1').source_id = '';
  h.rows.works.push({ ...h.rows.works[0], id: 'intent', save_state: 'intent', title: 'must not count' });
  h.rows.works.push({ ...h.rows.works[0], id: 'removed', removed_at: new Date(), title: 'removed work' });
  h.rows.works.push({ ...h.rows.works[0], id: 'bad-source', source_id: 'source-0002', source_task_id: 'task-0001' });
  h.rows.projects.find(row => row.id === 'project-0003').denied = true;
  const result = await h.list(); assert.equal(result.total, 5);
  const legacy = result.items.find(row => row.id === 'task:task-0001'); assert.equal(legacy.sourceId, ''); assert.equal(legacy.schemeCount, 2);
  assert.equal(result.items.some(row => row.taskId === 'task-0003'), false);
  assert.equal(result.items.find(row => row.taskId === 'task-0000').schemeCount, 2);
  const removed = await h.list({ removed: true }); assert.equal(removed.total, 1); assert.equal(removed.items[0].title, 'removed work');
  assert.equal(removed.items[0].coverUrl, null); assert.equal(removed.items[0].schemeCount, 1);
});

test('project directory is independently paged, exact, authorized and record-backed', async () => {
  const h = harness(), result = await allPages(h, { directory: 'projects' }, 'projects');
  assert.equal(result.total, 667); assert.equal(result.pages, 7);
  assert.equal(result.items.some(row => Number(row.id.slice(-4)) % 3 === 2), false);
  assert.equal((await h.list({ limit: '1' })).projects.length, 0);
  h.rows.projects.find(row => row.id === 'project-0000').denied = true;
  const first = await h.list({ directory: 'projects', limit: '1' });
  assert.equal(first.total, 666); assert.equal(first.projects.some(row => row.id === 'project-0000'), false);
  h.rows.projects.find(row => row.id === first.projects[0].id).denied = true;
  await assert.rejects(h.list({ directory: 'projects', cursor: first.nextCursor }), error => error.status === 409);
});

test('directory respects newest work project, private task project, zero schemes and removed membership', async () => {
  const h = harness({ rows: synthetic(6) });
  h.rows.works.find(row => row.id === 'work-0001-1').project_id = 'project-0005';
  h.rows.works.find(row => row.id === 'work-0000-1').project_id = 'project-0005';
  h.rows.works.splice(0, h.rows.works.length, ...h.rows.works.filter(row => row.source_task_id !== 'task-0003'));
  const result = await allPages(h, { directory: 'projects' }, 'projects');
  assert.deepEqual(result.items.map(row => row.id), ['project-0000', 'project-0003', 'project-0004', 'project-0005']);
  const records = await h.list(); assert.equal(records.items.find(row => row.taskId === 'task-0003').schemeCount, 0);
  assert.equal(records.items.find(row => row.taskId === 'task-0000').projectId, 'project-0000');
  assert.equal((await h.list({ projectId: 'project-0005' })).total, 1);
  assert.equal((await h.list({ projectId: 'project-0000' })).total, 1);
  assert.equal((await h.list({ directory: 'projects', removed: true })).total, 0);
});

test('actual records GET forwards strict paging and independent directory contract', async () => {
  const h = harness({ rows: synthetic(12) }), route = h.load('src/app/api/video/multiview/records/route.ts').GET;
  assert.equal((await route(h.request('cursor=unsigned'))).status, 400);
  assert.equal((await route(h.request('limit=0'))).status, 400);
  assert.equal((await route(h.request('limit=2&limit=3'))).status, 400);
  assert.equal((await route(h.request('directory=not-real'))).status, 400);
  assert.equal((await route(h.request('', 'other'))).status, 409);
  const response = await (await route(h.request('directory=projects&limit=2'))).json();
  assert.equal(response.projects.length, 2); assert.equal(response.total, 8); assert.ok(response.nextCursor);
});

test('client project loader completes all finite pages before returning preference choices', async () => {
  const h = harness({ rows: synthetic(340) }), route = h.load('src/app/api/video/multiview/records/route.ts').GET;
  const client = h.load('src/app/multiview/multiview-record-pages.ts'), urls = [];
  const complete = await client.loadMultiviewRecordProjects({ owner: 'owner', removed: false, signal: new AbortController().signal, current: () => true,
    fetch: async (url, options) => { urls.push(url); assert.equal(options.headers['x-app-session-user'], 'owner'); return route(h.request(url.split('?')[1])); } });
  assert.equal(complete.length, 227); assert.equal(urls.length, 3); assert.ok(complete.some(row => row.id === 'project-0339'));
});

test('client directory never returns partial/error/stale pages or silently accepts duplicate metadata', async () => {
  const h = harness({ rows: synthetic(3) }), client = h.load('src/app/multiview/multiview-record-pages.ts');
  const response = (projects, nextCursor, total = 2) => Response.json({ projects, total, nextCursor,
    pagination: { limit: 1, total, hasMore: Boolean(nextCursor), nextCursor } });
  for (const mode of ['failure', 'duplicate', 'stale']) {
    let reads = 0, current = true;
    await assert.rejects(client.loadMultiviewRecordProjects({ owner: 'owner', removed: false, signal: new AbortController().signal,
      current: () => current, fetch: async () => {
        if (++reads === 1) return response([{ id: 'p1', title: 'one' }], 'next');
        if (mode === 'failure') return Response.json({ error: 'directory unavailable' }, { status: 503 });
        if (mode === 'stale') current = false;
        return response([{ id: mode === 'duplicate' ? 'p1' : 'p2', title: 'two' }], null);
      } }));
  }
});

test('client directory discards a late response after an explicit abort', async () => {
  const h = harness({ rows: synthetic(1) }), client = h.load('src/app/multiview/multiview-record-pages.ts');
  const controller = new AbortController(); let release;
  const pending = client.loadMultiviewRecordProjects({ owner: 'owner', removed: false, signal: controller.signal, current: () => true,
    fetch: () => new Promise(resolve => { release = () => resolve(Response.json({ projects: [], total: 0, nextCursor: null,
      pagination: { limit: 100, total: 0, hasMore: false, nextCursor: null } })); }) });
  controller.abort(); release(); await assert.rejects(pending, error => error.name === 'AbortError');
});
