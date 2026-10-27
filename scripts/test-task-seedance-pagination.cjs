const assert = require('node:assert/strict');
const { test } = require('node:test');
const { harness, allPages, taskRoutes, ordered } = require('./task-seedance-pagination-fixture.cjs');
const request = query => ({ nextUrl: new URL('https://synthetic.invalid/?' + query), headers: new Headers() });
test('actual normal/IP/card handlers reject an invalid cursor instead of silently restarting', async () => {
  for (const file of ['src/app/api/video/list/route.ts', 'src/app/api/ip/video/list/route.ts', 'src/app/api/video-cards/[id]/tasks/route.ts']) {
    const h = harness();
    const response = await h.load(file).GET(request('cursor=not-a-valid-cursor'), { params: Promise.resolve({ id: 'card' }) });
    assert.equal(response.status, 400, file);
  }
});
test('actual Seedance list route never returns all 1000 records in one response', async () => {
  const h = harness(); const response = await h.load('src/app/api/assets/list/route.ts').GET(request('limit=100'));
  const data = await response.json();
  assert.equal(response.status, 200); assert.ok(data.assets.length <= 100, `returned ${data.assets.length}`);
});

test('1000 actual task rows: every cursor page, same timestamps, no loss/duplicates and bounded queries', async () => {
  for (const file of taskRoutes) {
    const h = harness(), result = await allPages(h, file);
    const expected = ordered(h.tasks.filter(row => file.includes('/ip/') ? row.provider === 'volcengine_ip' : row.provider === 'seedance')).map(row => row.id);
    assert.deepEqual(result.ids, expected); assert.equal(result.total, 1000);
    assert.equal(h.calls.filter(call => call.model === 'videoTask' && call.method === 'count').length, result.pages);
  }
});

test('actual task handlers preserve bounded malformed inputs and legacy page navigation', async () => {
  for (const file of taskRoutes) {
    const h = harness(), handler = h.load(file).GET, props = { params: Promise.resolve({ id: 'card' }) };
    for (const query of ['limit=1000000', 'limit=NaN&page=NaN', 'limit=-1&page=-8', 'limit=1&page=1']) {
      const response = await handler(h.request(query), props); assert.equal(response.status, 200);
      const data = await response.json(), args = h.calls.at(-1).args;
      assert.ok(data.tasks.length <= 100 && args.take <= 101); assert.ok(Number.isSafeInteger(args.skip) && args.skip >= 0);
    }
    const response = await handler(h.request('limit=17&page=2'), props), data = await response.json();
    const expected = ordered(h.tasks.filter(row => file.includes('/ip/') ? row.provider === 'volcengine_ip' : row.provider === 'seedance')).slice(17, 34).map(row => row.id);
    assert.deepEqual(data.tasks.map(row => row.id), expected); assert.equal(data.pagination.page, 2); assert.equal(data.pagination.total_pages, Math.ceil(1000 / 17));
  }
});

test('real shared tokens reject cross-account/filter/tampering/empty/duplicate cursor', async () => {
  for (const file of taskRoutes) {
    const h = harness(), handler = h.load(file).GET;
    const props = { params: Promise.resolve({ id: 'card' }) };
    const first = await (await handler(h.request('limit=7&project_id=p1'), props)).json();
    const cursor = first.pagination.nextCursor; assert.ok(cursor);
    for (const query of ['cursor=', 'cursor=x&cursor=y', 'cursor=' + encodeURIComponent(cursor.slice(0, -1) + (cursor.endsWith('0') ? '1' : '0'))]) {
      assert.equal((await handler(h.request(query + '&project_id=p1'), props)).status, 400);
    }
    h.setUser({ id: 'other', role: 'user', account_type: 'internal' });
    assert.equal((await handler(h.request('cursor=' + encodeURIComponent(cursor) + '&project_id=p1'), props)).status, 400);
    h.setUser({ id: 'owner', role: 'user', account_type: 'internal' });
    const altered = file.includes('/video-cards/') ? { params: Promise.resolve({ id: 'other-card' }) } : props;
    assert.equal((await handler(h.request('cursor=' + encodeURIComponent(cursor) + '&project_id=p2'), altered)).status, 400);
    assert.equal((await handler(h.request('limit=7', 'wrong-account'), props)).status, 409);
  }
});

