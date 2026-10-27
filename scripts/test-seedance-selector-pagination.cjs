const assert = require('node:assert/strict');
const test = require('node:test');
const { selectorFixture, asset, page } = require('./seedance-selector-fixture.cjs');

test('actual selector empty matching first page keeps later-page loading reachable', async () => {
  let reads = 0;
  const f = selectorFixture(async () => ++reads === 1
    ? page([asset('video', { assetType: 'Video' }), asset('unknown', { status: 'Unknown' })], true, 3)
    : page([asset('later-image')], false, 3));
  await f.pager.refresh(); let view = f.render();
  assert.doesNotMatch(view.html, /暂无可用资产/);
  assert.ok(view.button('加载更多'), 'filtered first page must still offer more');
  await view.button('加载更多').props.onClick(); view = f.render();
  assert.ok(view.button('later-image')); assert.equal(reads, 2); f.pager.dispose();
});

test('actual selector later-page selection adapts local id and status without changing callback shape', async () => {
  let reads = 0, selected;
  const target = [{ localAssetId: 'already', provider: 'seedance', providerAssetId: 'provider-already', name: 'already',
    originalUrl: 'https://synthetic.invalid/already.png', order: 0 }];
  const f = selectorFixture(async () => ++reads === 1 ? page([asset('audio', { assetType: 'Audio' })], true, 2)
    : page([asset('later-image')], false, 2));
  await f.pager.refresh(); await f.pager.more();
  const view = f.render({ value: target, onChange: next => { selected = next; } });
  const pick = view.button('later-image'); assert.ok(pick, 'active positive DTO image must be selectable');
  assert.equal(pick.props.type, 'button'); pick.props.onClick();
  assert.deepEqual(selected, [...target, { localAssetId: 'later-image', provider: 'seedance', providerAssetId: 'provider-later-image',
    name: 'later-image', originalUrl: 'https://synthetic.invalid/later-image.png', providerPreviewUrl: null, providerStatus: 'Active', order: 1 }]);
  assert.match(view.html, /已显示全部可用图片/); f.pager.dispose();
});

test('actual selector retains rows and exposes failure retry even with zero matching images', async () => {
  let reads = 0; const urls = [];
  const f = selectorFixture(async url => { urls.push(url); reads++;
    if (reads === 2) throw new Error('private provider error');
    return reads === 1 ? page([asset('video', { assetType: 'Video' })], true, 2) : page([asset('retry-image')], false, 2);
  });
  await f.pager.refresh(); await f.render().button('加载更多').props.onClick();
  let view = f.render(); assert.ok(view.button('重试')); assert.doesNotMatch(view.html, /暂无可用资产|private provider error/);
  assert.equal(f.pager.getSnapshot().assets.length, 1);
  await view.button('重试').props.onClick(); view = f.render();
  assert.equal(urls[1], urls[2]); assert.ok(view.button('retry-image')); f.pager.dispose();
});

test('actual selector busy, initial failure, empty and end controls remain truthful', async () => {
  let release, reads = 0;
  const f = selectorFixture(async () => { if (++reads === 1) return page([asset('first')], true, 2);
    return new Promise(resolve => { release = () => resolve(page([asset('last')], false, 2)); }); });
  await f.pager.refresh(); const pending = f.render().button('加载更多').props.onClick();
  let view = f.render(); assert.equal(view.button('加载更多').props.disabled, true); assert.ok(view.button('first'));
  await view.button('加载更多').props.onClick(); assert.equal(reads, 2); release(); await pending;
  view = f.render(); assert.equal(view.button('加载更多'), undefined); assert.match(view.html, /已显示全部可用图片/); f.pager.dispose();
  let fail = true;
  const e = selectorFixture(async () => { if (fail) throw new Error('offline'); return page([], false); });
  await e.pager.refresh(); view = e.render(); assert.ok(view.button('重试')); assert.doesNotMatch(view.html, /暂无可用资产/);
  fail = false; await view.button('重试').props.onClick(); view = e.render();
  assert.match(view.html, /暂无可用资产/); assert.equal(view.button('加载更多'), undefined); e.pager.dispose();
});

test('actual selector rejects stale account, epoch, exited-session and replaced-target event callbacks', async () => {
  let selected = 0;
  const f = selectorFixture(async () => page([asset('old-account')], false));
  await f.pager.refresh(); const old = f.render({ onChange: () => { selected++; } }).button('old-account'); assert.ok(old);
  f.setSession({ ownerId: 'other', epoch: 1 }); old.props.onClick(); assert.equal(selected, 0);
  assert.equal(f.render().button('old-account'), undefined);
  await f.pager.refresh(); const epoch = f.render({ onChange: () => { selected++; } }).button('old-account');
  f.setSession({ ownerId: 'other', epoch: 2 }); epoch.props.onClick(); assert.equal(selected, 0);
  await f.pager.refresh(); const beforeExit = f.render({ onChange: () => { selected++; } }).button('old-account');
  f.block(); beforeExit.props.onClick(); assert.equal(selected, 0); f.pager.dispose();
  const t = selectorFixture(async () => page([asset('target-image')], false)); await t.pager.refresh();
  let oldTarget = 0, newTarget;
  const previous = t.render({ onChange: () => { oldTarget++; } }).button('target-image');
  const current = t.render({ value: [], onChange: next => { newTarget = next; } }).button('target-image');
  previous.props.onClick(); assert.equal(oldTarget, 0); assert.equal(newTarget, undefined);
  current.props.onClick(); assert.equal(newTarget[0].localAssetId, 'target-image'); t.pager.dispose();
});

test('actual selector never renders or selects late account responses', async () => {
  let release, first = true;
  const f = selectorFixture(async () => first ? new Promise(resolve => { release = () => resolve(page([asset('stale')], false)); })
    : page([asset('fresh')], false));
  const old = f.pager.refresh(); f.setSession({ ownerId: 'fresh-owner', epoch: 1 }); first = false;
  await f.pager.refresh(); release(); await old;
  const view = f.render(); assert.equal(view.button('stale'), undefined); assert.ok(view.button('fresh')); f.pager.dispose();
});

test('actual selector does not infer selectable ownership for quarantine or denied original access', async () => {
  let reads = 0;
  const f = selectorFixture(async () => ++reads === 1 ? page([
    asset('quarantined', { ownerId: null, ownershipStatus: 'quarantined', originalUrl: '', providerPreviewUrl: '' }),
    asset('no-owner', { ownerId: null }), asset('no-original', { originalUrl: '' }),
  ], true, 4) : page([asset('usable')], false, 4));
  await f.pager.refresh(); let view = f.render();
  for (const id of ['quarantined', 'no-owner', 'no-original']) assert.equal(view.button(id), undefined, id);
  assert.ok(view.button('加载更多')); assert.doesNotMatch(view.html, /暂无可用资产/);
  await view.button('加载更多').props.onClick(); view = f.render(); assert.ok(view.button('usable')); f.pager.dispose();
});
