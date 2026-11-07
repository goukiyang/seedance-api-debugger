// Real encryption, isolated keys and no database/network: reproduce first publication readback.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomBytes } = require('node:crypto'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-share-readback-')));
fs.chmodSync(fixture, 0o700);
const write = (name, value) => fs.writeFileSync(path.join(fixture, name), Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 });
Object.assign(process.env, { NODE_ENV: 'test', PRIVATE_PROMPTS_FIXTURE_ROOT: fixture,
  PRIVATE_PROMPTS_POLICY_FILE: path.join(fixture, 'policy.json'), PRIVATE_PROMPTS_MIN_STATE: 'encrypted-write',
  PRIVATE_PROMPTS_CONSUMER_ID: 'fixture', PRIVATE_PROMPTS_RUNTIME_REVISION: 'c'.repeat(40) });
const original = { kind: 'image-module', id: 'module', ownerId: 'author' };
const policy = { schema: 'private-prompt-policy.v1', revision: 'share-readback', state: 'encrypted-write', minimumReader: 1,
  identities: [{ userId: 'author', tenant: 'tenant', subject: 'author-subject' }], origins: [original],
  authorKinds: [{ ownerId: 'author', kinds: ['image-module', 'image-preset'] }], destinations: [], consumers: ['fixture'],
  keys: Object.fromEntries(['body', 'index', 'backup'].map(domain => {
    write(domain + '.key', randomBytes(32)); return [domain, { active: domain, files: { [domain]: path.join(fixture, domain + '.key') } }];
  })), activation: { inventoryId: 'inventory', restoreId: 'restore', writerFenceId: 'fence', attestationFile: path.join(fixture, 'consumers.json') } };
write('policy.json', policy); write('consumers.json', { schema: 'private-prompt-consumers.v1', policyRevision: policy.revision,
  inventoryId: 'inventory', restoreId: 'restore', writerFenceId: 'fence', consumers: [{ id: 'fixture', reader: 1, permissionContract: 1, sourceRevision: 'c'.repeat(40) }] });
