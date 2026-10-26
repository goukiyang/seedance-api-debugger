import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

/**
 * Offline contract gate. Like upload-client-recovery-engineering, evaluate the
 * candidate's actual TypeScript in an import allowlist. Like image-size-policy-
 * engineering, extract real declarations where the full service graph is not
 * isolated. No application Prisma module, driver, HTTP, or image encoder loads.
 * Memory rows model storage boundaries; this does not prove SQLite durability,
 * image quality, browser interaction, or production permissions/data.
 */
type Row = Record<string, any>;
type Exports = Record<string, any>;
const fixtureFile = 'scripts/template-author-cover-contract-engineering.ts';
const sourceFiles = [fixtureFile, 'src/lib/image-studio/template-author.ts', 'src/lib/image-studio/definition-read.ts',
  'src/lib/image-studio/module-cover.ts', 'src/lib/image-studio/module-cover-types.ts',
  'src/lib/image-studio/shared-contract.ts', 'src/lib/image-studio/shared-command-storage.ts',
  'src/lib/image-studio/workspace-deletion.ts', 'src/lib/image-studio/preset-lifecycle.ts',
  'src/lib/image-studio/context-version.ts', 'src/lib/image-studio/access.ts',
  'src/lib/image-studio/dimension-mismatch.ts', 'src/lib/image-studio/pricing-state.ts',
  'src/lib/assets/site-url.ts', 'src/lib/access/external-role.ts', 'src/lib/users/profiles.ts', 'src/lib/users/display.ts'];
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

