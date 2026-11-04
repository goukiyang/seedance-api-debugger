import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mock } from 'node:test';
import type { Prisma } from '@prisma/client';
import type { SessionUser } from '../src/lib/auth/session';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const batchId = (owner: string, planId: string) => sha(`${owner}:${planId}`);

async function main() {
  const root = realpathSync(process.cwd());
  const previousUmask = process.umask(0o077);
  const sourcePaths = ['src/lib/image-studio/tasks.ts', 'src/lib/image-studio/billing-quote-service.ts',
    'src/lib/character-lab/service.ts'];
  const sourceHashes = Object.fromEntries(sourcePaths.map(file => [file, sha(readFileSync(path.join(root, file)))]));
  const scratch = path.join(root, '.role-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'character-lab-submission-'));
  const databasePath = path.join(directory, 'synthetic.db');
  process.env.DATABASE_URL = `file:${databasePath}`;
  Reflect.set(process.env, 'NODE_ENV', 'test');
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);

  const require = createRequire(import.meta.url);
  const prismaPackage = require.resolve('prisma/package.json');
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL,
    PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', NEXT_TELEMETRY_DISABLED: '1' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[name]) env[name] = process.env[name];
  execFileSync(process.execPath, [path.join(path.dirname(prismaPackage), 'build/index.js'), 'db', 'push', '--skip-generate',
    '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(statSync(databasePath).mode & 0o777, 0o600);

  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  Reflect.set(globalThis, 'prisma', db);
  Reflect.set(globalThis, 'prismaSqlitePragmasStarted', true);
  process.chdir(directory);
  let forbiddenCalls = 0;
  const blocked = () => { forbiddenCalls++; throw new Error('Character Lab engineering fixture forbids network access'); };
  mock.method(globalThis, 'fetch', blocked);
  mock.method(http, 'request', blocked); mock.method(http, 'get', blocked);
  mock.method(https, 'request', blocked); mock.method(https, 'get', blocked); mock.method(dns, 'lookup', blocked);
  const marker = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js');
  const resolver = require('node:module') as { _resolveFilename: (...args: unknown[]) => string };
  const originalResolve = resolver._resolveFilename;
  mock.method(resolver, '_resolveFilename', (...args: unknown[]) => args[0] === 'server-only'
    ? marker : originalResolve.apply(resolver, args));

  const owner = 'character-lab-submission-owner';
  const defaultModuleId = `default-${owner}`;
  const globalContext = 'GLOBAL_CONTEXT_MUST_NOT_LEAK';
  const moduleContext = 'DEFAULT_MODULE_CONTEXT_MUST_NOT_LEAK';
  const fixedNote = 'FIXED_REFERENCE_MUST_NOT_LEAK';
  const styleNote = 'STYLE_REFERENCE_MUST_NOT_LEAK';
  const skillPrompt = 'SKILL_PROMPT_MUST_NOT_LEAK';
  const sourceAssetId = 'lab-source-asset';
  const fixedAssetId = 'default-fixed-asset';
  const styleAssetId = 'default-style-asset';
  const styleId = randomUUID();
  const skillId = randomUUID();
  const settingsRevision = 7;
  const user: SessionUser = { id: owner, name: 'Character Lab fixture', username: owner,
    email: `${owner}@fixture.invalid`, role: 'admin', account_type: 'internal', user_profile: 'other',
    feature_profile_id: null, status: 'active', expires_at: null };
  const plan = (id: string, prompt = `LAB_PROMPT_${id}`) => ({
    id, workspaceId: randomUUID(), kind: 'faces', createdAt: new Date().toISOString(), sourceAssetId,
    count: 4, diversity: 75, context: '', mainFace: null, auxiliaryFaces: [], auxiliaryFeatures: '',
    adjustment: '', adjustmentCell: null, previousResultPlanId: null, configRevision: 1, prompt,
    model: 'gpt-image-2', channelId: 'original', quality: 'medium', resolution: '2K', aspectRatio: '1:1',
    settingsRevision, referenceIds: [sourceAssetId], projectId: null, inputFingerprint: sha(`input:${id}`),
  });
  const planKey = (id: string) => `character-lab:v1:${owner}:plan:${id}`;
  const receiptKey = (id: string) => `character-lab:v1:${owner}:receipt:${id}`;
  const quoteKey = (id: string) => `character-lab:v1:${owner}:quote:${id}`;
  const submission = (record: ReturnType<typeof plan>) => ({ requestId: record.id, projectId: record.projectId,
    prompt: record.prompt, count: 1, revision: record.settingsRevision, referenceIds: record.referenceIds,
    model: record.model, channelId: record.channelId, quality: record.quality, resolution: record.resolution,
    aspectRatio: record.aspectRatio, draft: { referencePolicy: { primaryIds: record.referenceIds,
      primaryMin: 0, primaryMax: 10, auxiliaryMax: 10, styleMax: 10, referenceMax: 10,
      useFixedReferences: true } } });
  const createPlan = async (record: ReturnType<typeof plan>, receipt: 'prepared' | 'submitting' | 'accepted' = 'prepared') => {
    await db.platformSetting.createMany({ data: [
      { key: planKey(record.id), value_json: JSON.stringify(record), updated_by: owner },
      { key: receiptKey(record.id), value_json: JSON.stringify({ state: receipt }), updated_by: owner },
    ] });
  };
  const capture = () => {
    const prepared: Prisma.ImageStudioTaskUncheckedCreateInput[] = [];
    return { prepared, hook: { save: async (_tx: Prisma.TransactionClient, data: Prisma.ImageStudioTaskUncheckedCreateInput) => { prepared.push(data); } } };
  };

  try {
    const settings = await import('../src/lib/image-studio/settings');
    const integration = await import('../src/lib/integrations/image-generation');
    await db.user.create({ data: { id: owner, name: user.name, username: owner, email: user.email,
      password_hash: 'synthetic-not-a-login', role: 'admin', account_type: 'internal' } });
    await db.creditAccount.create({ data: { user_id: owner, balance: 100, frozen_credits: 0 } });
    await db.asset.createMany({ data: [sourceAssetId, fixedAssetId, styleAssetId].map((id, index) => ({
      id, owner_id: owner, type: 'image', original_url: `/fixture/${id}.png`, thumbnail_url: `/fixture/${id}-thumb.png`,
      file_name: `${id}.png`, mime_type: 'image/png', width: 32 + index, height: 32 + index,
      file_size: 128 + index, hash: sha(id), status: 'active',
    })) });
    await db.imageStudioModule.create({ data: { id: defaultModuleId, owner_id: owner, name: 'Default fixture',
      prompt: 'DEFAULT_PROMPT_MUST_NOT_LEAK', context: moduleContext, model: 'gpt-image-2', quality: 'medium',
      resolution: '2K', revision: 3 } });
    const api = { ...integration.DEFAULT_IMAGE_GENERATION_API_SETTINGS, enabled: true, provider: 'ai_media_vip' as const,
      default_model: 'gpt-image-2', base_url: 'https://fixture.invalid/v1/', api_key: 'synthetic-not-a-credential' };
    await db.platformSetting.createMany({ data: [
      { key: settings.IMAGE_STUDIO_SETTING_KEY, value_json: JSON.stringify({ model: 'gpt-image-2', revision: settingsRevision,
        context: globalContext, prices: { ...settings.DEFAULT_STUDIO_PRICES, 'gpt-image-2': 5 } }), updated_by: owner },
      { key: integration.IMAGE_GENERATION_API_SETTING_KEY, value_json: JSON.stringify(api), updated_by: owner },
      { key: `studio_fixed_references_v1:module:${defaultModuleId}`,
        value_json: JSON.stringify({ ownerId: owner, references: [{ assetId: fixedAssetId, note: fixedNote }] }), updated_by: owner },
      { key: `studio_style_group_v1:${styleId}`, value_json: JSON.stringify({ id: styleId, ownerId: owner,
        name: 'Default style', coverAssetId: styleAssetId, references: [{ assetId: styleAssetId, note: styleNote }],
        revision: 1, note: styleNote, shared: true }), updated_by: owner },
      { key: `studio_style_selection_v1:${defaultModuleId}`,
        value_json: JSON.stringify({ ownerId: owner, ids: [styleId] }), updated_by: owner },
      { key: `studio_skill_v1:${owner}:${skillId}`, value_json: JSON.stringify({ id: skillId, ownerId: owner,
        name: 'Default skill', prompt: skillPrompt, promptVersion: sha(skillPrompt), revision: 1, coverAssetId: null }), updated_by: owner },
      { key: `studio_skill_selection_v1:module:${defaultModuleId}`,
        value_json: JSON.stringify({ ownerId: owner, ids: [skillId] }), updated_by: owner },
    ] });

    const tasks = await import('../src/lib/image-studio/tasks');
    const contracts = await import('../src/lib/image-studio/billing-contract');
    const service = await import('../src/lib/character-lab/service');

    const newPlan = plan(randomUUID());
    await createPlan(newPlan);
    const quote = await service.quoteLab(user, newPlan.id);
    const expected = capture();
    await tasks.submitStudioBatch(owner, { ...submission(newPlan), ...(quote.imageChannel ? { imageChannel: quote.imageChannel } : {}) },
      undefined, expected.hook, undefined, undefined, undefined, undefined, newPlan.id);
    assert.equal(expected.prepared.length, 1);
    const expectedTask = expected.prepared[0];
    const expectedSnapshot = JSON.parse(String(expectedTask.snapshot_json));
    const expectedContract = contracts.parseImageBillingContract(String(expectedTask.billing_contract_json));
    assert.ok(expectedContract);
    assert.deepEqual(expectedSnapshot.characterLab, { version: 1, planId: newPlan.id });
    assert.equal(expectedSnapshot.globalContext, ''); assert.equal(expectedSnapshot.moduleContext, '');
    assert.deepEqual(expectedSnapshot.fixedReferenceImages, []); assert.deepEqual(expectedSnapshot.styleGroupIds, []);
    assert.deepEqual(expectedSnapshot.skills, []); assert.deepEqual(JSON.parse(String(expectedTask.reference_ids)), [sourceAssetId]);
    assert.equal(expectedTask.prompt, newPlan.prompt);
    for (const forbidden of [globalContext, moduleContext, fixedNote, styleNote, skillPrompt]) {
      assert.ok(!JSON.stringify(expectedTask).includes(forbidden));
    }

    const storedQuote = JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: { key: quoteKey(newPlan.id) } })).value_json);
    assert.equal(storedQuote.characterLabSourceVersion, 1);
    assert.equal(quote.unitCredits, expectedTask.unit_credits); assert.equal(quote.estimatedCredits, expectedTask.unit_credits);
    const submitted = await service.submitLab(user, { planId: newPlan.id, billingQuoteId: quote.billingQuoteId,
      pricingRevision: quote.pricingRevision, maxEstimatedCost: quote.estimatedCredits,
      characterLabPlanId: 'http-body-cannot-authorize-source', characterLabSourceVersion: 999 });
    assert.equal(submitted.batchId, batchId(owner, newPlan.id));
    const created = await db.imageStudioTask.findFirstOrThrow({ where: { owner_id: owner, batch_id: submitted.batchId } });
    const createdSnapshot = JSON.parse(String(created.snapshot_json));
    const createdContract = contracts.parseImageBillingContract(created.billing_contract_json);
    assert.deepEqual(createdSnapshot.characterLab, { version: 1, planId: newPlan.id });
    assert.equal(createdSnapshot.globalContext, ''); assert.equal(createdSnapshot.moduleContext, '');
    assert.deepEqual(JSON.parse(created.reference_ids), [sourceAssetId]); assert.equal(created.prompt, newPlan.prompt);
    assert.equal(createdContract?.specification, expectedContract.specification);
    assert.equal(created.unit_credits, expectedTask.unit_credits);
    assert.equal(JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: { key: receiptKey(newPlan.id) } })).value_json).state, 'accepted');

    const fakePlanId = randomUUID();
    const fakeBody = { ...submission(plan(fakePlanId)), characterLabPlanId: fakePlanId, characterLabSourceVersion: 1 };
    const ordinary = capture();
    await tasks.submitStudioBatch(owner, fakeBody, undefined, ordinary.hook);
    const ordinarySnapshot = JSON.parse(String(ordinary.prepared[0].snapshot_json));
    assert.equal(ordinarySnapshot.characterLab, undefined);
    assert.equal(ordinarySnapshot.globalContext, globalContext);
    await assert.rejects(tasks.submitStudioBatch(owner, submission(plan(randomUUID())), undefined, capture().hook,
      undefined, undefined, undefined, undefined, fakePlanId), /来源与本次原提交不匹配/);

    const acceptedPlan = plan(randomUUID(), 'LEGACY_ACCEPTED_PROMPT');
    await createPlan(acceptedPlan);
    const acceptedBatch = batchId(owner, acceptedPlan.id);
    await db.imageStudioTask.create({ data: { id: `${acceptedBatch}-legacy`, batch_id: acceptedBatch, owner_id: owner,
      ordinal: 1, fingerprint: 'legacy-fingerprint-must-stay', prompt: acceptedPlan.prompt, context: 'legacy-context',
      revision: 1, model: acceptedPlan.model, quality: acceptedPlan.quality, reference_ids: JSON.stringify(acceptedPlan.referenceIds),
      unit_credits: 77, billing_status: 'legacy_unknown', status: 'uncertain' } });
    const acceptedBefore = await db.imageStudioTask.findFirstOrThrow({ where: { batch_id: acceptedBatch } });
    const accountBeforeAccepted = await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } });
    assert.deepEqual(await service.submitLab(user, { planId: acceptedPlan.id, maxEstimatedCost: -1 }), { batchId: acceptedBatch });
    assert.deepEqual(await db.imageStudioTask.findFirstOrThrow({ where: { batch_id: acceptedBatch } }), acceptedBefore);
    assert.deepEqual(await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } }), accountBeforeAccepted);

    const unknownPlan = plan(randomUUID(), 'UNKNOWN_PROMPT');
    await createPlan(unknownPlan, 'submitting');
    const unknownReceipt = await db.platformSetting.findUniqueOrThrow({ where: { key: receiptKey(unknownPlan.id) } });
    await assert.rejects(service.submitLab(user, { planId: unknownPlan.id }), /原提交结果待确认或已结束/);
    assert.equal((await db.platformSetting.findUniqueOrThrow({ where: { key: receiptKey(unknownPlan.id) } })).value_json,
      unknownReceipt.value_json);
    assert.equal(await db.imageStudioTask.count({ where: { batch_id: batchId(owner, unknownPlan.id) } }), 0);

    const legacyQuotePlan = plan(randomUUID(), 'LEGACY_QUOTE_PROMPT');
    await createPlan(legacyQuotePlan);
    await db.platformSetting.create({ data: { key: quoteKey(legacyQuotePlan.id), value_json: JSON.stringify({
      billingQuoteId: null, estimatedCredits: 5, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }), updated_by: owner } });
    const legacyPlanBytes = (await db.platformSetting.findUniqueOrThrow({ where: { key: planKey(legacyQuotePlan.id) } })).value_json;
    const legacyReceiptBytes = (await db.platformSetting.findUniqueOrThrow({ where: { key: receiptKey(legacyQuotePlan.id) } })).value_json;
    const ledgerBefore = await db.creditLedger.count();
    const accountBeforeLegacyQuote = await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } });
    await assert.rejects(service.submitLab(user, { planId: legacyQuotePlan.id, billingQuoteId: null, maxEstimatedCost: 5 }),
      /报价来源已更新/);
    assert.equal((await db.platformSetting.findUniqueOrThrow({ where: { key: planKey(legacyQuotePlan.id) } })).value_json, legacyPlanBytes);
    assert.equal((await db.platformSetting.findUniqueOrThrow({ where: { key: receiptKey(legacyQuotePlan.id) } })).value_json, legacyReceiptBytes);
    assert.equal(JSON.parse(legacyReceiptBytes).state, 'prepared');
    assert.equal(await db.imageStudioTask.count({ where: { batch_id: batchId(owner, legacyQuotePlan.id) } }), 0);
    assert.equal(await db.creditLedger.count(), ledgerBefore);
    assert.deepEqual(await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } }), accountBeforeLegacyQuote);

    const sharp = (await import('sharp')).default;
    const store = await import('../src/lib/character-lab/store');
    const compositions = await import('../src/lib/character-lab/composition');
    const workspaceId = randomUUID();
    const workspace = await store.createLabWorkspace(owner, workspaceId, '独立四格', 'gpt-image-2');
    const draft = { ...workspace.draft, sourceAssetId, count: 9, diversity: 0, quality: 'medium', resolution: '2K' };
    const prepare = (kind: 'faces' | 'result', operation?: string, overrides?: Record<string, unknown>) =>
      service.prepareLab(user, { workspaceId, requestId: randomUUID(), workbench: 2, kind, operation, draft, ...overrides });
    const first = await prepare('faces');
    assert.equal(first.count, 9);
    assert.match(first.prompt, /3×3宫格/);
    assert.match(first.prompt, /保留人物身份/);
    assert.doesNotMatch(first.prompt, /结构方向|系统性改变/);
    const high = await prepare('faces', undefined, { draft: { ...draft, diversity: 75 } });
    assert.match(high.prompt, /第9格结构方向/);

    const paint = async (record: { id: string }, color: string) => {
      const id = randomUUID();
      const url = '/uploads/assets/' + id + '.png';
      const png = await sharp({ create: { width: 90, height: 90, channels: 3, background: color } }).png().toBuffer();
      mkdirSync(path.join(directory, 'public/uploads/assets'), { recursive: true });
      writeFileSync(path.join(directory, 'public', url), png);
      await db.asset.create({ data: {
        id, owner_id: owner, type: 'image', status: 'active', original_url: url, file_name: id + '.png',
        mime_type: 'image/png', width: 90, height: 90, file_size: png.length,
      } });
      await db.imageStudioTask.create({ data: {
        id: randomUUID(), batch_id: batchId(owner, record.id), owner_id: owner, ordinal: 1, fingerprint: sha(record.id),
        prompt: 'fixture', context: '', revision: 1, model: 'gpt-image-2', reference_ids: '[]',
        unit_credits: 5, status: 'succeeded', asset_id: id,
      } });
      return id;
    };
    await paint(first, '#ff0000');
    const face = { planId: first.id, cell: 4 };
    const picked = { ...draft, mainFace: face };
    const faceRefinement = await prepare('faces', 'refine-face', { draft: picked, input: face, description: '鼻梁略低' });
    assert.equal(faceRefinement.count, 4);
    assert.match(faceRefinement.prompt, /鼻梁略低/);
    assert.deepEqual(faceRefinement.input, face);
    const side = await prepare('result', 'side', { draft: picked });
    assert.deepEqual(side.mainFace, face);
    assert.deepEqual(side.referenceIds, faceRefinement.referenceIds);
    assert.match(side.referenceIds[0], /^clab-/);
    const sideAsset = await paint(side, '#00ff00');
    const sideRefinement = await prepare('faces', 'refine-side', {
      draft: picked, input: { planId: side.id }, description: '收一点下颌',
    });
    assert.deepEqual(sideRefinement.referenceIds, [side.referenceIds[0], sideAsset]);
    await assert.rejects(prepare('faces', 'refine-side', {
      draft: { ...picked, mainFace: { ...face, cell: 5 } }, input: { planId: side.id }, description: '收一点下颌',
    }), /侧脸对应旧正脸/);
    const retrySide = await prepare('result', 'side', { draft: picked });
    const sideQuote = await service.quoteLab(user, retrySide.id);
    await db.platformSetting.update({
      where: { key: receiptKey(sideRefinement.id) }, data: { value_json: JSON.stringify({ state: 'submitting' }) },
    });
    await assert.rejects(service.submitLab(user, { planId: retrySide.id, billingQuoteId: sideQuote.billingQuoteId,
      pricingRevision: sideQuote.pricingRevision, maxEstimatedCost: sideQuote.estimatedCredits }), /原提交结果待确认/);
    const bodyFront = await prepare('result', 'body-front', { draft: picked });
    const bodyBack = await prepare('result', 'body-back', { draft: picked });
    assert.deepEqual(bodyFront.referenceIds, [sourceAssetId]);
    assert.deepEqual(bodyBack.referenceIds, [sourceAssetId]);
    assert.equal(bodyFront.mainFace, null);
    await paint(bodyFront, '#0000ff');
    await paint(bodyBack, '#ffff00');

    const views = { side: { planId: side.id }, 'body-front': { planId: bodyFront.id }, 'body-back': { planId: bodyBack.id } };
    const selected = await store.updateLabWorkspace(owner, workspaceId, workspace.revision, workspace.name, { ...picked, views });
    assert.deepEqual(selected.views, views);
    const legacy = await service.labWorkspaceState(user, workspaceId);
    assert.ok(legacy.plans.every(item => !item.operation));
    const refreshed = await service.labWorkspaceState(user, workspaceId, true);
    assert.ok(refreshed.plans.some(item => item.id === sideRefinement.id));
    assert.equal(refreshed.submissionByRequestId[sideRefinement.id], 'submitting');
    const beforeCompose = await db.imageStudioTask.count();
    const beforeComposeLedger = await db.creditLedger.count();
    const png = await compositions.composeLabSheet(user, selected);
    const sample = async (left: number, top: number) => Array.from(await sharp(png).extract({ left, top, width: 1, height: 1 }).removeAlpha().raw().toBuffer());
    assert.deepEqual(await sample(400, 500), [255, 0, 0]);
    assert.deepEqual(await sample(1200, 500), [0, 255, 0]);
    assert.deepEqual(await sample(400, 1700), [0, 0, 255]);
    assert.deepEqual(await sample(1200, 1700), [255, 255, 0]);
    await assert.rejects(compositions.composeLabSheet(user, { ...selected, draft: { ...selected.draft, mainFace: { ...face, cell: 5 } } }), /侧脸对应旧正脸/);
    const saved = await compositions.saveLabComposition(user, { workspaceId, revision: selected.revision, name: '四格' });
    const repeated = await compositions.saveLabComposition(user, { workspaceId, revision: saved.revision, name: '四格' });
    assert.equal(repeated.compositions?.length, 1);
    const savedPng = await compositions.readLabComposition(user, workspaceId, saved.compositions![0].id);
    assert.ok(savedPng.png.equals(png));
    const savedByLegacy = await store.updateLabWorkspace(owner, workspaceId, saved.revision, saved.name, saved.draft);
    assert.deepEqual(savedByLegacy.views, views);
    assert.deepEqual(savedByLegacy.compositions, saved.compositions);
    assert.equal(await db.imageStudioTask.count(), beforeCompose);
    assert.equal(await db.creditLedger.count(), beforeComposeLedger);

    assert.equal(forbiddenCalls, 0);
    console.log(JSON.stringify({ schema: 'character-lab-submission-engineering.v1', synthetic: true,
      checks: ['lab_source_ignores_global_default_fixed_style_skill', 'quote_create_source_and_specification_match',
        'source_marker_requires_server_internal_parameter', 'accepted_and_unknown_preserve_original_request',
        'legacy_quote_rejected_before_submitting_or_fees', 'nine_grid_and_strength_rules', 'refinement_and_view_references',
        'same_slot_pending_only', 'legacy_projection_and_writer', 'composition_png_order_identity_and_idempotency'],
      taskId: created.id, batchId: created.batch_id, databasePath, productionWrites: 0, paidRequests: 0,
      browserRuns: 0, forbiddenCalls }, null, 2));
  } finally {
    mock.restoreAll();
    await db.$disconnect();
    process.chdir(root);
    process.umask(previousUmask);
    for (const [file, digest] of Object.entries(sourceHashes)) assert.equal(sha(readFileSync(path.join(root, file))), digest);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
