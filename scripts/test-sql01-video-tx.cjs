const assert = require('node:assert/strict');
const test = require('node:test');
const { harness, runCreatePrefix, sources } = require('./sql01-video-fixture.cjs');

test('actual video context project and card reads remain on the supplied transaction', async () => {
  const h = harness(); const body = { ...h.body, template_studio_run_id: undefined, template_studio_assets: undefined, project_id: '' };
  const result = await h.run(tx => h.pricing.resolveVideoPricingContext(h.user, body, 'create', tx));
  assert.equal(result.projectId, 'project'); assert.equal(result.videoCardId, 'card'); assert.equal(result.payer.id, h.user.id);
  assert.equal(h.globalCalls, 0); assert.equal(h.writes, 0);
});
test('actual template handoff, version, asset and inherited album rights use the same transaction without media I/O', async () => {
  process.env.TOS_PUBLIC_BASE_URL = 'https://synthetic.invalid';
  const h = harness();
  const result = await h.run(tx => h.pricing.resolveVideoPricingContext(h.user, h.body, 'create', tx));
  assert.equal(result.referenceVideoCount, 1); assert.equal(result.templateRunId, 'run');
  for (const model of ['project', 'videoCard', 'videoStudioRun', 'videoStudioTemplate', 'videoStudioTemplateVersion', 'asset', 'referenceImage']) {
    assert.ok(h.calls.some(call => call.scope === 'tx' && call.model === model), model);
  }
  assert.deepEqual(h.io, []); assert.equal(h.globalCalls, 0); assert.equal(h.writes, 0);
});
test('actual create and draft-upgrade transaction validation prefixes reach their read-only stop', async () => {
  for (const [i, source] of sources.entries()) {
    const h = harness(); let body = h.body, mode = 'create';
    if (i) { body = { ...h.pricing.savedVideoPricingContextInput(h.rows.draft, true), project_id: 'project', video_card_id: 'card' }; mode = 'draft_upgrade'; }
    const context = await h.run(tx => h.pricing.resolveVideoPricingContext(h.user, body, mode, tx));
    const token = h.pricing.issueVideoPricingCredential(context, null, 5), bindings = h.bindings(context, token, Boolean(i));
    assert.equal(await h.run(tx => runCreatePrefix(source, bindings, tx)), 'checked-before-any-write');
    assert.equal(h.globalCalls, 0); assert.equal(h.writes, 0); assert.deepEqual(h.io, []);
  }
});

test('fresh project membership, active state and video-card ownership/status still deny inside the transaction', async () => {
  for (const change of ['revoked', 'archived-project', 'wrong-project', 'sealed-card']) {
    const h = harness();
    if (change === 'revoked') h.rows.project.members[0].status = 'revoked';
    if (change === 'archived-project') h.rows.project.status = 'archived';
    if (change === 'wrong-project') h.rows.card.project_id = 'other';
    if (change === 'sealed-card') h.rows.card.status = 'sealed';
    await assert.rejects(h.run(tx => h.pricing.resolveVideoPricingContext(h.user, h.body, 'create', tx)), error => [400, 403].includes(error.status), change);
    assert.equal(h.globalCalls, 0); assert.equal(h.writes, 0);
  }
});

test('template archive/access/version and inactive or revoked shared assets still fail closed', async () => {
  for (const change of ['archive', 'private', 'version', 'asset-inactive', 'asset-type', 'asset-grant']) {
    const h = harness();
    if (change === 'archive') h.rows.template.status = 'archived';
    if (change === 'private') { h.rows.template.visibility = 'private'; h.rows.template.owner_user_id = 'other'; }
    if (change === 'version') h.snapshot.recipe = { ...h.snapshot.recipe, instruction: 'changed saved recipe' };
    if (change === 'asset-inactive') h.rows.asset.status = 'deleted';
    if (change === 'asset-type') h.rows.asset.type = 'audio';
    if (change === 'asset-grant') h.rows.album.shares[0].permissions_json = JSON.stringify({ view: true, use: false });
    await assert.rejects(h.run(tx => h.pricing.resolveVideoPricingContext(h.user, h.body, 'create', tx)), error => [403, 404, 409].includes(error.status), change);
    assert.equal(h.globalCalls, 0); assert.equal(h.writes, 0); assert.deepEqual(h.io, []);
  }
});

test('outside callers retain physical preflight, fingerprint, payer and real signed credential behavior', async () => {
  process.env.TOS_PUBLIC_BASE_URL = 'https://synthetic.invalid';
  const h = harness();
  const outside = await h.pricing.resolveVideoPricingContext(h.user, h.body);
  assert.ok(h.io.length >= 1); assert.equal(h.io.every(value => value === 'outside-network'), true);
  const inside = await h.run(tx => h.pricing.resolveVideoPricingContext(h.user, h.body, 'create', tx));
  assert.deepEqual(inside, outside);
  const token = h.pricing.issueVideoPricingCredential(outside, null, 5);
  assert.doesNotThrow(() => h.pricing.verifyVideoPricingCredential(token, inside, null, 5));
  for (const mutation of ['payer', 'source-version', 'actor', 'amount', 'tamper']) {
    let context = inside;
    if (mutation === 'payer') { h.rows.project.type = 'public'; context = await h.run(tx => h.pricing.resolveVideoPricingContext(h.user, h.body, 'create', tx)); }
    if (mutation === 'source-version') { h.rows.asset.hash = 'different'; context = await h.run(tx => h.pricing.resolveVideoPricingContext(h.user, h.body, 'create', tx)); }
    if (mutation === 'actor') context = { ...inside, actorId: 'other' };
    assert.throws(() => h.pricing.verifyVideoPricingCredential(mutation === 'tamper' ? token + 'x' : token, context, null, mutation === 'amount' ? 6 : 5), mutation);
  }
  assert.equal(h.writes, 0);
});

test('actual standard-create prefix rejects a post-quote permission change before any write', async () => {
  const h = harness(), context = await h.run(tx => h.pricing.resolveVideoPricingContext(h.user, h.body, 'create', tx));
  const token = h.pricing.issueVideoPricingCredential(context, null, 5);
  h.rows.card.status = 'sealed';
  await assert.rejects(h.run(tx => runCreatePrefix(sources[0], h.bindings(context, token), tx)), error => error.status === 403);
  assert.equal(h.writes, 0); assert.equal(h.globalCalls, 0);
});

test('private video context target and template serialization share the supplied session client', async () => {
  for (const draftId of [undefined, 'studio-draft']) {
    const h = harness({ privateAllowed: true }), context = h.load('src/lib/template-studio/context.ts');
    const target = await h.run(tx => context.privateVideoContextTarget(h.user, draftId, tx));
    assert.equal(target.setting.revision, 0);
    assert.ok(h.calls.some(call => call.scope === 'tx' && call.model === 'userSession'));
    if (draftId) assert.ok(h.calls.some(call => call.scope === 'tx' && call.model === 'videoStudioTemplate'));
    assert.equal(h.globalCalls, 0); assert.equal(h.writes, 0);
  }
});

test('private video context edit still rejects at the signed identity boundary before any setting write', async () => {
  const h = harness(), context = h.load('src/lib/template-studio/context.ts');
  const target = { access: { key: 'video_studio_context_v1' }, setting: { revision: 0 },
    draftTarget: { origins: [{ kind: 'video-global', id: 'video_studio_context_v1' }] } };
  await assert.rejects(h.run(tx => context.writePrivateVideoContext(tx, h.user, target, 'do not persist')), /private denied/);
  assert.equal(h.globalCalls, 0); assert.equal(h.writes, 0);
});