test('missing/revoked task anchors return409; card authorization is fresh on every request', async () => {
  for (const file of taskRoutes) {
    const h = harness(), handler = h.load(file).GET, props = { params: Promise.resolve({ id: 'card' }) };
    const body = await (await handler(h.request('limit=5'), props)).json();
    const anchor = h.tasks.find(row => row.id === body.tasks.at(-1).id);
    anchor.retention_status = 'admin_hidden';
    assert.equal((await handler(h.request('cursor=' + encodeURIComponent(body.pagination.nextCursor)), props)).status, 409);
    h.tasks.splice(h.tasks.indexOf(anchor), 1);
    assert.equal((await handler(h.request('cursor=' + encodeURIComponent(body.pagination.nextCursor)), props)).status, 409);
    if (file.includes('/video-cards/')) {
      h.denyCard(); assert.equal((await handler(h.request('limit=5'), props)).status, 403); assert.ok(h.permissions.length >= 4);
    }
  }
});

test('Seedance all pages and counts use identical owner/quarantine/deleted scopes without row writes', async () => {
  const h = harness(), route = 'src/app/api/assets/list/route.ts';
  const originalUrls = h.rows.map(row => row.original_url);
  const repo = h.load('@/lib/assets/seedanceAssetRepository').seedanceAssetRepository;
  assert.equal((await allPages(h, route, 'assets')).total, 1000);
  assert.equal(await repo.count(false, 'owner'), 1000); assert.equal(await repo.count(), 0);
  assert.equal((await allPages(h, route, 'assets', 'limit=100&includeDeleted=true')).total, 1001);
  assert.equal(await repo.count(true, 'owner'), 1001);
  h.setUser({ id: 'admin', role: 'admin', account_type: 'internal' });
  assert.equal((await allPages(h, route, 'assets')).total, 1002); assert.equal(await repo.count(false, 'admin', true), 1002);
  assert.equal((await allPages(h, route, 'assets', 'limit=100&includeDeleted=true')).total, 1003);
  const first = await (await h.load(route).GET(h.request('limit=100'))).json();
  assert.equal(first.count, first.pagination.total);
  assert.equal(first.assets.find(row => row.ownershipStatus === 'quarantined').ownerId, null);
  assert.equal(first.assets.find(row => row.ownershipStatus === 'quarantined').originalUrl, '');
  assert.deepEqual(h.rows.map(row => row.original_url), originalUrls);
});

test('Seedance invalid/filter cursors and revoked ownership fail without restarting', async () => {
  const h = harness(), handler = h.load('src/app/api/assets/list/route.ts').GET;
  const first = await (await handler(h.request('limit=5'))).json(), cursor = encodeURIComponent(first.pagination.nextCursor);
  assert.equal((await handler(h.request('cursor=invalid'))).status, 400);
  assert.equal((await handler(h.request('cursor=' + cursor + '&includeDeleted=true'))).status, 400);
  h.rows.find(row => row.id === first.assets.at(-1).localId).ownership_status = 'quarantined';
  assert.equal((await handler(h.request('cursor=' + cursor))).status, 409);
});