const cache = new Map(), checks = [];
function load(relative) {
  const file = path.resolve(root, relative); if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} }; cache.set(file, mod);
  const source = fs.readFileSync(file, 'utf8');
  new Function('require', 'module', 'exports', ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText)(id => {
    if (id === 'server-only') return {};
    if (id === '@/lib/auth/session') return { getSession: async () => null };
    if (id === '@/lib/prisma') throw new Error('Database access forbidden in this fixture');
    if (id.startsWith('@/') || id.startsWith('.')) {
      const base = id.startsWith('@/') ? path.join(root, 'src', id.slice(2)) : path.resolve(path.dirname(file), id);
      const target = [base, base + '.ts', base + '.tsx'].find(f => fs.existsSync(f) && fs.statSync(f).isFile());
      assert(target, id); return load(path.relative(root, target));
    }
    return require(id);
  }, mod, mod.exports);
  return mod.exports;
}
(async () => {
  try {
    const crypto = load('src/lib/security/private-prompts.server.ts'), fields = load('src/lib/security/private-prompt-fields.server.ts');
    const storage = load('src/lib/image-studio/private-storage.server.ts');
    const sealed = storage.writePrivateStudioDefinition('image-module', { id: 'module', owner_id: 'author', prompt: 'private template prompt', context: 'private template context' });
    const linked = { ...sealed, source_preset_id: 'module-source:module' };
    assert.equal(crypto.privateOrigin('image-preset', linked.source_preset_id), null, 'new source is absent from the static inventory');
    const decoded = storage.readPrivateStudioDefinition('image-module', linked);
    assert.equal(decoded.context, 'private template context'); assert.equal(decoded.prompt, 'private template prompt');
    assert.deepEqual(fields.privateFieldOrigins(decoded, 'context'), [original]);
    assert.equal(storage.readPrivateStudioDefinition('image-module', decoded), decoded);
    checks.push('first publication reads the authenticated original origins without changing the source inventory');
    const preset = storage.writePrivateStudioDefinition('image-preset', { id: linked.source_preset_id, owner_id: 'author', prompt: decoded.prompt, context: decoded.context }, decoded);
    const source = storage.readPrivateStudioDefinition('image-preset', preset);
    const copy = storage.writePrivateStudioDefinition('image-module', { id: 'consumer-copy', owner_id: 'coworker', source_preset_id: preset.id, prompt: source.prompt, context: source.context }, source);
    const copied = storage.readPrivateStudioDefinition('image-module', copy);
    assert.equal(copied.context, decoded.context); assert.deepEqual(fields.privateFieldOrigins(copied, 'context'), [original]);
    const identity = load('src/lib/security/private-prompt-identity.server.ts');
    assert.equal(identity.privatePromptCapabilities({ id: 'coworker', role: 'user', account_type: 'internal' }, [original]).canReadPrivatePrompt, false);
    checks.push('shared copy retains original authorship and gives no raw-text capability to another user');
    const sharedTask = { id: 'dynamic-shared-task', owner_id: 'coworker', source_preset_id: preset.id,
      prompt: source.prompt, context: source.context, snapshot_json: JSON.stringify({ sourcePresetId: preset.id,
        sharedSourceOwnerId: 'author', moduleContext: source.context, templatePrompt: source.prompt, personalPrompt: 'ordinary supplement' }) };
    const definitionOrigins = [...fields.privateFieldOrigins(source, 'context'), ...fields.privateFieldOrigins(source, 'prompt')];
    const frozen = storage.transformPrivateImageTask(sharedTask, true, definitionOrigins);
    const frozenSnapshot = JSON.parse(frozen.snapshot_json);
    for (const value of [frozen.prompt, frozen.context, frozenSnapshot.moduleContext, frozenSnapshot.templatePrompt]) assert.equal(crypto.isStoredPrivatePrompt(value), true);
    assert.equal(frozenSnapshot.personalPrompt, 'ordinary supplement');
    const thawed = storage.transformPrivateImageTask(frozen, false);
    const thawedSnapshot = storage.readPrivateImageTaskSnapshot(thawed);
    assert.equal(thawedSnapshot.moduleContext, source.context); assert.equal(thawedSnapshot.templatePrompt, source.prompt);
    assert.deepEqual(fields.privateFieldOrigins(thawedSnapshot, 'moduleContext'), [original]);
    assert.equal(fields.privateStoredValue(thawed), frozen);
    assert.equal(identity.privatePromptCapabilities({ id: 'coworker', role: 'user' }, fields.privateFieldOrigins(thawedSnapshot, 'moduleContext')).canReadPrivatePrompt, false);
    checks.push('dynamic shared task seals authenticated template origins while keeping personal supplement plain; compatible read preserves raw freeze');
    const legacy = storage.transformPrivateImageTask(sharedTask, false);
    const legacySnapshot = storage.readPrivateImageTaskSnapshot(legacy);
    assert.equal(fields.privateStoredValue(legacy), sharedTask);
    assert.equal(legacy.snapshot_json, sharedTask.snapshot_json);
    assert.deepEqual(fields.privateFieldOrigins(legacySnapshot, 'moduleContext'), [{ kind: 'image-preset', id: preset.id, ownerId: 'author' }]);
    assert.equal(storage.privateImageTaskOrigins(legacy).some(origin => origin.ownerId === 'coworker'), false);
    assert.equal(identity.privatePromptCapabilities({ id: 'coworker', role: 'user' }, fields.privateFieldOrigins(legacySnapshot, 'moduleContext')).canReadPrivatePrompt, false);
    checks.push('legacy frozen author protects dynamic-source plaintext on read without rewriting the historical row or assigning authorship to consumer');
    assert.throws(() => storage.transformPrivateImageTask({ ...frozen, id: 'wrong-task' }, false), crypto.PrivatePromptError);
    const spoofed = storage.transformPrivateImageTask({ ...frozen, snapshot_json: JSON.stringify({ ...frozenSnapshot, sharedSourceOwnerId: 'coworker' }) }, false);
    assert.deepEqual(fields.privateFieldOrigins(storage.readPrivateImageTaskSnapshot(spoofed), 'moduleContext'), [original]);
    checks.push('task row binding and authenticated ciphertext origins remain authoritative over claimed snapshot author');
    // Live workspaces store only their source binding, not a private definition.
    const live = { id: 'live-coworker', owner_id: 'coworker', source_preset_id: preset.id, prompt: '', context: '' };
    const liveRead = storage.readPrivateStudioDefinition('image-module', live);
    assert.equal(liveRead.prompt, ''); assert.equal(liveRead.context, '');
    assert.deepEqual(fields.privateFieldOrigins(liveRead, 'context'), []);
    assert.equal(fields.privateStoredValue(liveRead), live);
    checks.push('blank colleague live workspace reads without inventing source authorship');
    const mixed = { ...copy, prompt: '' };
    const mixedRead = storage.readPrivateStudioDefinition('image-module', mixed);
    assert.equal(mixedRead.prompt, ''); assert.equal(mixedRead.context, decoded.context);
    assert.deepEqual(fields.privateFieldOrigins(mixedRead, 'context'), [original]);
    assert.deepEqual(fields.privateFieldOrigins(mixedRead, 'prompt'), []);
    const emptySealed = storage.writePrivateStudioDefinition('image-module', { id: 'module', owner_id: 'author', prompt: '', context: '' });
    const emptyRead = storage.readPrivateStudioDefinition('image-module', { ...emptySealed, source_preset_id: preset.id });
    assert.deepEqual(fields.privateFieldOrigins(emptyRead, 'context'), [original]);
    assert.throws(() => storage.readPrivateStudioDefinition('image-module', { ...live, context: emptySealed.context }), crypto.PrivatePromptError);
    checks.push('mixed blank and encrypted fields preserve provenance; encrypted empty fields still authenticate their row');
    for (const field of ['prompt', 'context']) for (const value of ['plain', ' ']) {
      assert.throws(() => storage.readPrivateStudioDefinition('image-module', { ...live, [field]: value }), crypto.PrivatePromptError);
    }
    checks.push('nonempty plaintext including whitespace still requires the original private source');
    for (const invalid of [{ ...linked, id: 'other-module' }, { ...linked, context: sealed.prompt }]) {
      assert.throws(() => storage.readPrivateStudioDefinition('image-module', invalid), crypto.PrivatePromptError);
    }
    const envelope = crypto.inspectPrivatePrompt(sealed.context);
    envelope.tag = randomBytes(16).toString('base64url');
    assert.throws(() => storage.readPrivateStudioDefinition('image-module', { ...linked, context: 'ppenc:v1:' + JSON.stringify(envelope) }), crypto.PrivatePromptError);
    checks.push('wrong row, wrong field and authentication-tag tampering remain rejected');
    assert.throws(() => storage.readPrivateStudioDefinition('image-module', { id: 'copy', owner_id: 'coworker', source_preset_id: preset.id, prompt: 'plain', context: 'plain' }), crypto.PrivatePromptError);
    assert.throws(() => storage.studioDefinitionOrigins('image-module', { id: 'copy', owner_id: 'coworker', source_preset_id: preset.id }), crypto.PrivatePromptError);
    checks.push('unknown plaintext source and direct source inference still fail closed');
    const unchanged = await storage.protectStudioDefinitionPatch('image-module', decoded, { prompt: decoded.prompt, context: decoded.context }, 'author');
    assert.equal(unchanged.prompt, sealed.prompt); assert.equal(unchanged.context, sealed.context);
    const ordinary = await storage.protectStudioDefinitionPatch('image-module', decoded, { context: 'overwrite' }, 'coworker');
    assert.equal(ordinary.context, sealed.context);
    await assert.rejects(storage.protectStudioDefinitionPatch('image-module', decoded, { context: 'overwrite' }, 'author', true));
    checks.push('unchanged fields preserve exact encrypted bytes; ordinary writes and unauthenticated private edits cannot replace them');
    const migration = load('src/lib/image-studio/private-migration.server.ts');
    let plannedRow = linked;
    const db = { imageStudioModule: { findMany: async () => [plannedRow] }, imageStudioPreset: { findMany: async () => [] }, imageStudioTask: { findMany: async () => [] } };
    const selection = { modules: ['module'], presets: [], tasks: [] };
    const plan = await migration.prepareImagePrivateMigration(db, selection);
    assert.equal(plan.rows.length, 0); assert.equal(plan.unchangedRows, 1); assert.equal(plan.unclassifiedRows, 0);
    plannedRow = { ...linked, context: 'plaintext with unknown source' };
    await assert.rejects(migration.prepareImagePrivateMigration(db, selection), crypto.PrivatePromptError);
    plannedRow = { ...linked, context: 'ppenc:v1:' + JSON.stringify(envelope) };
    await assert.rejects(migration.prepareImagePrivateMigration(db, selection), crypto.PrivatePromptError);
    checks.push('explicit maintenance plan authenticates inherited encrypted origins without rewriting bytes; unknown plaintext and tampering still fail');
    console.log(JSON.stringify({ synthetic: true, passed: true, checks, productionWrites: 0, networkCalls: 0, paidRequests: 0, browserRuns: 0 }));
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
