import { setFixtureDatabase } from './fixtures/database-client';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mock } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import type { Prisma } from '@prisma/client';

process.exitCode = 1;
const deadline = setTimeout(() => process.exit(1), 180000); deadline.ref();
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const sourcePaths = ['src/lib/image-studio/ratios.ts', 'src/lib/image-generation/resolution.ts',
  'src/lib/integrations/image-generation.ts', 'src/lib/image-studio/tasks.ts',
  'src/lib/image-studio/billing-quote-service.ts', 'src/lib/image-studio/billing-quote-store.ts',
  'src/lib/image-studio/batch-billing-quote.ts', 'src/lib/image-studio/batches.ts',
  'src/lib/tools/toolflow-runtime.ts', 'src/app/api/assets/generate/route.ts', 'src/lib/image-studio/worker.ts'];

async function main() {
  const root = realpathSync(process.cwd()), runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID;
  assert.match(runId || '', /^[a-f0-9-]{36}$/i);
  const startedAt = new Date().toISOString(), previousUmask = process.umask(0o077);
  const sourceSha256 = Object.fromEntries(sourcePaths.map(file => [file, sha(readFileSync(path.join(root, file)))]));
  const fixtureSha256 = sha(readFileSync(path.join(root, 'scripts/image-size-policy-engineering.ts')));
  const scratch = path.join(root, '.role-tests'); mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'image-size-policy-')), databasePath = path.join(directory, 'synthetic.db');
  process.env.DATABASE_URL = `file:${databasePath}`; Reflect.set(process.env, 'NODE_ENV', 'test');
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  const require = createRequire(import.meta.url), prismaPackage = require.resolve('prisma/package.json');
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[name]) env[name] = process.env[name];
  execFileSync(process.execPath, [path.join(path.dirname(prismaPackage), 'build/index.js'), 'db', 'push', '--skip-generate',
    '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(statSync(databasePath).mode & 0o777, 0o600);
  const { PrismaClient } = await import('@prisma/client'); const db = new PrismaClient(); setFixtureDatabase(db);
  process.chdir(directory);
  const checks: string[] = [];
  let completed = false, forbiddenCalls = 0;
  const blocked = () => { forbiddenCalls++; throw new Error('Fixture network is forbidden'); };
  mock.method(globalThis, 'fetch', blocked); mock.method(http, 'request', blocked); mock.method(http, 'get', blocked);
  mock.method(https, 'request', blocked); mock.method(https, 'get', blocked); mock.method(dns, 'lookup', blocked);
  const serverOnlyMarker = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js');
  assert.equal(statSync(serverOnlyMarker).size, 0);
  const resolver = require('node:module') as { _resolveFilename: (...args: unknown[]) => string };
  const originalResolve = resolver._resolveFilename;
  mock.method(resolver, '_resolveFilename', (...args: unknown[]) => args[0] === 'server-only'
    ? serverOnlyMarker : originalResolve.apply(resolver, args));
  try {
    const ratios = await import('../src/lib/image-studio/ratios');
    const resolution = await import('../src/lib/image-generation/resolution');
    const integration = await import('../src/lib/integrations/image-generation');
    // Aggregated, non-identifying historical specifications. Multiplicity keeps
    // the original 119-case cohort without storing task ids or private inputs.
    const historical: Array<[string, string, string, number]> = [
      ['11:15', '4K', '2464x3360', 1], ['1672:941', '2K', '2672x1504', 2], ['1672:941', '4K', '3440x1936', 2],
      ['16:9', '4K', '3840x2160', 19], ['1:1', '2K', '2048x2048', 21], ['1:1', '4K', '2880x2880', 21],
      ['2:3', '4K', '2336x3504', 1], ['301:300', '4K', '2880x2864', 1], ['341:500', '4K', '2368x3472', 1],
      ['375:211', '4K', '3696x2080', 4], ['3:4', '4K', '2448x3264', 5], ['444:601', '4K', '1312x1776', 2],
      ['55:61', '4K', '2640x2928', 1], ['567:1049', '4K', '1920x3552', 4], ['56:83', '4K', '1792x2656', 2],
      ['58:77', '2K', '928x1232', 13], ['58:77', '4K', '1856x2464', 8], ['677:947', '4K', '2368x3312', 3],
      ['744:1049', '4K', '1600x2256', 2], ['757:1035', '4K', '2048x2800', 1], ['775:1059', '4K', '2096x2864', 2],
      ['82:111', '4K', '1312x1776', 1], ['836:1209', '4K', '2080x3008', 1], ['883:1211', '4K', '2240x3072', 1],
    ];
    assert.equal(historical.reduce((sum, item) => sum + item[3], 0), 119);
    for (const [ratio, tier, size] of historical) assert.equal(ratios.studioRatioSize(ratio, tier, true, 1), size);
    checks.push('legacy_119_frozen_specifications_unchanged');
    for (const ratio of ratios.STUDIO_RATIOS) for (const tier of ['1K', '2K', '4K']) {
      assert.equal(ratios.studioRatioSize(ratio, tier), ratios.studioRatioSize(ratio, tier, true, 1));
    }
    assert.equal(ratios.STUDIO_RATIOS.length, 16);
    checks.push('standard_16_ratios_48_tiers_unchanged');
    for (const [ratio, tier, expected] of [['58:77', '2K', '1760x2336'], ['444:601', '4K', '2400x3248'],
      ['744:1049', '4K', '2384x3360'], ['82:111', '4K', '2400x3248']]) {
      assert.equal(ratios.studioRatioSize(ratio, tier), expected);
      assert.equal(resolution.imageOutputSize('gpt-image-2', tier, ratio, 'ai_media_vip'), expected);
    }
    checks.push('fine_ratio_four_expected_dimensions');
    for (let numerator = 100; numerator <= 900; numerator++) for (const tier of ['1K', '2K', '4K']) {
      const ratio = ratios.normalizeStudioRatio(`${numerator}:300`);
      const [width, height] = ratios.studioRatioSize(ratio, tier)!.split('x').map(Number);
      assert.ok(resolution.isValidImageDimension(`${width}x${height}`, true));
      if (ratios.STUDIO_RATIOS.includes(ratio)) continue;
      const [rw, rh] = ratio.split(':').map(Number), edge = tier === '4K' ? 3840 : tier === '2K' ? 2880 : 2048;
      const budget = tier === '4K' ? 8294400 : tier === '2K' ? 4194304 : 1048576;
      let maximum = 0;
      for (let w = 16; w <= edge; w += 16) {
        const h = Math.round(w * rh / rw / 16) * 16, area = w * h;
        if (h >= 512 && h <= edge && area >= 655360 && area <= budget && w / h <= 3 && h / w <= 3) maximum = Math.max(maximum, area);
      }
      assert.ok(width * height * 100 >= maximum * 95);
    }
    checks.push('boundary_2403_same_candidates_area_band');
    assert.equal(ratios.studioRatioSize('auto'), undefined);
    assert.equal(ratios.normalizeStudioRatio(' 1.16 / 1.54 '), '58:77');
    assert.equal(ratios.normalizeStudioRatio('7:3'), '21:9');
    assert.equal(ratios.studioRatioSize('4:1', '4K'), '3840x960');
    assert.equal(ratios.studioRatioSize('1:3', '4K'), '1280x3840');
    assert.throws(() => ratios.studioRatioSize('4:1', '4K', false));
    for (const ratio of ['0:1', '1:0', '1:4', '3.01:1', 'invalid', '', '1.001:1']) assert.throws(() => ratios.studioRatioSize(ratio));
    assert.deepEqual(ratios.resolveStudioAspectRatio('auto', { width: 1160, height: 1540 }), { requested: 'auto', resolved: '58:77', source: 'reference' });
    assert.throws(() => ratios.resolveStudioAspectRatio('auto', { width: 0, height: 0 }, true, true));
    assert.equal(ratios.studioRatioSize('1:1', '0.5K'), '512x512');
    assert.equal(resolution.isValidImageDimension('512x512'), false);
    checks.push('auto_decimal_invalid_four_to_one_half_k_boundaries');

    const api = { ...integration.DEFAULT_IMAGE_GENERATION_API_SETTINGS, enabled: true, provider: 'ai_media_vip' as const,
      default_model: 'gpt-image-2', base_url: 'https://fixture.invalid/v1/', api_key: 'synthetic-not-a-credential' };
    assert.equal(integration.imageGenerationModelOutputSize(api, 'gpt-image-2', '2K', '58:77'), '1760x2336');
    assert.equal(integration.imageGenerationModelOutputSize(api, 'gpt-image-2', '2K', '58:77', 1), '928x1232');
    const nativeApi = { ...api, managedChannel: true, modelCapabilities: { 'gemini-nano-banana-2.1': { protocol: 'gemini_native' } } };
    for (const version of [1, 2] as const) assert.equal(integration.imageGenerationModelOutputSize(nativeApi, 'gemini-nano-banana-2.1', '2K', '58:77', version), '2K');
    assert.throws(() => integration.imageGenerationModelOutputSize(api, 'gemini-3.1-flash-image-preview', '0.5K', '1:1'));
    checks.push('shared_pixel_and_native_adapters_preserve_capabilities');

    const owner = 'size-policy-fixture-owner', moduleId = randomUUID();
    await db.user.create({ data: { id: owner, name: 'Size fixture', username: owner, email: `${owner}@fixture.invalid`,
      password_hash: 'synthetic-not-a-login', role: 'admin', account_type: 'internal' } });
    const settings = await import('../src/lib/image-studio/settings');
    await db.platformSetting.create({ data: { key: settings.IMAGE_STUDIO_SETTING_KEY, value_json: JSON.stringify({
      model: 'gpt-image-2', revision: 0, context: '', prices: { ...settings.DEFAULT_STUDIO_PRICES, 'gpt-image-2': 0 } }) } });
    await db.platformSetting.create({ data: { key: integration.IMAGE_GENERATION_API_SETTING_KEY, value_json: JSON.stringify(api) } });
    await db.imageStudioModule.create({ data: { id: moduleId, owner_id: owner, name: 'Size fixture', model: 'gpt-image-2', quality: 'medium', resolution: '2K' } });
    const tasks = await import('../src/lib/image-studio/tasks');
    const batches = await import('../src/lib/image-studio/batches');
    const quotes = await import('../src/lib/image-studio/billing-quote-store');
    const batchQuotes = await import('../src/lib/image-studio/batch-billing-quote');
    const quoteService = await import('../src/lib/image-studio/billing-quote-service');
    const body = { requestId: randomUUID(), moduleId, prompt: 'Synthetic size fixture', count: 1, revision: 0,
      referenceIds: [], model: 'gpt-image-2', quality: 'medium', resolution: '2K', aspectRatio: '58:77' };
    const prepared: Prisma.ImageStudioTaskUncheckedCreateInput[] = [];
    const capture = (version?: 1 | 2) => ({ ...(version ? { sizePolicyVersion: version } : {}),
      save: async (_tx: Prisma.TransactionClient, data: Prisma.ImageStudioTaskUncheckedCreateInput) => { prepared.push(data); } });
    await tasks.submitStudioBatch(owner, { ...body, sizePolicyVersion: 1 }, undefined, capture());
    const fresh = prepared.pop()!; assert.equal(fresh.output_size, '1760x2336');
    assert.equal(JSON.parse(String(fresh.snapshot_json)).sizePolicyVersion, 2);
    await tasks.submitStudioBatch(owner, body, undefined, capture(1));
    const old = prepared.pop()!; assert.equal(old.output_size, '928x1232');
    assert.equal(JSON.parse(String(old.snapshot_json)).inputFingerprint, JSON.parse(String(fresh.snapshot_json)).inputFingerprint);
    assert.equal(tasks.parseStudioRequest({ ...body, sizePolicyVersion: 1 }).requestId, body.requestId);
    assert.ok(!('sizePolicyVersion' in tasks.parseStudioRequest({ ...body, sizePolicyVersion: 1 })));
    await quoteService.prepareImageBillingQuote(owner, body);
    checks.push('server_only_preparation_version_no_fingerprint_migration');

    const oldRequestId = randomUUID(), oldId = sha(`${owner}:${oldRequestId}`), oldKey = `studio_batch_v1:${owner}:${oldId}`;
    const oldSnapshot = JSON.parse(String(old.snapshot_json)); delete oldSnapshot.sizePolicyVersion;
    const frozen = { ...old, id: `${oldId}-1-a0`, batch_id: oldId, snapshot_json: JSON.stringify(oldSnapshot) };
    const frozenBytes = JSON.stringify(frozen);
    await db.platformSetting.create({ data: { key: `studio_batch_item_v1:${oldId}:1`, value_json: frozenBytes } });
    for (const [ordinal, status] of [[2, 'running'], [3, 'uncertain']] as const) {
      await db.imageStudioTask.create({ data: { ...old, id: `${oldId}-${ordinal}-a0`, batch_id: oldId, ordinal,
        status, snapshot_json: JSON.stringify(oldSnapshot) } });
    }
    const acceptedBefore = await db.imageStudioTask.findMany({ where: { batch_id: oldId }, orderBy: { ordinal: 'asc' } });
    const parent = { version: 1, id: oldId, ownerId: owner, requestId: oldRequestId, fingerprint: 'synthetic-legacy-fingerprint',
      moduleId, moduleName: 'Size fixture', state: 'blocked', note: '', createdAt: new Date().toISOString(), total: 4,
      budget: 0, committedCredits: 0, unitCredits: 0, prepared: 3, input: { ...body, requestId: oldRequestId },
      items: [1, 2, 3, 4].map(ordinal => ({ ordinal, sourceName: `Synthetic ${ordinal}`, taskId: ordinal === 2 || ordinal === 3 ? `${oldId}-${ordinal}-a0` : null,
        attempt: 0, prepared: ordinal < 4, cancelled: false })) };
    await db.platformSetting.create({ data: { key: oldKey, value_json: JSON.stringify(parent) } });
    await batches.updateStudioBatch(owner, { id: oldId, action: 'prepare' });
    const continued = JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: { key: oldKey } })).value_json);
    assert.equal(continued.state, 'ready'); assert.equal(continued.sizePolicyVersion, undefined);
    assert.equal((await db.platformSetting.findUniqueOrThrow({ where: { key: `studio_batch_item_v1:${oldId}:1` } })).value_json, frozenBytes);
    const newOldChild = JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: { key: `studio_batch_item_v1:${oldId}:4` } })).value_json);
    assert.equal(newOldChild.output_size, '928x1232'); assert.equal(JSON.parse(newOldChild.snapshot_json).sizePolicyVersion, 1);
    assert.deepEqual(await db.imageStudioTask.findMany({ where: { batch_id: oldId }, orderBy: { ordinal: 'asc' } }), acceptedBefore);
    checks.push('old_parent_partial_prepared_accepted_uncertain_frozen_v1');

    const newBody = { ...body, requestId: randomUUID(), sources: [{ name: 'Synthetic one' }, { name: 'Synthetic two' }], budget: 0 };
    const newId = await batches.createStudioBatch(owner, newBody);
    const newKey = `studio_batch_v1:${owner}:${newId}`;
    const newParent = JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: { key: newKey } })).value_json);
    assert.equal(newParent.sizePolicyVersion, 2); assert.equal(newParent.state, 'ready');
    for (const ordinal of [1, 2]) assert.equal(JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: {
      key: `studio_batch_item_v1:${newId}:${ordinal}` } })).value_json).output_size, '1760x2336');
    const acceptedParent = (await db.platformSetting.findUniqueOrThrow({ where: { key: newKey } })).value_json;
    assert.equal(await batches.createStudioBatch(owner, { ...newBody, batchQuoteId: randomUUID() }), newId);
    assert.equal((await db.platformSetting.findUniqueOrThrow({ where: { key: newKey } })).value_json, acceptedParent);
    checks.push('new_v2_parent_and_original_parent_receipt_before_quote_gate');

    const quoteId = randomUUID(), imageQuoteKey = quotes.imageQuoteKey(owner, quoteId);
    const contract = JSON.parse(String(old.billing_contract_json));
    const oldQuote = JSON.stringify({ owner, count: 1, fingerprint: contract.specification, intentRevision: 0, contract });
    await db.platformSetting.create({ data: { key: imageQuoteKey, value_json: oldQuote } });
    await assert.rejects(db.$transaction(tx => quotes.consumeImageQuote(tx, { owner, id: quoteId, count: 1,
      fingerprint: contract.specification, specification: contract.specification, scope: contract.scope, model: contract.model })), /size policy/);
    assert.equal((await db.platformSetting.findUniqueOrThrow({ where: { key: imageQuoteKey } })).value_json, oldQuote);
    await db.imageStudioTask.create({ data: { ...fresh, status: 'uncertain' } });
    const taskBefore = await db.imageStudioTask.findUniqueOrThrow({ where: { id: String(fresh.id) } });
    assert.equal(await tasks.submitStudioBatch(owner, { ...body, billingQuoteId: quoteId, sizePolicyVersion: 1 }), fresh.batch_id);
    assert.deepEqual(await db.imageStudioTask.findUniqueOrThrow({ where: { id: String(fresh.id) } }), taskBefore);
    assert.equal((await db.platformSetting.findUniqueOrThrow({ where: { key: imageQuoteKey } })).value_json, oldQuote);
    checks.push('accepted_original_request_receipt_precedes_old_quote_gate');
    const batchQuoteId = randomUUID(), batchQuoteKey = `image_batch_billing_quote_v1:${owner}:${batchQuoteId}`;
    const oldBatchQuote = JSON.stringify({ owner, contracts: [contract], fingerprint: 'synthetic' });
    await db.platformSetting.create({ data: { key: batchQuoteKey, value_json: oldBatchQuote } });
    await assert.rejects(db.$transaction(tx => batchQuotes.consumeBatchQuote(tx, owner, { batchQuoteId })), error => error instanceof tasks.StudioError && error.status === 409);
    assert.equal((await db.platformSetting.findUniqueOrThrow({ where: { key: batchQuoteKey } })).value_json, oldBatchQuote);
    const continuation = { batchId: newId, recordDigest: sha(acceptedParent) };
    const boundQuote = JSON.stringify({ owner, sizePolicyVersion: 2, continuation });
    await db.platformSetting.update({ where: { key: batchQuoteKey }, data: { value_json: boundQuote } });
    await assert.rejects(db.$transaction(tx => batchQuotes.consumeBatchQuote(tx, owner, { batchQuoteId })), /未受理条目已变化/);
    await assert.rejects(db.$transaction(tx => batchQuotes.consumeBatchQuote(tx, owner, { batchQuoteId }, { ...continuation, recordDigest: 'stale' })), /未受理条目已变化/);
    assert.equal((await db.platformSetting.findUniqueOrThrow({ where: { key: batchQuoteKey } })).value_json, boundQuote);
    assert.equal(await db.creditLedger.count(), 0); assert.equal(await db.creditAccount.count(), 0);
    checks.push('old_quotes_and_stale_continuation_rejected_without_consumption_or_reservation');

    // Evaluate the production private parser directly: no storage mutation or
    // copy of its version rules may stand in for this compatibility assertion.
    const batchSource = readFileSync(path.join(root, 'src/lib/image-studio/batches.ts'), 'utf8');
    const source = ts.createSourceFile('batches.ts', batchSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declaration = source.statements.flatMap(statement => ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.filter(item => ts.isIdentifier(item.name) && item.name.text === 'parse') : [])[0];
    assert.ok(declaration?.initializer);
    const parser = vm.runInNewContext(ts.transpileModule(`(${declaration.initializer.getText(source)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, { StudioError: tasks.StudioError }) as (json: string) => Record<string, unknown>;
    assert.equal(parser(JSON.stringify(parent)).sizePolicyVersion, undefined);
    assert.equal(parser(JSON.stringify({ ...parent, sizePolicyVersion: 1 })).sizePolicyVersion, 1);
    assert.equal(parser(JSON.stringify({ ...parent, sizePolicyVersion: 2 })).sizePolicyVersion, 2);
    for (const version of [0, 3, '1', null, {}, []]) assert.throws(() => parser(JSON.stringify({ ...parent, sizePolicyVersion: version })));
    checks.push('parent_parser_rejects_unknown_versions_without_read_backfill');

    // The private reconfirmation command is executed with real isolated CAS and
    // item rows. Only current shared-definition/worker readiness are supplied as
    // synthetic dependencies, so this never needs a running worker or supplier.
    const selectedNames = ['assertUnacceptedBatchPricing', 'invalidateUnacceptedDefinition', 'reconfirmBatchDefinition', 'writeBatch'];
    const selected = selectedNames.map(name => {
      const node = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
      assert.ok(node, `Missing production declaration ${name}`); return node.getText(source);
    }).join('\n');
    const sharedLive = { protocol: 'shared-live-v1', presetId: `module-source:${moduleId}`, definitionToken: 'synthetic-new-definition' };
    const actualSettings = await settings.getImageStudioSettings();
    const sharedUse = { definition: { intent: sharedLive, name: 'Synthetic current definition' } };
    const moduleContract = await import('../src/lib/image-studio/modules');
    const pricing = await import('../src/lib/pricing/image');
    const readiness = await import('../src/lib/image-studio/billing-readiness');
    const scope = await import('../src/lib/image-studio/billing-scope');
    const precision = await import('../src/lib/credits/precision');
    const engine: Record<string, any> = { exports: {}, CURRENT_STUDIO_SIZE_POLICY_VERSION: 2, StudioError: tasks.StudioError,
      SharedStudioDefinitionError: tasks.SharedStudioDefinitionError, ITEM_PREFIX: 'studio_batch_item_v1:',
      CHANNEL_ITEM_PREFIX: 'studio_channel_batch_item_v1:', PRICING_BATCH_ITEM_PREFIX: 'pricing_image_batch_item_v1:',
      IMAGE_25_QUALITY_MODEL: 'gpt-image-2.5', continuationInput: batches.continuationInput, parseStudioRequest: tasks.parseStudioRequest,
      boundedBudget: (value: unknown) => typeof value === 'number' && value >= 0,
      resolveOwnedStudioTaskSharedUse: async () => sharedUse, assertSharedStudioWorkerReady: async () => {},
      getImageStudioSettings: async () => actualSettings,
      studioSharedGenerationSource: () => ({ model: 'gpt-image-2', quality: 'medium', resolution: '2K', aspectRatio: '58:77' }),
      resolveStudioModuleGenerationConfig: moduleContract.resolveStudioModuleGenerationConfig,
      resolveImageGenerationRequestChannel: async () => 'original',
      getImageGenerationSettingsForModel: integration.getImageGenerationSettingsForModel,
      normalizeImageResolution: resolution.normalizeImageResolution, withImagePricing: pricing.withImagePricing,
      samePricingImageCharge: pricing.samePricingImageCharge,
      imageBillingReady: readiness.imageBillingReady, imageBillingScope: scope.imageBillingScope,
      assertBudgetVersion: () => {}, addCredits: precision.addCredits, sumCredits: precision.sumCredits,
      isChannelBatch: () => false,
      key: (actor: string, id: string) => `studio_batch_v1:${actor}:${id}`,
    };
    vm.runInNewContext(ts.transpileModule(`${selected}\nexports.reconfirm = reconfirmBatchDefinition; exports.write = writeBatch; exports.invalidate = invalidateUnacceptedDefinition;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, engine);
    const originalAcceptedBytes = JSON.stringify(await db.imageStudioTask.findMany({ where: { batch_id: oldId }, orderBy: { ordinal: 'asc' } }));
    const oldReadyRecord = (await db.platformSetting.findUniqueOrThrow({ where: { key: oldKey } })).value_json;
    const originalContracts = [1, 2, 3, 4].map(ordinal => ({ ...contract, specification: sha(`synthetic-original-contract-${ordinal}`) }));
    const replacementContracts = [1, 4].map(ordinal => ({ ...contract, specification: sha(`synthetic-new-contract-${ordinal}`) }));
    for (const withQuote of [false, true]) {
      const original = { ...JSON.parse(oldReadyRecord), billingMode: 'fixed', billingContracts: originalContracts };
      await db.platformSetting.update({ where: { key: oldKey }, data: { value_json: JSON.stringify(original) } });
      const staleParentRow = await db.platformSetting.findUniqueOrThrow({ where: { key: oldKey } });
      await db.$transaction(async tx => {
        const row = await tx.platformSetting.findUniqueOrThrow({ where: { key: oldKey } });
        const batch = JSON.parse(row.value_json);
        await engine.exports.invalidate(tx, batch, 'Synthetic definition changed');
        assert.deepEqual(batch.billingContracts, [null, originalContracts[1], originalContracts[2], null]);
        await engine.exports.write(tx, row, batch);
      });
      const invalidated = await db.platformSetting.findUniqueOrThrow({ where: { key: oldKey } });
      assert.deepEqual(JSON.parse(invalidated.value_json).billingContracts, [null, originalContracts[1], originalContracts[2], null]);
      const currentQuoteId = randomUUID();
      // Current quote issuance is a synthetic dependency here; actual quote
      // version/continuation rejection is exercised against real storage above.
      engine.continuationBinding = (id: string, json: string) => ({ batchId: id, recordDigest: sha(json) });
      engine.consumeBatchQuote = async (_tx: unknown, actor: string, value: Record<string, unknown>, binding: Record<string, unknown>) => {
        assert.equal(actor, owner); assert.equal(value.batchQuoteId, currentQuoteId);
        assert.deepEqual(binding, { batchId: oldId, recordDigest: sha(invalidated.value_json) });
        return { mode: 'fixed', contracts: replacementContracts, unitCredits: 0, total: 0, sizePolicyVersion: 2 };
      };
      await db.$transaction(async tx => {
        const row = await tx.platformSetting.findUniqueOrThrow({ where: { key: oldKey } });
        const batch = JSON.parse(row.value_json);
        await engine.exports.reconfirm(tx, batch, { id: oldId, sharedLive, budget: 0,
          ...(withQuote ? { batchQuoteId: currentQuoteId } : {}) }, row);
        await engine.exports.write(tx, row, batch);
      });
      const reconfirmed = JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: { key: oldKey } })).value_json);
      assert.equal(reconfirmed.sizePolicyVersion, 2); assert.equal(reconfirmed.state, 'preparing');
      assert.equal(reconfirmed.input.sharedLive.definitionToken, sharedLive.definitionToken);
      assert.deepEqual(reconfirmed.billingContracts, [withQuote ? replacementContracts[0] : null,
        originalContracts[1], originalContracts[2], withQuote ? replacementContracts[1] : null]);
      assert.equal(reconfirmed.items[1].taskId, `${oldId}-2-a0`); assert.equal(reconfirmed.items[2].taskId, `${oldId}-3-a0`);
      assert.equal(reconfirmed.items[0].prepared, false); assert.equal(reconfirmed.items[3].prepared, false);
      assert.equal(await db.platformSetting.count({ where: { key: { in: [`studio_batch_item_v1:${oldId}:1`, `studio_batch_item_v1:${oldId}:4`] } } }), 0);
      assert.equal(JSON.stringify(await db.imageStudioTask.findMany({ where: { batch_id: oldId }, orderBy: { ordinal: 'asc' } })), originalAcceptedBytes);
      await assert.rejects(db.$transaction(tx => engine.exports.write(tx, staleParentRow, reconfirmed)), /批次已在其他页面更新/);
      if (!withQuote) {
        // Real preparation must allow current fixed requests even though the
        // array still retains older accepted/unknown contracts at other slots.
        const unquoted = { ...reconfirmed, input: original.input, state: 'blocked', definitionConfirmationRequired: false };
        await db.platformSetting.update({ where: { key: oldKey }, data: { value_json: JSON.stringify(unquoted) } });
        await batches.updateStudioBatch(owner, { id: oldId, action: 'prepare' });
        const preparedParent = JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: { key: oldKey } })).value_json);
        assert.equal(preparedParent.state, 'ready');
        assert.deepEqual(preparedParent.billingContracts, [null, originalContracts[1], originalContracts[2], null]);
        for (const ordinal of [1, 4]) assert.equal(JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: {
          key: `studio_batch_item_v1:${oldId}:${ordinal}` } })).value_json).output_size, '1760x2336');
      }
    }
    assert.equal(await db.creditLedger.count(), 0);
    checks.push('explicit_reconfirmation_migrates_only_safe_unaccepted_items_in_cas_transaction');
    assert.equal(forbiddenCalls, 0); completed = true;
  } finally {
    mock.restoreAll(); await db.$disconnect(); process.chdir(root);
    for (const [file, digest] of Object.entries(sourceSha256)) assert.equal(sha(readFileSync(path.join(root, file))), digest);
    const receipt = path.join(directory, 'receipt.json');
    writeFileSync(receipt, JSON.stringify({ schema: 'image-size-policy-engineering.v1', synthetic: true, runId, startedAt,
      finishedAt: new Date().toISOString(), completed, checks, fixtureSha256, sourceSha256, forbiddenCalls,
      productionWrites: 0, paidRequests: 0, browserRuns: 0, databasePath, serverOnlyMarker,
      serverOnlyMarkerSha256: sha(readFileSync(serverOnlyMarker)) }, null, 2), { mode: 0o600, flag: 'wx' });
    assert.equal(lstatSync(receipt).mode & 0o777, 0o600); process.umask(previousUmask);
    if (completed) console.log(`Image size policy engineering receipt: ${receipt}`);
  }
}

void main().then(() => { process.exitCode = 0; }).catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => clearTimeout(deadline));