async function main() {
  const root = realpathSync(process.cwd()), startedAt = Date.now();
  assert.ok(process.argv[2], 'A private candidate receipt path is required');
  const destination = path.resolve(process.argv[2]);
  assert.ok(destination.startsWith(path.join(root, '.role-tests') + path.sep));
  assert.equal(realpathSync(path.dirname(destination)), path.dirname(destination), 'Receipt parent cannot be a symlink');
  assert.ok(lstatSync(path.dirname(destination)).isDirectory());
  const runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID;
  assert.match(runId || '', /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  const sourceSha256 = Object.fromEntries(sourceFiles.map(file => [file, sha(readFileSync(path.join(root, file)))]));
  const checks: string[] = [], evaluatedSources = new Set<string>();
  let forbiddenCalls = 0, syntheticWrites = 0, allowWrites = false, rejectCasKey: string | null = null;
  const forbidden = (label: string): never => { forbiddenCalls++; throw new Error(`Unapproved offline boundary: ${label}`); };
  const fakeRoot = '/synthetic/template-author-cover';
  const syntheticEnv: Record<string, string> = { NODE_ENV: 'test', FEISHU_ALLOWED_TENANT_KEY: 'fixture-company' };
  const source = (file: string) => readFileSync(path.join(root, file), 'utf8');
  function evaluate(file: string, imports: Exports, globals: Exports = {}, text = source(file)) {
    evaluatedSources.add(file);
    const exports: Exports = {};
    const context = vm.createContext({ exports, Buffer, URL, URLSearchParams, Date, Error, console,
      AbortSignal: { timeout: () => new AbortController().signal },
      process: { env: syntheticEnv, cwd: () => fakeRoot }, fetch: () => forbidden('fetch'),
      setTimeout: () => forbidden('timer'), clearTimeout: () => {}, ...globals,
      require(name: string) {
        if (!Object.hasOwn(imports, name)) return forbidden(`import:${name}`);
        return imports[name];
      },
    });
    const output = ts.transpileModule(text, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } }).outputText;
    vm.runInContext(output, context, { filename: file, timeout: 10000 });
    return exports;
  }
  function declarations(file: string, names: string[]) {
    const text = source(file), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const selected = ast.statements.filter(statement => ts.isFunctionDeclaration(statement) && statement.name && names.includes(statement.name.text)
      || ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && names.includes(item.name.text)));
    assert.equal(selected.length, names.length, 'Required candidate helper declarations must still exist');
    return selected.map(statement => statement.getFullText(ast)).join('\n');
  }
  const selectedRow = (row: Row | undefined, select?: Row) => row ? select
    ? Object.fromEntries(Object.keys(select).filter(key => select[key] === true).map(key => [key, row[key]])) : { ...row } : null;
  function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, wanted]) => {
      if (key === 'AND') return (Array.isArray(wanted) ? wanted : [wanted]).every(item => matches(row, item));
      if (key === 'OR') return wanted.some((item: Row) => matches(row, item));
      const actual = row[key];
      if (!wanted || typeof wanted !== 'object' || wanted instanceof Date) return wanted instanceof Date
        ? actual instanceof Date && actual.getTime() === wanted.getTime() : actual === wanted;
      return Object.entries(wanted).every(([operator, value]) => {
        if (operator === 'in') return (value as unknown[]).includes(actual);
        if (operator === 'not') return actual !== value;
        if (operator === 'contains') return typeof actual === 'string' && actual.includes(String(value));
        return forbidden(`where:${operator}`);
      });
    });
  }
  const users = new Map<string, Row>(), presets = new Map<string, Row>(), modules = new Map<string, Row>();
  const tasks = new Map<string, Row>(), assets = new Map<string, Row>(), settings = new Map<string, Row>();
  let latestQueries = 0, assetReads = 0;
  function model(rows: Map<string, Row>, key: string, name: string) {
    const methods: Exports = {
      findUnique: async ({ where, select }: Row) => selectedRow(rows.get(where[key]), select),
      findUniqueOrThrow: async ({ where, select }: Row) => {
        const row = rows.get(where[key]); assert.ok(row, `${name} original row missing`); return selectedRow(row, select);
      },
      findFirst: async ({ where, select, orderBy }: Row) => {
        if (name === 'task' && !where.id) latestQueries++;
        const found = Array.from(rows.values()).filter(row => matches(row, where));
        if (orderBy) found.sort((left, right) => (right.finished_at?.getTime() || 0) - (left.finished_at?.getTime() || 0) || right.id.localeCompare(left.id));
        return selectedRow(found[0], select);
      },
      findMany: async ({ where, select }: Row = {}) => {
        if (name === 'asset') assetReads++;
        return Array.from(rows.values()).filter(row => matches(row, where)).map(row => selectedRow(row, select));
      },
      create: async ({ data }: Row) => {
        if (!allowWrites || name !== 'setting') return forbidden(`write:${name}`);
        if (rows.has(data[key])) throw Object.assign(new Error('Synthetic unique conflict'), { code: 'P2002' });
        syntheticWrites++; rows.set(data[key], { ...data }); return { ...data };
      },
      updateMany: async ({ where, data }: Row) => {
        if (!allowWrites || name !== 'setting') return forbidden(`write:${name}`);
        if (rejectCasKey === where.key) { rejectCasKey = null; return { count: 0 }; }
        let count = 0;
        for (const [id, row] of Array.from(rows)) if (matches(row, where)) { syntheticWrites++; rows.set(id, { ...row, ...data }); count++; }
        return { count };
      },
    };
    return new Proxy(methods, { get: (target, property) => Object.hasOwn(target, property) ? target[String(property)]
      : () => forbidden(`prisma:${name}.${String(property)}`) });
  }
  const db: Exports = { user: model(users, 'id', 'user'), imageStudioPreset: model(presets, 'id', 'preset'),
    imageStudioModule: model(modules, 'id', 'module'), imageStudioTask: model(tasks, 'id', 'task'),
    asset: model(assets, 'id', 'asset'), platformSetting: model(settings, 'key', 'setting') };
  db.$transaction = async (callback: (tx: Exports) => Promise<unknown>) => {
    const snapshot = new Map(Array.from(settings, ([key, row]) => [key, { ...row }]));
    try { return await callback(db); }
    catch (error) { settings.clear(); for (const [key, row] of Array.from(snapshot)) settings.set(key, row); throw error; }
  };
  const prisma = new Proxy(db, { get: (target, property) => Object.hasOwn(target, property) ? target[String(property)]
    : () => forbidden(`prisma:${String(property)}`) });
  const crypto = { createHash, randomUUID };
  const profile = evaluate('src/lib/users/profiles.ts', {});
  const external = evaluate('src/lib/access/external-role.ts', { '@/lib/users/profiles': profile });
  const access = evaluate('src/lib/image-studio/access.ts', { '@/lib/access/external-role': external });
  const storage = evaluate('src/lib/image-studio/shared-command-storage.ts', { 'node:crypto': crypto });
  const deletion = evaluate('src/lib/image-studio/workspace-deletion.ts', { '@/lib/prisma': { prisma }, './access': access,
    './shared-command-storage': storage });
  const sharedNames = ['SHARED_STUDIO_PROTOCOL', 'studioBindingKey', 'studioPublisherKey', 'assertStudioActor', 'parseRecord',
    'studioSharedBinding', 'studioPublisherModule', 'readStudioTemplateSourceIdentity'];
  const shared = evaluate('src/lib/image-studio/shared-contract.ts', {}, { prisma,
    canUseCompanyTemplates: access.canUseCompanyTemplates, StudioSharingError: storage.StudioSharingError,
    assertStudioWorkspaceNotDeleted: deletion.assertStudioWorkspaceNotDeleted,
  }, declarations('src/lib/image-studio/shared-contract.ts', sharedNames));
  const lifecycle = evaluate('src/lib/image-studio/preset-lifecycle.ts', { '@/lib/prisma': { prisma } });
  const display = evaluate('src/lib/users/display.ts', {});
  const author = evaluate('src/lib/image-studio/template-author.ts', { 'server-only': {}, '@/lib/prisma': { prisma },
    '@/lib/users/display': display, './access': access, './shared-contract': shared });
  const contextVersion = evaluate('src/lib/image-studio/context-version.ts', { 'node:crypto': { ...crypto, randomInt: () => forbidden('context-version-allocation') },
    '@/lib/prisma': { prisma } });
  let definitionResolution = 'dependency-invalid', definitionCalls = 0, noteReads = 0;
  const definition = evaluate('src/lib/image-studio/definition-read.ts', { 'server-only': {}, 'node:crypto': crypto,
    '@prisma/client': { Prisma: new Proxy({}, { get: () => forbidden('SQL') }) }, '@/lib/prisma': { prisma },
    './context-version': contextVersion, './preset-lifecycle': lifecycle, './template-author': author,
    './fixed-references': { getStudioPresetFixedReferences: async () => { noteReads++; return [{ assetId: 'fixed-source-do-not-project', note: '固定参考说明' }]; } },
    './shared-contract': { ...shared, StudioSharingError: storage.StudioSharingError,
      resolveSharedStudioDefinition: async () => {
        definitionCalls++;
        if (definitionResolution === 'ready') return {};
        if (definitionResolution === 'unknown') throw new Error('Synthetic upstream uncertainty');
        throw new storage.StudioSharingError('Synthetic unavailable generation', 409, definitionResolution);
      } },
  });
  const actor = (id: string, role = 'user', accountType = 'internal'): Row => ({ id, name: `作者-${id}`, username: `fixture-${id}`,
    role, account_type: accountType, status: 'active', expires_at: null, avatar_url: null, feature_profile_id: null,
    feishu_user_id: `u_${id}`, feishu_open_id: `ou_${id}`, feishu_union_id: null, feishu_tenant_key: 'fixture-company' });
  for (const user of [actor('author'), actor('peer'), actor('admin', 'admin'), actor('external', 'admin', 'external')]) users.set(user.id, user);
  const owner = users.get('author')!, peer = users.get('peer')!, admin = users.get('admin')!;
  const preset = { id: 'owned-preset', owner_id: owner.id, scope: 'creator', is_shared: true, name: 'Synthetic template',
    prompt: 'Internal definition prompt', context: 'Internal definition context', updated_at: new Date('2026-10-22T00:00:00.000Z'),
    count: 2, reference_limit: 4, aspect_ratio: '1:1' };
  presets.set(preset.id, preset);
  const rememberContext = (text: string) => {
    const hash = sha(text), code = 'AB12C';
    settings.set(`studio_context_hash_v1:${hash}`, { key: `studio_context_hash_v1:${hash}`, value_json: JSON.stringify({ code }) });
    settings.set(`studio_context_code_v1:${code}`, { key: `studio_context_code_v1:${code}`, value_json: JSON.stringify({ hash }) });
  };
  rememberContext(preset.context);
  assert.equal((await shared.readStudioTemplateSourceIdentity(owner.id, preset.id, prisma)).known, true);
  const self = await author.resolveStudioTemplateAuthor(owner, { presetId: preset.id });
  assert.equal(self.templateRead.author.isSelf, true); assert.equal(self.templateRead.canViewTemplateContext, true);
  const colleague = await author.resolveStudioTemplateAuthor(peer, { presetId: preset.id });
  assert.equal(colleague.templateRead.author.displayName, owner.name); assert.equal(colleague.templateRead.author.isSelf, false);
  assert.equal(colleague.templateRead.canViewTemplateContext, false);
  const administrator = await author.resolveStudioTemplateAuthor(admin, { presetId: preset.id });
  assert.equal(administrator.templateRead.author.isSelf, false); assert.equal(administrator.templateRead.canViewTemplateContext, true);
  assert.equal(access.canManageStudioPreset(owner, preset), true);
  assert.equal(access.canManageStudioPreset(peer, preset), false); assert.equal(access.canManageStudioPreset(admin, preset), false);
  const forged = await author.resolveStudioTemplateAuthor({ ...peer, role: 'admin' }, { presetId: preset.id });
  assert.equal(forged.actor.role, 'user'); assert.equal(forged.templateRead.canViewTemplateContext, false);
  assert.equal(JSON.stringify(colleague.templateRead).includes('ou_author'), false);
  await assert.rejects(author.resolveStudioTemplateAuthor(users.get('external'), { presetId: preset.id }));
  checks.push('author_colleague_admin_and_fresh_identity_never_impersonate_each_other');

  const missing = await author.resolveStudioTemplateAuthor(admin, { presetId: 'missing-preset' });
  assert.equal(missing.templateRead.author.state, 'unknown'); assert.equal(missing.templateRead.author.displayName, null);
  assert.equal(missing.templateRead.author.isSelf, false); assert.equal(missing.templateRead.canViewTemplateContext, false);
  presets.set('missing-owner', { ...preset, id: 'missing-owner', owner_id: 'unconfirmed-owner' });
  const missingOwner = await author.resolveStudioTemplateAuthor(admin, { presetId: 'missing-owner' });
  assert.equal(missingOwner.templateRead.author.state, 'unknown'); assert.equal(missingOwner.templateRead.author.displayName, null);
  assert.equal(missingOwner.templateRead.canViewTemplateContext, false);
  const publisherKey = shared.studioPublisherKey(preset.id);
  settings.set(publisherKey, { key: publisherKey, value_json: JSON.stringify({ protocol: shared.SHARED_STUDIO_PROTOCOL,
    ownerId: peer.id, presetId: preset.id, moduleId: 'peer-module' }) });
  assert.equal((await shared.readStudioTemplateSourceIdentity(owner.id, preset.id, prisma)).known, false);
  const ambiguous = await author.resolveStudioTemplateAuthor(admin, { presetId: preset.id });
  assert.equal(ambiguous.bindingConfirmed, false); assert.equal(ambiguous.templateRead.author.state, 'unknown');
  await assert.rejects(definition.readStudioTemplateDefinition(admin, { presetId: preset.id }));
  await assert.rejects(definition.readStudioTemplateAuthorContact(admin, { presetId: preset.id }));
  settings.delete(publisherKey);
  modules.set('local-module', { id: 'local-module', owner_id: owner.id, source_preset_id: null, revision: 3,
    name: 'Local', prompt: 'Local prompt', context: preset.context, count: 1, reference_limit: 2, aspect_ratio: 'auto' });
  assert.equal((await author.resolveStudioTemplateAuthor(owner, { moduleId: 'local-module' })).templateRead.author.isSelf, true);
  await assert.rejects(author.resolveStudioTemplateAuthor(peer, { moduleId: 'local-module' }));
  await assert.rejects(author.resolveStudioTemplateAuthor(admin, { presetId: preset.id, moduleId: 'local-module' }));
  checks.push('missing_or_conflicting_sources_do_not_guess_authors_or_cross_workspace_owners');

  const beforeRead = JSON.stringify(Array.from(settings)), originalWrites = syntheticWrites;
  await assert.rejects(definition.readStudioTemplateDefinition(peer, { presetId: preset.id }), (error: any) => error.status === 404);
  const ownerRead = await definition.readStudioTemplateDefinition(owner, { presetId: preset.id });
  assert.deepEqual(plain(ownerRead.definition.contextVersion), { code: 'AB12C', state: 'ready' });
  assert.equal(ownerRead.definition.templatePrompt, preset.prompt); assert.equal(ownerRead.generation.available, false);
  assert.equal(ownerRead.generation.reasonCode, 'dependency-invalid'); assert.equal(noteReads, 0);
  const adminRead = await definition.readStudioTemplateDefinition(admin, { presetId: preset.id });
  assert.deepEqual(plain(adminRead.definition.referenceNotes), ['固定参考说明']);
  assert.equal(JSON.stringify(adminRead).includes('fixed-source-do-not-project'), false);
  const forbiddenDefinitionKeys = new Set(['assetId', 'taskId', 'originalUrl', 'original_url', 'referenceIds', 'files', 'recipe', 'generateUrl']);
  const inspectKeys = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) { assert.equal(forbiddenDefinitionKeys.has(key), false, `Private definition key: ${key}`); inspectKeys(child); }
  };
  inspectKeys(adminRead); inspectKeys(ownerRead);
  preset.is_shared = false;
  const callsBeforePrivate = definitionCalls;
  const privateRead = await definition.readStudioTemplateDefinition(admin, { presetId: preset.id });
  assert.equal(privateRead.generation.available, false); assert.equal(privateRead.generation.reasonCode, 'source-withdrawn');
  assert.equal(definitionCalls, callsBeforePrivate, 'Admin reading a private definition must not open generation resolution');
  preset.is_shared = true;
  const archiveKey = lifecycle.archivedPresetKey(preset.id);
  settings.set(archiveKey, { key: archiveKey, value_json: '{}' });
  const archivedRead = await definition.readStudioTemplateDefinition(owner, { presetId: preset.id });
  assert.equal(archivedRead.lifecycle, 'archived'); assert.equal(archivedRead.generation.available, false);
  settings.delete(archiveKey);
  definitionResolution = 'unknown';
  assert.equal((await definition.readStudioTemplateDefinition(owner, { presetId: preset.id })).generation.available, null);
  const localRead = await definition.readStudioTemplateDefinition(owner, { moduleId: 'local-module' });
  assert.equal(localRead.definition.sourceRevision, '3');
  assert.deepEqual(plain(localRead.definition.contextVersion), { code: 'AB12C', state: 'ready' });
  assert.equal(JSON.stringify(Array.from(settings)), beforeRead); assert.equal(syntheticWrites, originalWrites);
  checks.push('definition_read_is_separate_from_generation_and_never_projects_source_media_or_writes');

  const contact = await definition.readStudioTemplateAuthorContact(peer, { presetId: preset.id, href: 'https://attacker.invalid/', openId: 'injected' });
  assert.equal(contact.status, 'available');
  const contactURL = new URL(contact.href);
  assert.equal(contactURL.origin, 'https://applink.feishu.cn'); assert.equal(contactURL.pathname, '/client/chat/open');
  assert.deepEqual(Array.from(contactURL.searchParams.keys()), ['openId']); assert.equal(contactURL.searchParams.get('openId'), owner.feishu_open_id);
  const openId = owner.feishu_open_id;
  owner.feishu_open_id = 'https://attacker.invalid/';
  assert.equal((await definition.readStudioTemplateAuthorContact(peer, { presetId: preset.id })).status, 'unavailable');
  owner.feishu_open_id = openId; owner.feishu_tenant_key = 'other-company';
  assert.equal((await definition.readStudioTemplateAuthorContact(peer, { presetId: preset.id })).reasonCode, 'tenant-mismatch');
  owner.feishu_tenant_key = 'fixture-company'; owner.status = 'disabled';
  assert.equal((await definition.readStudioTemplateAuthorContact(peer, { presetId: preset.id })).reasonCode, 'author-unavailable');
  owner.status = 'active'; preset.is_shared = false;
  await assert.rejects(definition.readStudioTemplateAuthorContact(peer, { presetId: preset.id }));
  preset.is_shared = true;
  assert.equal(assetReads, 0, 'Author/definition/contact reads cannot open original image assets');
  checks.push('author_contact_uses_only_fresh_server_identity_fixed_feishu_route_and_tenant');

  // The rest exercises the real cover service with memory CAS and a strictly
  // synthetic filesystem. Render transport intentionally fails before sharp.
  const files = new Map<string, { bytes: Buffer; ino: number; mtimeMs: number }>();
  const putFile = (file: string, text: string) => files.set(file, { bytes: Buffer.from(text), ino: files.size + 1, mtimeMs: 1000 });
  const permittedDirectories = new Set([path.join(fakeRoot, 'public/uploads'), path.join(fakeRoot, 'storage'), path.join(fakeRoot, 'storage/module-covers')]);
  const syntheticFs = new Proxy({
    realpath: async (file: string) => { if (!permittedDirectories.has(file) && !files.has(file)) return forbidden('filesystem-realpath'); return file; },
    stat: async (file: string) => {
      const value = files.get(file); if (!value) return forbidden('filesystem-stat');
      return { isFile: () => true, dev: 71, ino: value.ino, size: value.bytes.length, mtimeMs: value.mtimeMs, ctimeMs: value.mtimeMs };
    },
    readFile: async (file: string) => { const value = files.get(file); if (!value) return forbidden('filesystem-read'); return Buffer.from(value.bytes); },
  }, { get: (target, property) => Object.hasOwn(target, property) ? Reflect.get(target, property) : () => forbidden(`filesystem:${String(property)}`) });
  const pricing = evaluate('src/lib/image-studio/pricing-state.ts', {});
  const mismatch = evaluate('src/lib/image-studio/dimension-mismatch.ts', { './pricing-state': pricing });
  const coverTypes = evaluate('src/lib/image-studio/module-cover-types.ts', {});
  const siteURL = evaluate('src/lib/assets/site-url.ts', {});
  const renderAttempts: string[] = [], protectedURLs = new Set<string>();
  const cover = evaluate('src/lib/image-studio/module-cover.ts', { 'node:fs/promises': { __esModule: true, default: syntheticFs }, 'node:path': path,
    'node:crypto': crypto, sharp: () => forbidden('image-encoder'), '@/lib/prisma': { prisma }, '@/lib/assets/site-url': siteURL,
    './access': access, './shared-contract': shared, './shared-command-storage': storage, './preset-lifecycle': lifecycle,
    './workspace-deletion': deletion, './protected-assets': { studioHiddenAssetUrls: async (viewer: Row) => {
      assert.equal(viewer.id, 'module-cover-audience'); return Array.from(protectedURLs);
    } },
    './media': { readStudioImage: async (url: string) => { renderAttempts.push(url); throw new Error('synthetic_render_unavailable'); },
      studioTemplateAssetUrl: (id: string) => `/synthetic-preview/${id}` },
    './dimension-mismatch': mismatch, './module-cover-types': coverTypes,
  }, {}, source('src/lib/image-studio/module-cover.ts') + '\nexport const engineering = { hash, prepareKey, preparationFingerprint, parseRecipe };');
  const native = (id: string): Row => ({ id, owner_id: owner.id, type: 'image', status: 'active', original_url: `/uploads/${id}.png`,
    hash: sha(id), file_size: 16, width: 16, height: 16, mime_type: 'image/png' });
  for (const id of ['original-a', 'later-b']) { const row = native(id); assets.set(id, row); putFile(path.join(fakeRoot, 'public', row.original_url), `synthetic-original-${id}`); }
  const workspace = (id: string, revision = 1): Row => ({ id, owner_id: owner.id, revision, source_preset_id: null, banner_asset_id: null });
  const resultTask = (id: string, moduleId: string, assetId: string, when = 1): Row => ({ id, module_id: moduleId, owner_id: owner.id,
    asset_id: assetId, status: 'succeeded', usage_json: null, deleted_at: null, finished_at: new Date(when) });
  const fp = sha('outer-operation-original'), requestId = 'snapshot-original-request';
  allowWrites = true;
  modules.set('none-module', workspace('none-module', 4));
  const none = await cover.prepareModuleCoverSnapshot(owner, 'none-module', requestId, 'module-source:none-module', fp);
  assert.equal(none.disposition, 'none'); assert.equal(none.recipe, null);
  const noneKey = cover.engineering.prepareKey(owner.id, 'none-module', requestId), queriesAfterNone = latestQueries;
  tasks.set('later-none', resultTask('later-none', 'none-module', 'later-b', 2));
  modules.get('none-module')!.revision = 5;
  const expiredNone = { ...none, expiresAt: Date.now() - 1 };
  settings.set(noneKey, { key: noneKey, value_json: JSON.stringify(expiredNone) });
  const resumedNone = await cover.prepareModuleCoverSnapshot(owner, 'none-module', requestId, 'module-source:none-module', fp);
  assert.equal(resumedNone.disposition, 'none'); assert.equal(resumedNone.moduleRevision, 4);
  assert.equal(resumedNone.fingerprint, none.fingerprint); assert.equal(latestQueries, queriesAfterNone);
  assert.notEqual(resumedNone.lease, none.lease);
  const pendingNone = { ...resumedNone, status: 'pending', expiresAt: Date.now() + 30000 };
  settings.set(noneKey, { key: noneKey, value_json: JSON.stringify(pendingNone) });
  await assert.rejects(cover.prepareModuleCoverSnapshot(owner, 'none-module', requestId, 'module-source:none-module', fp));
  assert.equal(settings.get(noneKey)!.value_json, JSON.stringify(pendingNone));
  const failedNone = { ...resumedNone, status: 'failed', expiresAt: Date.now() - 1 };
  settings.set(noneKey, { key: noneKey, value_json: JSON.stringify(failedNone) }); rejectCasKey = noneKey;
  await assert.rejects(cover.prepareModuleCoverSnapshot(owner, 'none-module', requestId, 'module-source:none-module', fp));
  assert.equal(settings.get(noneKey)!.value_json, JSON.stringify(failedNone));
  checks.push('prepare_none_stays_frozen_after_new_private_result_and_cas_loser_does_not_overwrite');

  modules.set('fixed-module', workspace('fixed-module'));
  const fixedTarget = { kind: 'module', id: 'fixed-module' };
  const oldRecipe = { version: 2, layout: 'single', output: { width: 1280, height: 1280 },
    sources: [{ assetId: 'original-a', version: 'a'.repeat(64), crop: { x: 0, y: 0, width: 100, height: 100 } }] };
  const fixedRecord = { version: 1, ownerId: owner.id, target: fixedTarget, revision: 1, requestId: 'old-fixed-save', recipe: oldRecipe,
    updatedAt: new Date().toISOString(), files: { thumbnail: `${'f'.repeat(64)}-640.webp`, image: `${'f'.repeat(64)}-1280.webp` } };
  const fixedKey = cover.moduleCoverKey(fixedTarget), fixedRaw = JSON.stringify(fixedRecord);
  settings.set(fixedKey, { key: fixedKey, value_json: fixedRaw });
  const beforeFixedQueries = latestQueries, beforeFixedAssets = assetReads;
  const existing = await cover.prepareModuleCoverSnapshot(owner, 'fixed-module', requestId, 'module-source:fixed-module', fp);
  assert.equal(existing.disposition, 'existing'); assert.equal(existing.recipe, null);
  assert.equal(latestQueries, beforeFixedQueries); assert.equal(assetReads, beforeFixedAssets);
  assert.equal(settings.get(fixedKey)!.value_json, fixedRaw);
  const existingKey = cover.engineering.prepareKey(owner.id, 'fixed-module', requestId);
  settings.set(existingKey, { key: existingKey, value_json: JSON.stringify({ ...existing, status: 'failed', expiresAt: Date.now() - 1 }) });
  tasks.set('fixed-later', resultTask('fixed-later', 'fixed-module', 'later-b', 3));
  const resumedExisting = await cover.prepareModuleCoverSnapshot(owner, 'fixed-module', requestId, 'module-source:fixed-module', fp);
  assert.equal(resumedExisting.disposition, 'existing'); assert.equal(resumedExisting.fingerprint, existing.fingerprint);
  assert.equal(resumedExisting.moduleCoverHash, existing.moduleCoverHash); assert.equal(latestQueries, beforeFixedQueries);
  await assert.rejects(cover.prepareModuleCoverSnapshot(owner, 'fixed-module', requestId, 'other-preset', fp));
  await assert.rejects(cover.prepareModuleCoverSnapshot(owner, 'fixed-module', requestId, 'module-source:fixed-module', sha('other-operation')));
  assert.equal(settings.get(fixedKey)!.value_json, fixedRaw);
  checks.push('prepare_existing_preserves_old_recipe_and_binds_original_request_target_and_operation');

  modules.set('image-module', workspace('image-module', 7));
  tasks.set('image-original', resultTask('image-original', 'image-module', 'original-a'));
  const imageTarget = 'module-source:image-module', imageKey = cover.engineering.prepareKey(owner.id, 'image-module', requestId);
  await assert.rejects(cover.prepareModuleCoverSnapshot(owner, 'image-module', requestId, imageTarget, fp), /synthetic_render_unavailable/);
  const firstImage = JSON.parse(settings.get(imageKey)!.value_json);
  assert.equal(firstImage.status, 'failed'); assert.equal(firstImage.recipe.sources[0].assetId, 'original-a');
  assert.equal(firstImage.taskId, 'image-original');
  const originalQueries = latestQueries;
  tasks.set('image-later', resultTask('image-later', 'image-module', 'later-b', 2));
  await assert.rejects(cover.prepareModuleCoverSnapshot(owner, 'image-module', requestId, imageTarget, fp), /synthetic_render_unavailable/);
  const retriedImage = JSON.parse(settings.get(imageKey)!.value_json);
  assert.equal(retriedImage.fingerprint, firstImage.fingerprint); assert.equal(retriedImage.recipe.sources[0].assetId, 'original-a');
  assert.notEqual(retriedImage.lease, firstImage.lease); assert.equal(latestQueries, originalQueries);
  assert.deepEqual(renderAttempts, ['/uploads/original-a.png', '/uploads/original-a.png']);
  const rawBeforeWrongRequest = settings.get(imageKey)!.value_json;
  await assert.rejects(cover.prepareModuleCoverSnapshot(owner, 'image-module', requestId, imageTarget, sha('changed-outer-input')));
  assert.equal(settings.get(imageKey)!.value_json, rawBeforeWrongRequest);
  checks.push('failed_source_preparation_keeps_original_source_task_revision_without_new_latest');

  modules.set('protected-module', workspace('protected-module'));
  tasks.set('protected-task', resultTask('protected-task', 'protected-module', 'original-a'));
  protectedURLs.add('/uploads/original-a.png');
  const protectedChoice = await cover.prepareModuleCoverSnapshot(owner, 'protected-module', requestId, 'module-source:protected-module', fp);
  assert.equal(protectedChoice.disposition, 'none'); assert.equal(protectedChoice.recipe, null);
  protectedURLs.clear();
  assert.equal(renderAttempts.length, 2, 'Protected sources cannot reach render transport');
  checks.push('protected_output_is_not_published_or_replaced_by_input_fallback');

  // Simulate the already-finished private-file boundary. The real parser,
  // immutable-file hash verification, commit binding and public DTO still run.
  const imageBytes = Buffer.from('synthetic-contained-file'), thumbnailBytes = Buffer.from('synthetic-contained-thumbnail');
  const fileName = cover.engineering.hash([sha(imageBytes), sha(thumbnailBytes)]);
  const readyFiles = { thumbnail: `${fileName}-640.webp`, image: `${fileName}-1280.webp` };
  putFile(path.join(fakeRoot, 'storage/module-covers', readyFiles.image), imageBytes.toString());
  putFile(path.join(fakeRoot, 'storage/module-covers', readyFiles.thumbnail), thumbnailBytes.toString());
  settings.set(imageKey, { key: imageKey, value_json: JSON.stringify({ ...retriedImage, files: readyFiles, expiresAt: Date.now() - 1 }) });
  const prepared = await cover.prepareModuleCoverSnapshot(owner, 'image-module', requestId, imageTarget, fp);
  assert.equal(prepared.status, 'ready'); assert.equal(prepared.recipe.sources[0].assetId, 'original-a');
  assert.equal(latestQueries, originalQueries + 1, 'Only the separate protected-source case may have selected another candidate');
  const transition = { moduleId: 'image-module', targetPresetId: imageTarget, sourceModuleId: 'image-module',
    sourceBeforeRevision: 7, beforeRevision: 7, afterRevision: 8, operationFingerprint: fp };
  const imagePreset = { ...preset, id: imageTarget, is_shared: true };
  presets.set(imageTarget, imagePreset);
  modules.set('image-module', { ...modules.get('image-module'), revision: 8, source_preset_id: imageTarget });
  const bindingKey = shared.studioBindingKey('image-module'), imagePublisherKey = shared.studioPublisherKey(imageTarget);
  settings.set(bindingKey, { key: bindingKey, value_json: JSON.stringify({ protocol: shared.SHARED_STUDIO_PROTOCOL,
    ownerId: owner.id, presetId: imageTarget, mode: 'publisher' }) });
  settings.set(imagePublisherKey, { key: imagePublisherKey, value_json: JSON.stringify({ protocol: shared.SHARED_STUDIO_PROTOCOL,
    ownerId: owner.id, presetId: imageTarget, moduleId: 'image-module' }) });
  const beforeRejectedCommits = JSON.stringify(Array.from(settings));
  await assert.rejects(cover.commitPreparedModuleCoverSnapshot(owner, prepared, prisma, { ...transition, afterRevision: 9 }));
  await assert.rejects(cover.commitPreparedModuleCoverSnapshot(owner, prepared, prisma, { ...transition, targetPresetId: preset.id }));
  await assert.rejects(cover.commitPreparedModuleCoverSnapshot(admin, prepared, prisma, transition));
  await assert.rejects(cover.commitPreparedModuleCoverSnapshot(owner, prepared, prisma, { ...transition, operationFingerprint: sha('foreign-operation') }));
  const originalFile = files.get(path.join(fakeRoot, 'public/uploads/original-a.png'))!;
  originalFile.mtimeMs++;
  await assert.rejects(cover.commitPreparedModuleCoverSnapshot(owner, prepared, prisma, transition));
  originalFile.mtimeMs--;
  assert.equal(JSON.stringify(Array.from(settings)), beforeRejectedCommits);
  rejectCasKey = imageKey;
  await assert.rejects(prisma.$transaction((tx: Exports) => cover.commitPreparedModuleCoverSnapshot(owner, prepared, tx, transition)));
  assert.equal(JSON.stringify(Array.from(settings)), beforeRejectedCommits, 'A failed final preparation CAS cannot leave cover/history ahead of its receipt');
  await prisma.$transaction((tx: Exports) => cover.commitPreparedModuleCoverSnapshot(owner, prepared, tx, transition));
  const currentKey = cover.moduleCoverKey({ kind: 'preset', id: imageTarget });
  const committed = JSON.parse(settings.get(currentKey)!.value_json);
  assert.equal(committed.ownerId, owner.id); assert.equal(committed.recipe.version, 3); assert.equal(committed.recipe.fit, 'contain');
  assert.equal(committed.recipe.sources[0].assetId, 'original-a'); assert.equal(committed.requestId, requestId);
  assert.equal(JSON.parse(settings.get(imageKey)!.value_json).status, 'committed');
  assert.equal(Array.from(settings.keys()).filter(key => key.startsWith('studio_module_cover_history_v1:')).length, 1);
  const publicCover = await cover.studioFixedCoverDTO(peer, { kind: 'preset', id: imageTarget }, prisma);
  assert.equal(publicCover.available, true); assert.equal(publicCover.thumbnailUrl.includes('/module-covers/preset/'), true);
  assert.equal((await cover.studioFixedCoverDTO(owner, { kind: 'preset', id: imageTarget }, prisma)).imageUrl, publicCover.imageUrl);
  assert.equal((await cover.studioFixedCoverDTO(admin, { kind: 'preset', id: imageTarget }, prisma)).imageUrl, publicCover.imageUrl);
  assert.equal(JSON.stringify(publicCover).includes('original-a'), false); assert.equal(JSON.stringify(publicCover).includes('image-original'), false);
  assert.equal(JSON.stringify(publicCover).includes(fileName), false);
  assert.deepEqual(Object.keys(publicCover).sort(), ['available', 'height', 'imageUrl', 'revision', 'target', 'thumbnailUrl', 'updatedAt', 'width'].sort());
  const status = await cover.readModuleCoverSnapshotRequest(owner, 'image-module', requestId);
  assert.equal(status.status, 'committed'); assert.deepEqual(Object.keys(status).sort(), ['intent', 'requestId', 'status']);
  await assert.rejects(cover.readModuleCoverSnapshotRequest(peer, 'image-module', requestId));
  const afterCommit = JSON.stringify(Array.from(settings));
  await assert.rejects(cover.commitPreparedModuleCoverSnapshot(owner, prepared, prisma, transition));
  assert.equal(JSON.stringify(Array.from(settings)), afterCommit);
  imagePreset.is_shared = false;
  const revoked = await cover.studioFixedCoverDTO(peer, { kind: 'preset', id: imageTarget }, prisma);
  assert.equal(revoked.available, false); assert.equal(revoked.thumbnailUrl, null); assert.equal(revoked.imageUrl, null);
  imagePreset.is_shared = true;
  checks.push('cover_commit_requires_exact_owner_target_operation_source_and_before_after_revision');
  checks.push('fixed_cover_public_dto_and_original_status_hide_source_and_recheck_revocation');

  assert.equal(forbiddenCalls, 0); assert.ok(syntheticWrites > 0); assert.equal(checks.length, 10); assert.equal(new Set(checks).size, checks.length);
  for (const file of Array.from(evaluatedSources)) assert.ok(Object.hasOwn(sourceSha256, file), `Unbound evaluated source: ${file}`);
  for (const [file, digest] of Object.entries(sourceSha256)) assert.equal(sha(readFileSync(path.join(root, file))), digest, `${file} changed during the gate`);
  const receipt = { schema: 'template-author-cover-contract-engineering.v1', synthetic: true, completed: true,
    runId, startedAt, finishedAt: Date.now(), fixtureSha256: sourceSha256[fixtureFile], sourceSha256,
    checks, total: checks.length, passed: checks.length, applicationDatabaseOpened: false,
    forbiddenCalls, productionWrites: 0, paidRequests: 0, browserRuns: 0, syntheticWrites,
    evaluatedSources: Array.from(evaluatedSources).sort(), extractedHelpers: { 'src/lib/image-studio/shared-contract.ts': sharedNames },
    boundaryDoubles: ['memory Prisma rows/CAS', 'synthetic filesystem and failed render transport', 'generation dependency readiness', 'fixed-reference notes'],
    scope: 'Offline real-helper contracts only; no database engine durability, image encoding/quality, browser or functional acceptance' };
  writeFileSync(destination, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
  console.log('TEMPLATE_AUTHOR_COVER_CONTRACT_ENGINEERING_RECEIPT=' + destination);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
