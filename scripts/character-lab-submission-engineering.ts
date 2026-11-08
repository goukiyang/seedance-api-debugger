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
    'src/lib/character-lab/service.ts', 'src/lib/character-lab/recipe.ts'];
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
  const createPlan = async (record: { id: string }, receipt: 'prepared' | 'submitting' | 'accepted' = 'prepared') => {
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
    assert.equal(storedQuote.characterLabSourceVersion, 2);
    assert.equal(quote.unitCredits, expectedTask.unit_credits); assert.equal(quote.estimatedCredits, expectedTask.unit_credits);
    const submitted = await service.submitLab(user, { planId: newPlan.id, billingQuoteId: quote.billingQuoteId,
      pricingRevision: quote.pricingRevision, maxEstimatedCost: quote.estimatedCredits,
      characterLabPlanId: 'http-body-cannot-authorize-source', characterLabSourceVersion: 999 });
    assert.equal(submitted.batchId, batchId(owner, newPlan.id));
    const created = await db.imageStudioTask.findFirstOrThrow({ where: { owner_id: owner, batch_id: submitted.batchId } });
    const createdSnapshot = JSON.parse(String(created.snapshot_json));
    const createdContract = contracts.parseImageBillingContract(created.billing_contract_json);
    assert.deepEqual(createdSnapshot.characterLab, { version: 1, planId: newPlan.id, personalPromptSeparated: 1 });
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
      billingQuoteId: null, estimatedCredits: 5, expiresAt: new Date(Date.now() + 60_000).toISOString(), characterLabSourceVersion: 1,
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
    const draft = { ...workspace.draft, faceDescription: 'FACE_ONLY_SENTINEL', sideDescription: 'SIDE_ONLY_SENTINEL', bodyDescription: 'BODY_ONLY_SENTINEL', context: 'UNASSIGNED_LEGACY_SENTINEL', sourceAssetId, count: 9 as const, diversity: 0, quality: 'medium', resolution: '2K' };
    const prepare = (kind: 'faces' | 'result', operation?: string, overrides?: Record<string, unknown>) =>
      service.prepareLab(user, { workspaceId, requestId: randomUUID(), workbench: 2, contextProtocol: 1, kind, operation, draft, ...overrides });
    const first = await prepare('faces');
    assert.equal(first.count, 9);
    assert.match(first.prompt, /3×3宫格/);
    assert.match(first.prompt, /保留人物身份/);
    assert.doesNotMatch(first.prompt, /结构方向|系统性改变/);
    assert.match(first.prompt, /FACE_ONLY_SENTINEL/);
    assert.doesNotMatch(first.prompt, /SIDE_ONLY_SENTINEL|BODY_ONLY_SENTINEL|UNASSIGNED_LEGACY_SENTINEL/);
    assert.equal(first.context, draft.faceDescription);
    await assert.rejects(prepare('faces', undefined, { contextProtocol: undefined }), /上下文已独立/);
    const legacyInput = store.parseLabDraft({ ...draft, faceDescription: undefined, sideDescription: undefined, bodyDescription: undefined });
    const legacyId = randomUUID();
    const legacyFingerprint = sha(JSON.stringify({ workspaceId, kind: 'faces', draft: legacyInput, operation: undefined, slotScoped: true }));
    const legacyExisting = { ...plan(legacyId), workspaceId, inputFingerprint: legacyFingerprint };
    await createPlan(legacyExisting);
    assert.deepEqual(await service.prepareLab(user, { workspaceId, requestId: legacyId, workbench: 2, kind: 'faces', draft: legacyInput }), legacyExisting);
    const high = await prepare('faces', undefined, { draft: { ...draft, diversity: 75 } });
    assert.match(high.prompt, /第9格结构方向/);

    const paint = async (record: { id: string }, color: string, rightColor?: string) => {
      const id = randomUUID();
      const url = '/uploads/assets/' + id + '.png';
      const right = rightColor ? await sharp({ create: { width: 45, height: 90, channels: 3, background: rightColor } }).png().toBuffer() : null;
      const image = sharp({ create: { width: 90, height: 90, channels: 3, background: color } });
      const png = await (right ? image.composite([{ input: right, left: 45, top: 0 }]) : image).png().toBuffer();
      mkdirSync(path.join(directory, 'public/uploads/assets'), { recursive: true });
      writeFileSync(path.join(directory, 'public', url), png);
      await db.asset.create({ data: {
        id, owner_id: owner, type: 'image', status: 'active', original_url: url, file_name: id + '.png',
        mime_type: 'image/png', width: 90, height: 90, file_size: png.length,
      } });
      const task = await db.imageStudioTask.findFirst({ where: { batch_id: batchId(owner, record.id) } });
      if (task) await db.imageStudioTask.update({ where: { id: task.id }, data: { status: 'succeeded', asset_id: id } });
      else await db.imageStudioTask.create({ data: {
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
    assert.match(side.prompt, /SIDE_ONLY_SENTINEL/);
    assert.doesNotMatch(side.prompt, /FACE_ONLY_SENTINEL|BODY_ONLY_SENTINEL|UNASSIGNED_LEGACY_SENTINEL/);
    assert.equal(side.context, '');
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
    assert.match(bodyFront.prompt, /BODY_ONLY_SENTINEL/);
    assert.doesNotMatch(bodyFront.prompt, /FACE_ONLY_SENTINEL|SIDE_ONLY_SENTINEL|UNASSIGNED_LEGACY_SENTINEL/);
    assert.equal(bodyFront.context, '');
    assert.equal(faceRefinement.context, '');
    assert.doesNotMatch(faceRefinement.prompt, /FACE_ONLY_SENTINEL|SIDE_ONLY_SENTINEL|BODY_ONLY_SENTINEL/);
    const contexts = await import('../src/lib/character-lab/contexts');
    assert.deepEqual(contexts.labPersonalFields(first), { faceDescription: draft.faceDescription });
    assert.deepEqual(contexts.labPersonalFields(side), { sideDescription: draft.sideDescription });
    assert.deepEqual(contexts.labPersonalFields({ ...bodyFront, context: 'OLD_FACE_TEXT', adjustment: '' }), { bodyDescription: '' });
    const recovered = contexts.labIndependentDraft({ ...draft, faceDescription: undefined, sideDescription: undefined, bodyDescription: undefined, mainFace: face }, [bodyFront, side, first]);
    assert.equal(recovered.faceDescription, draft.faceDescription);
    assert.equal(recovered.sideDescription, draft.sideDescription);
    assert.equal(recovered.bodyDescription, draft.bodyDescription);
    assert.equal(recovered.context, draft.context);
    assert.equal(contexts.labIndependentDraft({ ...draft, faceDescription: '', bodyDescription: '' }, [bodyFront, first]).faceDescription, '');
    assert.equal(contexts.labIndependentDraft({ ...draft, faceDescription: undefined, bodyDescription: undefined }, [{ ...first, sourceAssetId: 'other-source' }]).faceDescription, '');

    const pairInput = { ...picked, bodyDescription: '保持腰带与衣服细节' };
    const pair = service.CHARACTER_LAB_BODY_PAIRS_ENABLED
      ? await prepare('result', 'body-pair', { draft: pairInput, description: pairInput.bodyDescription })
      : { ...plan(randomUUID()), workspaceId, kind: 'result' as const, operation: 'body-pair' as const,
          slotScoped: true as const, count: 4 as const, aspectRatio: '1:1' as const, mainFace: null, referenceIds: [sourceAssetId] };
    if (service.CHARACTER_LAB_BODY_PAIRS_ENABLED) {
      assert.equal(pair.aspectRatio, '1:1');
      assert.equal(pair.mainFace, null);
      assert.deepEqual(pair.referenceIds, [sourceAssetId]);
      assert.match(pair.prompt, /左半区严格正面/);
      assert.match(pair.prompt, /右半区严格背面/);
      assert.match(pair.prompt, /保持腰带与衣服细节/);
      assert.equal(pair.adjustment, pairInput.bodyDescription);
      const quote = await service.quoteLab(user, pair.id);
      assert.equal(quote.estimatedCredits, quote.unitCredits);
      const submitted = await service.submitLab(user, { planId: pair.id, billingQuoteId: quote.billingQuoteId,
        pricingRevision: quote.pricingRevision, maxEstimatedCost: quote.estimatedCredits });
      const pairTasks = await db.imageStudioTask.findMany({ where: { batch_id: submitted.batchId } });
      assert.equal(pairTasks.length, 1);
      assert.equal(pairTasks[0].prompt, pair.prompt);
      assert.deepEqual(JSON.parse(pairTasks[0].reference_ids), [sourceAssetId]);
      assert.equal(pairTasks[0].aspect_ratio, '1:1');
      const beforeRepeat = await db.creditLedger.count();
      assert.deepEqual(await service.submitLab(user, { planId: pair.id }), submitted);
      assert.equal(await db.creditLedger.count(), beforeRepeat);
      assert.equal(await db.imageStudioTask.count({ where: { batch_id: submitted.batchId } }), 1);
    } else {
      await createPlan(pair);
      await assert.rejects(prepare('result', 'body-pair', { draft: pairInput }), /恢复版本暂不新建/);
      await assert.rejects(service.submitLab(user, { planId: pair.id }), /恢复版本暂不新建/);
      assert.equal(await db.imageStudioTask.count({ where: { batch_id: batchId(owner, pair.id) } }), 0);
    }
    await paint(pair, '#0000ff', '#ffff00');
    const media = await import('../src/lib/character-lab/media');
    assert.deepEqual(media.labCellRect(91, 90, pair, 0), { left: 0, top: 0, width: 45, height: 90 });
    assert.deepEqual(media.labCellRect(91, 90, pair, 1), { left: 45, top: 0, width: 46, height: 90 });
    assert.throws(() => media.labCellRect(90, 90, pair, 2), /格子选择无效/);
    await assert.rejects(media.readLabReference(user, workspaceId, sourceAssetId, { planId: pair.id, cell: 1 }, 'body-front'), /其他角色、原图或视图/);
    await assert.rejects(media.readLabReference(user, workspaceId, sourceAssetId, { planId: pair.id }, 'body-back'), /其他角色、原图或视图/);
    await media.readLabReference(user, workspaceId, sourceAssetId, { planId: pair.id, cell: 0 }, 'body-front');
    await media.readLabReference(user, workspaceId, sourceAssetId, { planId: bodyFront.id }, 'body-front');
    // New explicit layout never changes old single-side interpretation.
    const layouts = await import('../src/lib/character-lab/types');
    assert.equal(layouts.characterLabCellCount(side), 1);
    assert.throws(() => media.labCellRect(90, 90, side, 0), /没有裁切/);
    // Use a separate workspace; the existing pending-side fixture must remain unknown.
    const gridWorkspace = await store.createLabWorkspace(owner, randomUUID(), '新版布局隔离', 'gpt-image-2');
    const gridFirst = { ...first, id: randomUUID(), workspaceId: gridWorkspace.id };
    await createPlan(gridFirst); await paint(gridFirst, '#ff0000');
    const gridFace = { planId: gridFirst.id, cell: face.cell };
    const gridPicked = { ...picked, mainFace: gridFace };
    const gridPair = { ...pair, id: randomUUID(), workspaceId: gridWorkspace.id };
    await createPlan(gridPair); await paint(gridPair, '#0000ff', '#ffff00');
    const gridPrepare = (kind: 'faces' | 'result', operation?: string, overrides?: Record<string, unknown>) => prepare(kind, operation, { workspaceId: gridWorkspace.id, ...overrides });
    const storedGrid = { ...side, id: randomUUID(), workspaceId: gridWorkspace.id, mainFace: gridFace, outputLayout: 'grid' as const, count: 9 as const };
    await createPlan(storedGrid);
    await paint(storedGrid, '#00ff00');
    await media.readLabReference(user, gridWorkspace.id, sourceAssetId, { planId: storedGrid.id, cell: 8 }, 'side');
    assert.equal((await sharp(await media.labPng(user, storedGrid, 8)).metadata()).width, 30);
    if (service.CHARACTER_LAB_GRID_WRITES_ENABLED) {
      for (const count of [4, 9] as const) {
        const gridDraft = { ...gridPicked, count };
        const gridSide = await gridPrepare('result', 'side', { layoutProtocol: 1, draft: gridDraft });
        assert.equal(gridSide.outputLayout, 'grid');
        assert.equal(gridSide.count, count);
        assert.equal(layouts.characterLabCellCount(gridSide), count);
        assert.match(gridSide.prompt, new RegExp(`恰好${count}格`));
        assert.doesNotMatch(gridSide.prompt, /仅输出单张侧脸|FACE_ONLY_SENTINEL|BODY_ONLY_SENTINEL/);
        await paint(gridSide, '#00ff00');
        const cell = { planId: gridSide.id, cell: count - 1 };
        await media.readLabReference(user, gridWorkspace.id, sourceAssetId, cell, 'side');
        await assert.rejects(media.readLabReference(user, gridWorkspace.id, sourceAssetId, { ...cell, cell: count }, 'side'), /格子选择无效/);
        const crop = await media.labPng(user, gridSide, count - 1);
        assert.equal((await sharp(crop).metadata()).width, count === 9 ? 30 : 45);
        const refinedSide = await gridPrepare('faces', 'refine-side', { layoutProtocol: 1, draft: gridDraft, input: cell, description: '鼻尖微调' });
        assert.equal(refinedSide.count, count);
        assert.equal(refinedSide.referenceIds.length, 2);
        assert.deepEqual(refinedSide.input, cell);
        assert.deepEqual(contexts.labPersonalFields(refinedSide), { sideDescription: '鼻尖微调' });
        const refinedFace = await gridPrepare('faces', 'refine-face', { layoutProtocol: 1, draft: gridDraft, input: gridFace, description: '正脸微调' });
        assert.equal(refinedFace.count, count);
        assert.match(refinedFace.prompt, new RegExp(`恰好${count}格`));
        assert.deepEqual(contexts.labPersonalFields(refinedFace), { faceDescription: '正脸微调' });
      }
      const bodyInput = { planId: gridPair.id };
      const refinedPair = await gridPrepare('result', 'body-pair', { layoutProtocol: 1, draft: gridPicked, input: bodyInput });
      assert.deepEqual(refinedPair.input, bodyInput);
      assert.equal(refinedPair.referenceIds[0], sourceAssetId);
      assert.equal(refinedPair.referenceIds.length, 2);
      assert.match(refinedPair.prompt, /参考2是本次要调整的既有正背面整组/);
      assert.doesNotMatch(refinedPair.prompt, /FACE_ONLY_SENTINEL|SIDE_ONLY_SENTINEL/);
      const pairRecipe = await (await import('../src/lib/character-lab/recipe')).labRecipe(user, refinedPair.id);
      assert.deepEqual(pairRecipe.references[1].source, bodyInput);
      assert.match(pairRecipe.references[1].label, /正背面整组/);
      await assert.rejects(gridPrepare('result', 'body-pair', { layoutProtocol: 1, draft: gridPicked, input: { planId: first.id } }), /完整正背面组/);
      await assert.rejects(gridPrepare('faces', undefined, { layoutProtocol: 2 }), /布局版本不受支持/);
    }
    const pendingWorkspace = await store.createLabWorkspace(owner, randomUUID(), '成对未知提交', 'gpt-image-2');
    const pendingPair = { ...plan(randomUUID()), workspaceId: pendingWorkspace.id, kind: 'result', operation: 'body-pair', slotScoped: true };
    await createPlan(pendingPair, 'submitting');
    await assert.rejects(prepare('result', 'body-front', { workspaceId: pendingWorkspace.id }), /原提交结果待确认/);
    await assert.rejects(prepare('result', 'body-back', { workspaceId: pendingWorkspace.id }), /原提交结果待确认/);
    if (service.CHARACTER_LAB_BODY_PAIRS_ENABLED) {
      const pendingSingleWorkspace = await store.createLabWorkspace(owner, randomUUID(), '单面未知提交', 'gpt-image-2');
      const pendingSingle = { ...plan(randomUUID()), workspaceId: pendingSingleWorkspace.id, kind: 'result', operation: 'body-back', slotScoped: true };
      await createPlan(pendingSingle, 'submitting');
      await assert.rejects(prepare('result', 'body-pair', { workspaceId: pendingSingleWorkspace.id }), /原提交结果待确认/);
    }

    const views = { side: { planId: side.id }, 'body-front': { planId: pair.id, cell: 0 }, 'body-back': { planId: pair.id, cell: 1 } };
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

    const recipes = await import('../src/lib/character-lab/recipe');
    const firstTask = await db.imageStudioTask.findFirstOrThrow({ where: { batch_id: batchId(owner, first.id) } });
    await db.imageStudioTask.update({ where: { id: firstTask.id }, data: { prompt: first.prompt, context: 'ORIGINAL_REFERENCE_CONTEXT_FROZEN' } });
    const beforeRead = { tasks: await db.imageStudioTask.count(), ledger: await db.creditLedger.count(),
      workspace: (await db.platformSetting.findUniqueOrThrow({ where: { key: store.workspaceKey(owner, workspaceId) } })).value_json };
    const detail = await recipes.labRecipe(user, first.id);
    assert.equal(detail.completePrompt, `ORIGINAL_REFERENCE_CONTEXT_FROZEN\n\n---\n本次画面要求：\n${first.prompt}`);
    assert.equal(detail.references[0].id, sourceAssetId);
    const member: SessionUser = { ...user, role: 'user' };
    const memberDetail = await recipes.labRecipe(member, first.id);
    assert.equal(memberDetail.completePrompt, null); assert.equal(memberDetail.instruction, null);
    assert.equal(memberDetail.plan.prompt, '');
    assert.ok(!JSON.stringify(memberDetail).includes('ORIGINAL_REFERENCE_CONTEXT_FROZEN'));
    const memberBootstrap = await service.labBootstrapFor(member);
    assert.equal(memberBootstrap.config.styleConstraints, ''); assert.deepEqual(memberBootstrap.configVersions, []);
    const mixedTask = { ...firstTask, snapshot_json: JSON.stringify({ prompt: first.prompt, personalPrompt: first.prompt,
      characterLab: { version: 1, planId: first.id }, globalContext: '', moduleContext: '' }) };
    const mixedPublic = tasks.publicStudioSnapshot(mixedTask, new Map(), false, owner);
    assert.equal(mixedPublic.prompt, ''); assert.equal(mixedPublic.sourceAvailable, false);
    const separatedTask = { ...firstTask, snapshot_json: JSON.stringify({ prompt: first.prompt, personalPrompt: 'ONLY_PERSONAL_DESCRIPTION',
      characterLab: { version: 1, planId: first.id, personalPromptSeparated: 1 }, globalContext: '', moduleContext: '' }) };
    assert.equal(tasks.publicStudioSnapshot(separatedTask, new Map(), false, owner).prompt, 'ONLY_PERSONAL_DESCRIPTION');
    await assert.rejects(recipes.labRecipe({ ...user, id: 'other-fixture-owner' }, first.id), /不存在或无权访问/);
    const restored = await recipes.restoreLabSettings(user, { workspaceId, planId: first.id });
    assert.equal(restored.patch.count, 9);
    assert.equal(restored.patch.faceDescription, draft.faceDescription);
    assert.equal(restored.patch.context, undefined); assert.equal(restored.patch.bodyDescription, undefined);
    const bodyRestored = await recipes.restoreLabSettings(user, { workspaceId, planId: bodyFront.id });
    assert.equal(bodyRestored.patch.bodyDescription, draft.bodyDescription);
    assert.equal(bodyRestored.patch.faceDescription, undefined); assert.equal(bodyRestored.patch.context, undefined);
    const sideRestored = await recipes.restoreLabSettings(user, { workspaceId, planId: side.id });
    assert.equal(sideRestored.patch.sideDescription, draft.sideDescription);
    assert.equal(sideRestored.patch.faceDescription, undefined); assert.equal(sideRestored.patch.bodyDescription, undefined);
    assert.equal(restored.patch.mainFace, undefined); assert.equal(restored.patch.sourceAssetId, undefined);
    assert.equal(restored.patch.views, undefined);
    assert.equal((await db.platformSetting.findUniqueOrThrow({ where: { key: store.workspaceKey(owner, workspaceId) } })).value_json, beforeRead.workspace);
    assert.equal(await db.imageStudioTask.count(), beforeRead.tasks); assert.equal(await db.creditLedger.count(), beforeRead.ledger);
    assert.equal(saved.compositions?.[0].layout, 'sheet-2x2-v1');
    assert.deepEqual(saved.compositions?.[0].sources, { sourceAssetId, mainFace: face, side: views.side, front: views['body-front'], back: views['body-back'] });

    await store.saveLabConfig(user, 0, { ...store.defaultLabConfig, styleConstraints: 'NEW_SAVED_RULES_FOR_NEXT_GENERATION', sideStyleConstraints: 'SIDE_STYLE_SENTINEL', bodyStyleConstraints: 'BODY_STYLE_SENTINEL' });
    const nextDraft = { ...savedByLegacy.draft, ...restored.patch };
    const preview = await recipes.previewLabPrompt(user, { workspaceId, contextProtocol: 1, kind: 'faces', draft: nextDraft });
    assert.match(preview.prompt || '', /NEW_SAVED_RULES_FOR_NEXT_GENERATION/);
    assert.doesNotMatch((await recipes.labRecipe(user, first.id)).completePrompt || '', /NEW_SAVED_RULES_FOR_NEXT_GENERATION/);
    const sidePreview = await recipes.previewLabPrompt(user, { workspaceId, contextProtocol: 1, kind: 'result', operation: 'side', draft: nextDraft, description: 'FOREIGN_OVERRIDE' });
    assert.match(sidePreview.prompt || '', /SIDE_STYLE_SENTINEL/);
    assert.match(sidePreview.prompt || '', /SIDE_ONLY_SENTINEL/);
    assert.doesNotMatch(sidePreview.prompt || '', /NEW_SAVED_RULES_FOR_NEXT_GENERATION|BODY_STYLE_SENTINEL|FACE_ONLY_SENTINEL|FOREIGN_OVERRIDE/);
    const bodyPreview = await recipes.previewLabPrompt(user, { workspaceId, contextProtocol: 1, kind: 'result', operation: 'body-pair', draft: nextDraft });
    assert.match(bodyPreview.prompt || '', /BODY_STYLE_SENTINEL/);
    assert.match(bodyPreview.prompt || '', /BODY_ONLY_SENTINEL/);
    assert.doesNotMatch(bodyPreview.prompt || '', /NEW_SAVED_RULES_FOR_NEXT_GENERATION|SIDE_STYLE_SENTINEL|FACE_ONLY_SENTINEL/);
    const savedText = await store.updateLabWorkspace(owner, workspaceId, savedByLegacy.revision, savedByLegacy.name, nextDraft);
    const oldPageDraft = { ...savedText.draft, faceDescription: undefined, bodyDescription: undefined, sideDescription: undefined };
    const oldPageSaved = await store.updateLabWorkspace(owner, workspaceId, savedText.revision, savedText.name, oldPageDraft);
    assert.equal(oldPageSaved.draft.faceDescription, nextDraft.faceDescription);
    assert.equal(oldPageSaved.draft.bodyDescription, nextDraft.bodyDescription);
    assert.equal(oldPageSaved.draft.sideDescription, nextDraft.sideDescription);
    if (service.CHARACTER_LAB_RECIPE_WRITES_ENABLED) {
      const continued = await prepare('faces', undefined, { draft: nextDraft, recipeProtocol: 1 });
      assert.deepEqual(continued.origin, { planId: first.id, mode: 'current' });
      assert.match(continued.prompt, /NEW_SAVED_RULES_FOR_NEXT_GENERATION/);
      const requestId = randomUUID();
      const reproduced = await service.reproduceLab(user, { sourcePlanId: first.id, workspaceId, requestId });
      assert.equal(reproduced.prompt, first.prompt);
      assert.equal(reproduced.frozenReferenceContext, 'ORIGINAL_REFERENCE_CONTEXT_FROZEN');
      assert.deepEqual(reproduced.referenceIds, first.referenceIds);
      assert.deepEqual(reproduced.origin, { planId: first.id, mode: 'historical' });
      assert.deepEqual(await service.reproduceLab(user, { sourcePlanId: first.id, workspaceId, requestId }), reproduced);
      const historicalQuote = await service.quoteLab(user, reproduced.id);
      const historicalSubmit = await service.submitLab(user, { planId: reproduced.id, billingQuoteId: historicalQuote.billingQuoteId,
        pricingRevision: historicalQuote.pricingRevision, maxEstimatedCost: historicalQuote.estimatedCredits });
      const historicalTasks = await db.imageStudioTask.findMany({ where: { batch_id: historicalSubmit.batchId } });
      assert.equal(historicalTasks.length, 1);
      assert.equal(historicalTasks[0].prompt, first.prompt); assert.equal(historicalTasks[0].context, reproduced.frozenReferenceContext);
      assert.deepEqual(JSON.parse(historicalTasks[0].reference_ids), first.referenceIds);
      const ledgerAfterHistorical = await db.creditLedger.count();
      assert.deepEqual(await service.submitLab(user, { planId: reproduced.id }), historicalSubmit);
      assert.equal(await db.creditLedger.count(), ledgerAfterHistorical);
    } else {
      await assert.rejects(prepare('faces', undefined, { recipeProtocol: 1 }), /恢复版本仅查看/);
      await assert.rejects(service.reproduceLab(user, { sourcePlanId: first.id, workspaceId, requestId: randomUUID() }), /恢复版本仅查看/);
    }
    const unknownRecipe = { ...plan(randomUUID()), workspaceId, slotScoped: true, recipeProtocol: 1 };
    await createPlan(unknownRecipe, 'submitting');
    await assert.rejects(service.submitLab(user, { planId: unknownRecipe.id }), (error: unknown) => {
      assert.notEqual((error as { submitted?: unknown }).submitted, false);
      return /原提交结果待确认/.test(String(error));
    });

    assert.equal(forbiddenCalls, 0);
    console.log(JSON.stringify({ schema: 'character-lab-submission-engineering.v1', synthetic: true,
      checks: ['lab_source_ignores_global_default_fixed_style_skill', 'quote_create_source_and_specification_match',
        'source_marker_requires_server_internal_parameter', 'accepted_and_unknown_preserve_original_request',
        'legacy_quote_rejected_before_submitting_or_fees', 'nine_grid_and_strength_rules', 'refinement_and_view_references',
        'same_slot_pending_only', 'body_pair_single_task_description_crops_and_slot_conflicts', 'legacy_projection_and_writer', 'composition_png_order_identity_and_idempotency',
        'recipe_detail_full_context_and_member_projection', 'restore_reads_only_and_composition_lineage',
        'current_rules_vs_historical_quote_and_single_submission', 'recipe_guard_preserves_unknown_receipts',
        'independent_context_prepare_and_old_request_lookup', 'independent_history_empty_and_workspace_preservation', 'independent_style_and_preview_scopes', 'explicit_head_4_9_crops_refine_and_body_pair_input'],
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