function client(h, fetcher) {
  let session = { ownerId: 'owner', epoch: 0 };
  const handler = h.load('src/app/api/assets/list/route.ts').GET, calls = [];
  const read = async (url, options) => {
    assert.equal(options.method, undefined); calls.push(String(url));
    return handler(h.request(String(url).split('?')[1], options.headers['x-upload-owner-id']));
  };
  const { createSeedancePages } = h.load('src/lib/pagination/seedance-pages.ts');
  const pager = createSeedancePages({ fetch: fetcher ? (...args) => fetcher(read, ...args) : read, session: () => session, blocked: () => false });
  const scope = includeDeleted => ({ ...session, includeDeleted, visible: true });
  pager.setScope(scope(false));
  return { pager, calls, scope, setSession: value => { session = value; } };
}
test('actual panel pager incrementally exposes all1000 assets and stops at end', async () => {
  const h = harness(), c = client(h); await c.pager.refresh();
  assert.equal(c.pager.getSnapshot().assets.length, 24);
  while (c.pager.getSnapshot().pagination.hasMore) await c.pager.more();
  assert.equal(c.pager.getSnapshot().assets.length, 1000); assert.equal(c.pager.getSnapshot().pagination.total, 1000);
  const count = c.calls.length; await c.pager.more(); assert.equal(c.calls.length, count); c.pager.dispose();
});
test('actual panel pager keeps loaded rows and retries the same read cursor after failure', async () => {
  const h = harness(); let attempt = 0; const urls = [];
  const c = client(h, async (read, url, options) => { urls.push(url); if (++attempt === 2) throw new Error('private raw error'); return read(url, options); });
  await c.pager.refresh(); const before = c.pager.getSnapshot(); await c.pager.more();
  assert.equal(c.pager.getSnapshot().assets.length, 24); assert.equal(c.pager.getSnapshot().pagination.nextCursor, before.pagination.nextCursor);
  assert.equal(c.pager.getSnapshot().error.message.includes('private'), false);
  await c.pager.retry(); assert.equal(urls[1], urls[2]); assert.equal(c.pager.getSnapshot().assets.length, 48); c.pager.dispose();
});
test('actual panel pager resets invalid400 cursors and explicitly retries fresh scope after role changes', async () => {
  const h = harness(); h.setUser({ id: 'owner', role: 'admin', account_type: 'internal' });
  const c = client(h); await c.pager.refresh(); assert.equal(c.pager.getSnapshot().pagination.total, 1002);
  h.setUser({ id: 'owner', role: 'user', account_type: 'internal' }); await c.pager.more();
  assert.equal(c.pager.getSnapshot().assets.length, 0); assert.equal(c.pager.getSnapshot().pagination, null);
  assert.equal(c.pager.getSnapshot().error.retryMore, false); await c.pager.retry();
  assert.equal(c.pager.getSnapshot().pagination.total, 1000); assert.equal(c.pager.getSnapshot().assets.some(row => row.ownershipStatus === 'quarantined'), false);
  assert.equal(new URL(c.calls.at(-1), 'https://synthetic.invalid').searchParams.has('cursor'), false); c.pager.dispose();
});
test('actual panel pager discards late account responses and409 resets to fresh read', async () => {
  const h = harness(); let release, delay = true;
  const c = client(h, async (read, ...args) => delay ? new Promise(resolve => { release = () => resolve(Response.json({ assets: [{ localId: 'old-account' }], pagination: { limit: 24, total: 1, hasMore: false, nextCursor: null } })); }) : read(...args));
  const old = c.pager.refresh(); delay = false;
  c.setSession({ ownerId: 'other', epoch: 1 }); h.setUser({ id: 'other', role: 'user', account_type: 'internal' });
  c.pager.setScope(c.scope(false)); await c.pager.refresh(); release(); await old;
  assert.deepEqual(c.pager.getSnapshot().assets.map(row => row.localId), ['foreign']);
  c.pager.dispose();
  const next = harness(), d = client(next); await d.pager.refresh();
  next.setUser({ id: 'other', role: 'user', account_type: 'internal' });
  await d.pager.more(); assert.equal(d.pager.getSnapshot().assets.length, 0); assert.equal(d.pager.getSnapshot().pagination, null);
  assert.equal(d.pager.getSnapshot().error.retryMore, false);
  d.setSession({ ownerId: 'other', epoch: 1 }); d.pager.setScope(d.scope(false)); await d.pager.refresh();
  assert.deepEqual(d.pager.getSnapshot().assets.map(row => row.localId), ['foreign']); d.pager.dispose();
});
test('actual panel pager cancels stale filter results, deduplicates busy reads and has a real empty state', async () => {
  const h = harness(); let release, delay = true;
  const c = client(h, async (read, ...args) => delay ? new Promise(resolve => { release = () => resolve(Response.json({ assets: [{ localId: 'old-filter' }], pagination: { limit: 24, total: 1, hasMore: false, nextCursor: null } })); }) : read(...args));
  const old = c.pager.refresh(); delay = false; c.pager.setScope(c.scope(true)); await c.pager.refresh(); release(); await old;
  assert.equal(c.pager.getSnapshot().assets.some(row => row.localId === 'old-filter'), false); assert.equal(c.pager.getSnapshot().pagination.total, 1001); c.pager.dispose();
  const e = harness(); let reads = 0, finish;
  const d = client(e, async (read, ...args) => ++reads === 2 ? new Promise(resolve => { finish = () => resolve(read(...args)); }) : read(...args));
  await d.pager.refresh(); const pending = d.pager.more(); await d.pager.more(); assert.equal(reads, 2); finish(); await pending;
  assert.equal(d.pager.getSnapshot().assets.length, 48);
  e.setUser({ id: 'nobody', role: 'user', account_type: 'internal' }); d.setSession({ ownerId: 'nobody', epoch: 2 }); d.pager.setScope(d.scope(false)); await d.pager.refresh();
  assert.equal(d.pager.getSnapshot().assets.length, 0); assert.equal(d.pager.getSnapshot().pagination.total, 0); assert.equal(d.pager.getSnapshot().error, null); d.pager.dispose();
});
