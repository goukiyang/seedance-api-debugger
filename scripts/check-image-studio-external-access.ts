import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import vm from 'node:vm';
import { mock } from 'node:test';
import ts from 'typescript';

/** Real isolated SQLite and product policy/resolver/routes. Never invokes a supplier. */
async function main() {
  const root = fs.realpathSync(process.cwd()), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-external-'));
  const schemaPath = path.join(scratch, 'schema.prisma'), databasePath = path.join(scratch, 'fixture.db');
  fs.copyFileSync(path.join(root, 'prisma/schema.prisma'), schemaPath);
  process.env.DATABASE_URL = `file:${databasePath}`;
  Object.assign(process.env, { NODE_ENV: 'test', PRIVATE_PROMPTS_MIN_STATE: 'legacy-read', SITE_PUBLIC_BASE_URL: 'https://fixture.invalid' });
  delete process.env.PRIVATE_PROMPTS_POLICY_FILE;
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  const require = createRequire(import.meta.url);
  const env: NodeJS.ProcessEnv = { DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: 'test', PRISMA_GENERATE_SKIP_AUTOINSTALL: '1',
    CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key];
  execFileSync(process.execPath, [path.join(path.dirname(require.resolve('prisma/package.json')), 'build/index.js'), 'db', 'push', '--skip-generate', '--schema', schemaPath],
    { cwd: scratch, env, encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const db = new PrismaClient();
  Reflect.set(globalThis, 'prisma', db);
  const NodeModule = require('node:module') as { _load: (id: string, ...args: unknown[]) => unknown };
  const originalLoad = NodeModule._load;
  NodeModule._load = function (id: string, ...args: unknown[]) { return id === 'server-only' ? {} : originalLoad.call(this, id, ...args); };
  let networkCalls = 0;
  const noNetwork = () => { networkCalls++; throw new Error('Supplier/network calls are prohibited in this isolated check'); };
  mock.method(globalThis, 'fetch', noNetwork); mock.method(http, 'get', noNetwork); mock.method(http, 'request', noNetwork);
  mock.method(https, 'get', noNetwork); mock.method(https, 'request', noNetwork);
  const checks: string[] = [], check = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
  try {
    const access = require(path.join(root, 'src/lib/image-studio/access.ts')) as typeof import('@/lib/image-studio/access');
    const policy = require(path.join(root, 'src/lib/image-studio/external-access.server.ts')) as typeof import('@/lib/image-studio/external-access.server');
    const shared = require(path.join(root, 'src/lib/image-studio/shared-contract.ts')) as typeof import('@/lib/image-studio/shared-contract');
    const sourceOwner = 'fixture-internal-admin', externalId = 'fixture-external', otherId = 'fixture-other-external';
    for (const [id, account_type, role] of [[sourceOwner, 'internal', 'admin'], [externalId, 'external', 'user'], [otherId, 'external', 'admin']]) {
      await db.user.create({ data: { id, name: id, username: id, email: `${id}@fixture.invalid`, password_hash: 'synthetic-no-login', account_type, role } });
    }
    const admin = await db.user.findUniqueOrThrow({ where: { id: sourceOwner } });
    const external = await db.user.findUniqueOrThrow({ where: { id: externalId } });
    const other = await db.user.findUniqueOrThrow({ where: { id: otherId } });
    assert.equal(access.canUseCompanyTemplates(external), false);
    assert.equal(access.canUseCompanyTemplates(other), false, 'An external admin is not a company identity');
    assert.equal(access.canAccessImageTemplates(external), true, 'Closed readers retain their entry');
    assert.equal((await policy.readExternalStudioAccessPolicy()).mode, 'closed');
    assert.deepEqual(access.externalStudioPresetIds(await policy.hydrateExternalStudioActor(external)), []);
    await assert.rejects(() => policy.getExternalStudioAccessAdmin(other), /无权/);
    check('company_boundary_default_closed_and_admin_authorization');

    const secretPrompt = 'INTERNAL_SOURCE_PROMPT_DO_NOT_EXPORT', secretContext = 'INTERNAL_SOURCE_CONTEXT_DO_NOT_EXPORT';
    const source = await db.imageStudioPreset.create({ data: { id: 'fixture-approved-template', owner_id: sourceOwner, scope: 'creator', is_shared: true,
      name: 'Synthetic safe template', prompt: secretPrompt, context: secretContext, model: 'gemini-nano-banana-2.1', count: 1,
      quality: 'medium', resolution: '2K', reference_limit: 1, reference_ids: '[]', aspect_ratio: '1:1' } });
    const hidden = await db.imageStudioPreset.create({ data: { id: 'fixture-internal-shared', owner_id: sourceOwner, scope: 'creator', is_shared: true,
      name: 'Internal only', prompt: 'internal', model: 'gemini-nano-banana-2.1' } });
    const binding = (await policy.externalStudioTemplateBinding(source.id))!;
    // A cold first binding must work. Only diagnose a fail-closed null; never prewarm eligibility.
    if (!binding) await shared.assertExternalStudioTemplateDependencies(source, db);
    assert.ok(binding);
    const invalidSource = await db.imageStudioPreset.create({ data: { id: 'fixture-invalid-specification', owner_id: sourceOwner,
      scope: 'creator', is_shared: true, name: 'Invalid specification', model: source.model, resolution: '2k' } });
    assert.equal(await policy.externalStudioTemplateBinding(invalidSource.id), null, 'A source with invalid actual specifications is not eligible');
    const requestId = randomUUID(), input = { requestId, revision: 0, mode: 'pilot', userIds: [externalId], templates: [binding] };
    const saved = await policy.saveExternalStudioAccess(admin, input);
    assert.equal(saved.operation.state, 'succeeded');
    assert.equal(saved.operation.policy?.revision, 1);
    assert.deepEqual(await policy.saveExternalStudioAccess(admin, input), saved);
    assert.deepEqual((await policy.getExternalStudioAccessOperation(admin, requestId)).operation, saved.operation);
    await assert.rejects(() => policy.saveExternalStudioAccess(admin, { ...input, mode: 'closed' }), /不同内容/);
    const stale = await policy.saveExternalStudioAccess(admin, { ...input, requestId: randomUUID() });
    assert.equal(stale.operation.state, 'rejected');
    const actor = await shared.assertStudioActor(externalId, db);
    assert.equal(access.canViewStudioPreset(actor, source), true);
    assert.equal(access.canViewStudioPreset(actor, hidden), false);
    assert.equal(access.canManageStudioPreset(actor, source), false);
    assert.deepEqual(access.externalStudioPresetIds(await policy.hydrateExternalStudioActor(other)), []);
    check('pilot_grants_revision_binding_cas_receipts_and_source_isolation');

    const resolved = await shared.resolveSharedStudioDefinition(actor, source.id, db);
    assert.equal(resolved.definition.templatePrompt, secretPrompt);
    const publicText = JSON.stringify(resolved.publicDTO);
    assert.ok(!publicText.includes(secretPrompt) && !publicText.includes(secretContext));
    assert.equal(resolved.publicDTO.contextEditable, false);
    assert.equal(resolved.publicDTO.canReadPrivatePrompt, false);
    assert.deepEqual(resolved.publicDTO.templateReferenceIds, []);
    assert.deepEqual(resolved.publicDTO.styleGroupIds, []);
    await assert.rejects(() => shared.resolveSharedStudioDefinition(actor, hidden.id, db), /无权/);
    const opened = await shared.openSharedStudioModule(actor, source.id, randomUUID(), db, { explicitSelection: true });
    assert.equal(opened.owner_id, externalId);
    assert.equal(opened.source_preset_id, source.id);
    const gallery = require(path.join(root, 'src/lib/image-studio/gallery.ts')) as typeof import('@/lib/image-studio/gallery');
    const catalog = await gallery.readGalleryCatalog(actor, db);
    assert.ok(catalog.entries.some(item => item.presetId === source.id));
    assert.ok(!catalog.entries.some(item => item.presetId === hidden.id));
    assert.ok(!catalog.entries.some(item => item.id === `default-${externalId}`));
    check('real_definition_executes_server_source_and_external_dto_is_private');

    await db.asset.create({ data: { id: 'fixture-source-image', owner_id: sourceOwner, type: 'image', status: 'active',
      original_url: 'https://fixture.invalid/uploads/assets/internal-source.png', thumbnail_url: '/uploads/thumbs/internal-source.png',
      file_name: 'Internal source', mime_type: 'image/png', file_size: 100, width: 32, height: 32 } });
    await db.asset.create({ data: { id: 'fixture-owned-image', owner_id: externalId, type: 'image', status: 'active',
      original_url: '/uploads/assets/external-owned.png', file_name: 'Own result', mime_type: 'image/png', file_size: 100, width: 32, height: 32 } });
    await db.platformSetting.create({ data: { key: `studio_fixed_references_v1:preset:${source.id}`,
      value_json: JSON.stringify({ ownerId: sourceOwner, references: [{ assetId: 'fixture-source-image', note: 'INTERNAL_NOTE_DO_NOT_EXPORT' }] }) } });
    assert.deepEqual(access.externalStudioPresetIds(await policy.hydrateExternalStudioActor(external)), [], 'Dependency edits revoke the old binding');
    const currentBinding = (await policy.externalStudioTemplateBinding(source.id))!;
    const reapproved = await policy.saveExternalStudioAccess(admin, { ...input, requestId: randomUUID(), revision: 1, templates: [currentBinding] });
    assert.equal(reapproved.operation.state, 'succeeded');
    const withFixed = await shared.resolveSharedStudioDefinition(await shared.assertStudioActor(externalId, db), source.id, db);
    assert.equal(withFixed.definition.fixedReferences.length, 1);
    assert.ok(!JSON.stringify(withFixed.publicDTO).includes('internal-source.png'));
    assert.ok(!JSON.stringify(withFixed.publicDTO).includes('INTERNAL_NOTE_DO_NOT_EXPORT'));
    check('dependency_change_requires_reapproval_and_fixed_source_stays_server_only');

    let activeUser: typeof external | null = external;
    const { NextRequest } = require('next/server') as typeof import('next/server');
    const file = path.join(root, 'src/app/api/image-studio/upload-access/route.ts');
    const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const module = { exports: {} };
    const routeRequire = (id: string) => id === '@/lib/auth/session' ? { getSession: async () => activeUser }
      : require(id.startsWith('@/') ? path.join(root, 'src', id.slice(2)) : id.startsWith('.') ? path.resolve(path.dirname(file), id) : id);
    vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${compiled}\n})`, { filename: file })(routeRequire, module, module.exports, file, path.dirname(file));
    const upload = module.exports as { GET: (request: InstanceType<typeof NextRequest>) => Promise<Response> };
    const readPath = (pathname: string) => upload.GET(new NextRequest(`https://fixture.invalid/api/image-studio/upload-access?path=${encodeURIComponent(pathname)}`,
      { headers: { 'x-image-studio-upload-access-check': '1' } }));
    assert.equal((await readPath('/uploads/assets/external-owned.png')).status, 204);
    assert.equal((await readPath('/uploads/assets/internal-source.png')).status, 404);
    assert.equal((await readPath('/uploads/assets/unknown.png')).status, 404);
    activeUser = null;
    assert.equal((await readPath('/uploads/assets/external-owned.png')).status, 404);
    activeUser = other;
    assert.equal((await readPath('/uploads/assets/external-owned.png')).status, 404);
    const home = require(path.join(root, 'src/lib/content-reactions/home-templates.ts')) as typeof import('@/lib/content-reactions/home-templates');
    assert.equal(await home.homeTemplateCover(external as never, `image_template:${source.id}`, 'fixture-source-image'), null);
    check('actual_raw_media_route_allows_owner_and_denies_source_alias_other_and_anonymous');

    await db.imageStudioPreset.update({ where: { id: source.id }, data: { context: `${secretContext}_CHANGED` } });
    assert.deepEqual(access.externalStudioPresetIds(await policy.hydrateExternalStudioActor(external)), [], 'A changed source must be reapproved');
    const close = await policy.saveExternalStudioAccess(admin, { requestId: randomUUID(), revision: 2, mode: 'closed', userIds: [externalId], templates: [currentBinding] });
    assert.equal(close.operation.state, 'succeeded');
    assert.deepEqual(access.externalStudioPresetIds(await shared.assertStudioActor(externalId, db)), []);
    activeUser = external;
    assert.equal((await readPath('/uploads/assets/external-owned.png')).status, 204);
    assert.equal((await db.imageStudioModule.findUniqueOrThrow({ where: { id: opened.id } })).owner_id, externalId);
    const modules = require(path.join(root, 'src/lib/image-studio/modules.ts')) as typeof import('@/lib/image-studio/modules');
    const historicalModule = await modules.studioModuleDTOForUser(external, opened.id);
    assert.equal(historicalModule.name, '本人历史');
    assert.equal(historicalModule.reproduceFromTaskId, null);
    assert.ok(!JSON.stringify(historicalModule).includes(secretPrompt));
    await db.user.update({ where: { id: externalId }, data: { status: 'disabled' } });
    await assert.rejects(() => shared.assertStudioActor(externalId, db), /权限/);
    assert.equal(networkCalls, 0);
    check('closed_keeps_owned_history_and_media_disabled_identity_rejected_no_network');
    console.log(JSON.stringify({ synthetic: true, checks: checks.length, supplierCalls: networkCalls, database: 'temporary-isolated' }));
  } finally {
    mock.restoreAll(); NodeModule._load = originalLoad; await db.$disconnect(); Reflect.deleteProperty(globalThis, 'prisma');
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
