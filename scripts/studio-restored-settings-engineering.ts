import './server-runtime.cjs';
import assert from 'node:assert/strict';
import * as privatePrompts from '../src/lib/security/private-prompts.server';
import * as privateFields from '../src/lib/security/private-prompt-fields.server';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as restoredContract from '../src/lib/image-studio/restored-settings';
import { isEncryptedStudioPersonalPrompt } from '../src/lib/image-studio/personal-prompt';
import { serverStudioPersonalPromptProjection } from '../src/lib/image-studio/personal-prompt.server';
import * as taskSettingsContract from '../src/lib/image-studio/task-settings';
import { CURRENT_STUDIO_SIZE_POLICY_VERSION } from '../src/lib/image-studio/ratios';
import { normalizeImageFeishuChoice } from '../src/lib/image-studio/feishu-contract';
import { historicalStudioStyles } from '../src/lib/image-studio/style-history';

// This fixture evaluates selected production declarations with synthetic dependencies.
// It never imports the application database, provider, worker, or HTTP modules.
async function main() {
  const root = realpathSync(process.cwd());
  assert.equal(process.env.PRIVATE_PROMPTS_POLICY_FILE, undefined, 'Legacy restoration fixture must not load an external policy');
  const destination = path.resolve(process.argv[2] || '');
  assert.ok(destination.startsWith(path.join(root, '.role-tests') + path.sep));
  const files = ['src/lib/image-studio/restored-settings.ts', 'src/lib/image-studio/tasks.ts',
    'src/lib/image-studio/task-settings.ts', 'src/lib/image-studio/task-settings-storage.ts', 'src/lib/image-studio/skills.ts',
    'src/lib/image-studio/private-storage.server.ts', 'src/lib/security/private-prompts.server.ts',
    'src/lib/security/private-prompt-fields.server.ts', 'scripts/server-runtime.cjs',
    'src/lib/image-studio/billing-quote-service.ts', 'src/lib/image-studio/batch-billing-quote.ts',
    'src/lib/image-studio/batches.ts', 'src/lib/image-studio/ratios.ts', 'scripts/studio-restored-settings-engineering.ts'];
  files.push('src/lib/image-studio/feishu-contract.ts', 'src/lib/video/feishu-contract.ts', 'src/lib/image-studio/style-history.ts');
  files.push('src/lib/image-studio/personal-prompt.ts', 'src/lib/image-studio/personal-prompt.server.ts');
  const sources = new Map(files.map(file => [file, readFileSync(path.join(root, file), 'utf8')]));
  const declarations = (file: string, names: string[]) => {
    const text = sources.get(file) ?? readFileSync(path.join(root, file), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    return names.map(name => {
      const node = source.statements.find(statement => (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
        ? statement.name?.text === name : ts.isVariableStatement(statement)
          && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name));
      assert.ok(node, `Missing production declaration ${file}:${name}`);
      return node.getText(source);
    }).join('\n');
  };
  const checks: string[] = [];
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const owner = 'synthetic-owner', moduleId = '11111111-1111-4111-8111-111111111111';
  const styleId = '22222222-2222-4222-8222-222222222222', changedStyleId = '33333333-3333-4333-8333-333333333333';
  const skillId = '44444444-4444-4444-8444-444444444444';
  const presetId = `module-source:${moduleId}`;
  const marker = { protocol: 'task-settings-v1' as const, sourceTaskId: 'synthetic-source-task' };
  const intent = { protocol: 'shared-live-v1', presetId, definitionToken: 'synthetic-current-definition' };
  const policy = { primaryIds: ['current-main'], primaryMin: 0, primaryMax: 1, auxiliaryMax: 9, styleMax: 10, referenceMax: 10, useFixedReferences: true };
  const oldSkillPrompt = 'synthetic-old-skill';
  const oldSkill = { id: skillId, ownerId: owner, name: 'Old skill', prompt: oldSkillPrompt,
    promptVersion: createHash('sha256').update(oldSkillPrompt).digest('hex') };
  const currentSkillPrompt = 'synthetic-current-skill';
  const currentSkillVersion = createHash('sha256').update(currentSkillPrompt).digest('hex');
  const sourceSnapshot = {
    moduleId, sourcePresetId: null, globalContext: 'synthetic-historical-global', moduleContext: 'synthetic-historical-module',
    prompt: 'synthetic-legacy-personal', referencePolicy: { ...policy, primaryIds: ['source-main'] },
    fixedReferenceImages: [{ id: 'template-fixed', note: 'old fixed note' }, { id: 'style-old', note: 'old style image note' }],
    templateFixedCount: 1, styleGroupIds: [styleId],
    styleGroups: [{ id: styleId, name: 'Old style', revision: 2, referenceCount: 1, ownerId: owner, note: 'old group note' }],
    skills: [oldSkill], skillIds: [skillId],
    referenceImages: [{ id: 'source-main', referenceRole: 'primary' }, { id: 'template-fixed', hash: 'hash-template-fixed' },
      { id: 'style-old', hash: 'hash-style-old' }],
    authorizedReferenceOwners: { 'template-fixed': owner, 'style-old': owner },
  };
  let historical: Record<string, unknown> = plain(sourceSnapshot);
  let deleted = false, sourceOwner = owner, sourceReads = 0;
  let priorPresetOwner = owner, priorArchived = false;
  let accepted: Record<string, unknown> | null = null;
  const created: Record<string, unknown>[] = [];
  const specificationInputs: Record<string, unknown>[] = [];
  const user = { id: owner, role: 'admin', account_type: 'internal', status: 'active' };
  const workspace = { id: moduleId, owner_id: owner, name: 'Synthetic workspace', source_preset_id: presetId,
    revision: 7, model: 'gpt-image-1', quality: 'medium', resolution: '1K', prompt: 'must-not-use-current-template-prompt', context: 'must-not-use-current-context' };
  const settings = { revision: 1, model: 'gpt-image-1', quality: 'medium', resolution: '1K', context: 'must-not-use-current-global', prices: { 'gpt-image-1': 0 } };
  const currentStyles = new Map([
    [styleId, { id: styleId, ownerId: owner, name: 'Current style', revision: 3, note: 'must-not-use-current-note', references: [{ assetId: 'style-new', note: 'new note' }] }],
    [changedStyleId, { id: changedStyleId, ownerId: owner, name: 'Changed style', revision: 4, note: 'changed note', references: [{ assetId: 'style-new', note: 'selected note' }] }],
  ]);
  const assets = new Map(['source-main', 'current-main', 'current-main-two', 'template-fixed', 'style-old', 'style-new',
    'historical-template-reference', 'current-template-reference'].map(id => [id, { id, owner_id: owner,
    original_url: `/synthetic/${id}`, thumbnail_url: null, file_name: id, mime_type: 'image/png', width: 1024, height: 1024,
    file_size: 100, hash: `hash-${id}`, status: 'active', type: 'image' }]));
  const assetRows = (where: { id?: { in: string[] }; owner_id?: string }) => Array.from(assets.values()).filter(asset =>
    (!where.id || where.id.in.includes(asset.id)) && (!where.owner_id || where.owner_id === asset.owner_id));
  const tx = {
    imageStudioTask: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.batch_id) return accepted;
        sourceReads++;
        assert.equal(where.id, marker.sourceTaskId); assert.equal(where.owner_id, owner); assert.equal(where.deleted_at, null);
        return deleted || sourceOwner !== owner ? null : { id: marker.sourceTaskId, owner_id: sourceOwner, module_id: moduleId,
          prompt: 'synthetic-legacy-personal', context: 'synthetic-historical-global\nsynthetic-historical-module',
          source_preset_id: null, snapshot_json: JSON.stringify(historical) };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => { created.push(plain(data)); return { ...data, created_at: new Date(0) }; },
    },
    user: { findUnique: async () => user },
    imageStudioModule: { findFirst: async ({ where }: { where: Record<string, unknown> }) => where.id === moduleId && where.owner_id === owner ? workspace : null },
    imageStudioPreset: { findUnique: async ({ where }: { where: { id: string } }) => where.id === presetId ? { owner_id: owner, scope: 'creator', is_shared: true }
      : where.id === 'synthetic-prior-preset' ? { owner_id: priorPresetOwner, scope: 'creator', is_shared: true } : null },
    asset: { count: async ({ where }: { where: Parameters<typeof assetRows>[0] }) => assetRows(where).length,
      findMany: async ({ where }: { where: Parameters<typeof assetRows>[0] }) => assetRows(where) },
    platformSetting: { findUnique: async () => null },
  };
  const prisma = { ...tx, $transaction: async (run: (client: typeof tx) => unknown) => run(tx) };
  const shared = { binding: { ownerId: owner, presetId, mode: 'publisher' }, personalOverrides: {},
    definition: { intent, sourceOwnerId: owner, sourceRevision: 'synthetic-revision', name: 'Synthetic shared',
      templatePrompt: 'must-not-use-current-template-prompt', context: 'must-not-use-current-module',
      generationDefaults: { model: 'gpt-image-1', quality: 'medium', resolution: '1K', aspectRatio: '1:1', count: 1 },
      fixedReferences: [], styleGroupIds: [], styleGroups: [], templateReferenceIds: ['current-template-reference'], referencePolicy: policy } };
  const channel = { channelId: 'original', configRevision: '55555555-5555-4555-8555-555555555555' };
  const api = { provider: 'openai', modelCapabilities: {}, supports_text_to_image: true, supports_image_to_image: true };
  let forbiddenCalls = 0;
  const storageExports: Record<string, any> = {};
  const storageImports: Record<string, unknown> = { 'server-only': {}, '@/lib/security/private-prompts.server': privatePrompts,
    '@/lib/security/private-prompt-fields.server': privateFields,
    '@/lib/security/private-prompt-request.server': { requirePrivatePromptRequest: async () => { forbiddenCalls++; throw new Error('Unexpected private editing in legacy restore fixture'); } } };
  vm.runInNewContext(ts.transpileModule(sources.get('src/lib/image-studio/private-storage.server.ts')!, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports: storageExports, require: (name: string) => {
    assert.ok(Object.hasOwn(storageImports, name), `Unexpected private storage dependency: ${name}`); return storageImports[name];
  } });
  const sandbox: Record<string, any> = { exports: {}, createHash, randomUUID, ...restoredContract, ...taskSettingsContract, CURRENT_STUDIO_SIZE_POLICY_VERSION,
    isEncryptedStudioPersonalPrompt, serverStudioPersonalPromptProjection,
    assertStudioRequestWritable: async () => {}, markStudioSubmitFailure: () => {},
    ...storageExports, ...privateFields, ...privatePrompts, normalizeImageFeishuChoice, historicalStudioStyles,
    freezeImageFeishuChoice: async (_tx: unknown, _owner: unknown, choice: unknown) => { assert.equal(choice, undefined); return null; },
    enqueueFrozenImageFeishuNotification: async (_tx: unknown, _task: unknown, choice: unknown) => { assert.equal(choice, null); },
    MAX_REFERENCE_IMAGES: 10, DEFAULT_STUDIO_PRIMARY_MAX: 1, MAX_STYLE_GROUP_NOTE_LENGTH: 8000,
    IMAGE_STUDIO_MODELS: ['gpt-image-1'], IMAGE_STUDIO_MODEL_QUALITY_OPTIONS: { 'gpt-image-1': ['medium'] },
    IMAGE_STUDIO_MODEL_COST_USD: { 'gpt-image-1': 0 }, IMAGE_RESOLUTION_OPTIONS: ['1K'], IMAGE_25_QUALITY_MODEL: 'synthetic-other-model',
    prisma, parseUsageProjectId: (value: unknown) => value, creditCents: (value: number) => Math.round(value * 100),
    addCredits: (left: number, right: number) => left + right, sumCredits: (values: number[]) => values.reduce((a, b) => a + b, 0),
    parseSharedStudioPersonalOverrides: (value: unknown) => plain(value), parseEvolution: () => undefined,
    normalizeStudioRatio: (value: string) => value, parseImageQualityRouteSnapshot: () => null,
    defaultStudioModuleId: () => 'synthetic-default-module', validStudioModuleId: (id: string) => id === moduleId,
    getImageStudioSettings: async () => settings, withContextVersionRetry: (run: () => unknown) => run(),
    assertNoSynchronousImageAdmission: async () => {}, assertUsageProject: async () => {}, canUseCompanyTemplates: () => true,
    canViewStudioPreset: (_actor: unknown, preset: { owner_id: string; is_shared: boolean }) => preset.owner_id === owner || preset.is_shared,
    resolveStudioTaskSharedUse: async (_actor: unknown, _module: unknown, supplied: unknown) => { assert.deepEqual(plain(supplied), intent); return shared; },
    assertSharedStudioWorkerReady: async () => {},
    readStudioWorkspaceSource: async () => null,
    studioPresetArchived: async (id: string) => id === 'synthetic-prior-preset' && priorArchived,
    resolveStudioModuleGenerationConfig: (source: Record<string, unknown>) => ({ ...source, prices: settings.prices }),
    resolveImageGenerationRequestChannel: async () => 'original', getImageGenerationSettingsForModel: async () => api,
    captureImageGenerationChannel: async () => channel, resolveImageGenerationChannelSnapshot: async () => api,
    withImagePricing: async (value: unknown) => ({ settings: value, quote: null }), imageBillingScope: () => 'synthetic-scope',
    isMuskImageGenerationChannel: () => false, imageBillingReady: async () => ({ ready: false }),
    isStudioImageGenerationProvider: () => true, isImageGenerationApiReady: () => true,
    resolveStudioStyleReferences: async (_actor: unknown, ids: string[]) => {
      const groups = ids.map(id => { const group = currentStyles.get(id); if (!group) throw Object.assign(new Error('synthetic inaccessible style'), { status: 403 }); return group; });
      return { groups, references: groups.flatMap(group => group.references) };
    },
    getSkill: async (_actor: unknown, id: string) => { assert.equal(id, skillId); return { ...oldSkill, prompt: currentSkillPrompt, promptVersion: currentSkillVersion }; },
    studioVisibleAssetWhere: async () => ({}), evolutionCapability: () => null,
    assertImageQualityReferenceCount: () => {}, imageGenerationSupportsStudioFourToOne: () => true,
    resolveStudioAspectRatio: (ratio: string) => ({ requested: ratio, resolved: ratio, source: 'explicit' }), studioFourToOneIssue: () => null,
    normalizeImageResolution: (_model: unknown, resolution: string) => resolution,
    imageGenerationModelOutputSize: () => '1024x1024', bindModuleContextVersion: async () => 'synthetic-context-version',
    MODULE_CONTEXT_VERSION_RULE: 'synthetic', studioTemplateAssetUrl: (id: string, thumb = false) => `/protected/${id}${thumb ? '?thumbnail=1' : ''}`,
    imageSpecification: (value: Record<string, unknown>) => { specificationInputs.push(plain(value)); return JSON.stringify(value); },
    fixedImageBillingContract: (value: Record<string, unknown>) => ({ ...value, authorizedCredits: value.credits, mode: 'fixed', expiresAt: '2099-01-01T00:00:00.000Z' }),
    parseImageBillingContract: (value: string) => JSON.parse(value), studioBillingState: (_task: unknown, state: string) => state,
    studioTaskState: (_task: unknown, state: string) => state, samePricingImageCharge: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
    reserveImageStudioQueueCapacity: async () => {}, recordUsageAttribution: async () => {},
    STUDIO_BATCH_LIMITS: { images: 30 }, pricingCanonical: (value: unknown) => JSON.stringify(value),
    // Any unexpected network/module access is a fixture failure, not a fallback.
    fetch: () => { forbiddenCalls++; throw new Error('Network prohibited'); },
    require: () => { forbiddenCalls++; throw new Error('Application import prohibited'); },
  };
  const code = [declarations('src/lib/image-studio/style-groups.ts', ['StudioStyleError', 'parseStudioStyleIds']),
    declarations('src/lib/image-studio/task-settings-storage.ts', ['assertStudioTaskSettingsWrite']),
    declarations('src/lib/image-studio/fixed-references.ts', ['StudioFixedReferenceError', 'parseStudioFixedReferences']),
    declarations('src/lib/image-studio/reference-policy.ts', ['StudioReferencePolicyError', 'boundedPrimaryMax', 'orderedUnique',
      'defaultStudioReferencePolicy', 'validateStudioReferenceCounts', 'parsePolicyShape', 'parseStudioReferencePolicy', 'mapStudioReferencePolicy']),
    declarations('src/lib/image-studio/skills.ts', ['parseSkillIds', 'resolveSkills', 'historicalSkills', 'publicSkillVersion', 'publicSkillSnapshot']),
    declarations('src/lib/image-studio/tasks.ts', ['StudioError', 'SharedStudioDefinitionError', 'studioBusinessErrorStatus',
      'parseSharedStudioIntent', 'sameSharedStudioIntent', 'resolveOwnedStudioTaskSharedUse', 'resolveStudioTaskRestoredSettings',
      'studioSharedGenerationSource', 'normalizeSharedAuthorDraftForUse', 'safeImageChannelSnapshot', 'parseHistoricalStyleGroups',
      'parseStudioTaskDraft', 'parseStudioRequest', 'parseHistoricalFixedReferences', 'submitStudioBatch', 'publicStudioSnapshot']),
    declarations('src/lib/image-studio/billing-quote-service.ts', ['isManagedChannelId', 'isPinnedChannelId', 'imageChannelFromPreparedTask',
      'publicImageChannel', 'assertImageChannelPairMatches', 'resolveQuoteSettings', 'quoteFailureStages',
      'prepareImageBillingQuoteOnce', 'prepareImageBillingQuote']),
    declarations('src/lib/image-studio/batch-billing-quote.ts', ['sameImageChannel', 'canonicalImageChannel', 'batchQuoteFingerprint', 'quoteStudioBatch']),
  ].join('\n');
  vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    sandbox, { timeout: 5000, filename: 'synthetic-restored-studio-declarations.js' });
  const engine = sandbox.exports;
  const body = { requestId: 'synthetic-restored-request-0001', moduleId, sharedLive: intent, restoredSettings: marker,
    prompt: 'synthetic-current-personal', personalPrompt: '', revision: 1, moduleRevision: 7, count: 1,
    referenceIds: ['current-main'], aspectRatio: '1:1', draft: { referencePolicy: policy } };
  const parse = (value: Record<string, unknown>) => engine.parseStudioRequest(value);
  assert.equal(parse(body).personalPrompt, '');
  const old = { ...body, restoredSettings: undefined, draft: undefined };
  assert.equal(Object.hasOwn(parse(old), 'restoredSettings'), false);
  assert.throws(() => parse({ ...body, draft: { ...body.draft, moduleContext: 'client-injection' } }));
  assert.throws(() => parse({ ...body, reproduceFromTaskId: marker.sourceTaskId }));
  assert.throws(() => parse({ ...body, draft: { styleGroupIds: [changedStyleId] } }));
  assert.throws(() => parse({ ...body, draft: { skillIds: [skillId] } }));
  checks.push('strict_marker_and_current_empty_prompt', 'ordinary_requests_keep_absent_marker_shape', 'arbitrary_definition_injection_rejected');

  const prepare = async (value: Record<string, unknown>, batchItem = false) => {
    const prepared: Record<string, any>[] = [];
    await engine.submitStudioBatch(owner, value, undefined, { batchItem, save: async (_tx: unknown, data: Record<string, any>) => prepared.push(plain(data)) });
    assert.equal(prepared.length, 1);
    return { task: prepared[0], snapshot: JSON.parse(prepared[0].snapshot_json) };
  };
  const first = await prepare(body);
  assert.equal(first.task.prompt, '');
  assert.equal(first.snapshot.personalPrompt, ''); assert.equal(first.snapshot.templatePrompt, '');
  assert.deepEqual(first.snapshot.styleGroups, sourceSnapshot.styleGroups);
  assert.equal(first.snapshot.globalContext, sourceSnapshot.globalContext);
  assert.equal(first.snapshot.moduleContext, sourceSnapshot.moduleContext);
  assert.deepEqual(first.snapshot.skills, [oldSkill]);
  assert.deepEqual(first.snapshot.primaryReferenceImages.map((reference: { id: string }) => reference.id), ['current-main']);
  assert.ok(first.task.context.includes('old group note')); assert.ok(!first.task.context.includes('must-not-use-current'));
  assert.deepEqual(JSON.parse(first.task.reference_ids), ['current-main', 'template-fixed', 'style-old']);
  checks.push('ordinary_to_same_published_module', 'unchanged_historical_styles_notes_skills_and_context', 'current_main_not_replaced');
  historical = { ...sourceSnapshot, sourcePresetId: 'synthetic-prior-preset' };
  const promoted = await prepare(body);
  assert.equal(promoted.snapshot.sourcePresetId, presetId);
  priorPresetOwner = 'another-owner'; await assert.rejects(() => prepare(body)); priorPresetOwner = owner;
  priorArchived = true; await assert.rejects(() => prepare(body)); priorArchived = false;
  historical = plain(sourceSnapshot);
  checks.push('owned_ordinary_prior_template_promotion_requires_fresh_ownership_and_access');

  const editedBody = { ...body, personalPrompt: 'synthetic-edited-after-restore' };
  const edited = await prepare(editedBody);
  assert.equal(edited.task.prompt, editedBody.personalPrompt);
  const changedBody = { ...editedBody, draft: { referencePolicy: policy, styleGroupIds: [changedStyleId], styleGroupVersions: { [changedStyleId]: 4 },
    skillIds: [], skillVersions: {} } };
  const changed = await prepare(changedBody);
  assert.equal(changed.snapshot.styleGroups[0].revision, 4); assert.deepEqual(changed.snapshot.skills, []);
  assert.deepEqual(JSON.parse(changed.task.reference_ids), ['current-main', 'template-fixed', 'style-new']);
  await assert.rejects(() => prepare({ ...changedBody, draft: { ...changedBody.draft, styleGroupVersions: { [changedStyleId]: 3 } } }));
  currentStyles.delete(changedStyleId);
  await assert.rejects(() => prepare(changedBody));
  checks.push('current_edits_override_source_text', 'changed_selection_frozen_at_expected_revision', 'unavailable_or_changed_style_rejected');
  const changedSkillBody = { ...editedBody, draft: { referencePolicy: policy, skillIds: [skillId], skillVersions: { [skillId]: currentSkillVersion } } };
  const changedSkill = await prepare(changedSkillBody);
  assert.equal(changedSkill.snapshot.skills[0].prompt, currentSkillPrompt);
  await assert.rejects(() => prepare({ ...changedSkillBody, draft: { ...changedSkillBody.draft, skillVersions: { [skillId]: oldSkill.promptVersion } } }));
  historical = { ...sourceSnapshot, skills: [{ ...oldSkill, ownerId: 'another-owner' }] };
  await assert.rejects(() => prepare(body)); historical = plain(sourceSnapshot);
  checks.push('changed_skill_expected_version_and_historical_owner_checked');

  deleted = true; await assert.rejects(() => prepare(body)); deleted = false;
  sourceOwner = 'another-owner'; await assert.rejects(() => prepare(body)); sourceOwner = owner;
  historical = { ...sourceSnapshot, moduleId: 'unrelated-module' };
  await assert.rejects(() => prepare(body)); historical = plain(sourceSnapshot);
  checks.push('deleted_other_owner_and_cross_template_sources_rejected');

  historical = { ...sourceSnapshot, sharedLive: intent, sourcePresetId: presetId, templatePrompt: 'synthetic-historical-template', personalPrompt: 'old-personal',
    templateReferenceImages: [{ id: 'historical-template-reference', referenceRole: 'template-reference' }],
    authorizedReferenceOwners: { ...sourceSnapshot.authorizedReferenceOwners, 'historical-template-reference': owner } };
  const sharedHistory = await prepare(editedBody);
  assert.equal(sharedHistory.task.prompt, 'synthetic-historical-template\n\n本次个人要求：\nsynthetic-edited-after-restore');
  assert.deepEqual(sharedHistory.snapshot.templateReferenceImages.map((reference: { id: string }) => reference.id), ['historical-template-reference']);
  assert.ok(!JSON.parse(sharedHistory.task.reference_ids).includes('current-template-reference'));
  const publicTask = { ...sharedHistory.task, prompt: sharedHistory.task.prompt, model: 'gpt-image-1', quality: 'medium', reference_ids: sharedHistory.task.reference_ids };
  const ordinaryProjection = engine.publicStudioSnapshot({ ...publicTask, snapshot_json: JSON.stringify(sourceSnapshot) }, assets, false, owner);
  assert.equal(ordinaryProjection.personalPromptState, 'legacy-personal'); assert.equal(ordinaryProjection.personalPrompt, sourceSnapshot.prompt);
  assert.equal(ordinaryProjection.templateReferenceCount, 0);
  const projection = engine.publicStudioSnapshot(publicTask, assets, false, owner);
  assert.equal(projection.personalPromptState, 'recorded'); assert.equal(projection.personalPrompt, editedBody.personalPrompt);
  assert.equal(projection.styleGroups[0].revision, 2); assert.equal(projection.templateReferenceCount, 1);
  assert.deepEqual(plain(projection.templateReferenceImages), []); assert.deepEqual(plain(projection.fixedReferenceImages), []);
  const adminProjection = engine.publicStudioSnapshot(publicTask, assets, true, owner);
  assert.equal(adminProjection.templateReferenceImages[0].originalUrl, '/protected/historical-template-reference');
  historical = { ...historical, templatePrompt: undefined, personalPrompt: undefined };
  const unknownProjection = engine.publicStudioSnapshot({ ...publicTask, snapshot_json: JSON.stringify(historical) }, assets, false, owner);
  assert.equal(unknownProjection.personalPromptState, 'unavailable'); assert.equal(Object.hasOwn(unknownProjection, 'personalPrompt'), false);
  await assert.rejects(() => prepare(body));
  checks.push('shared_template_and_personal_parts_never_guessed', 'historical_template_references_remain_separate', 'public_projection_preserves_read_boundaries');

  historical = plain(sourceSnapshot);
  const expectedOne = await prepare(body), expectedTwo = await prepare({ ...body, referenceIds: ['current-main-two'],
    draft: { referencePolicy: { ...policy, primaryIds: ['current-main-two'] } } });
  const expectedSpecifications = [expectedOne.task.billing_contract_json, expectedTwo.task.billing_contract_json].map(value => JSON.parse(value).specification);
  const beforeQuote = specificationInputs.length;
  await engine.prepareImageBillingQuote(owner, body);
  assert.equal(JSON.stringify(specificationInputs[beforeQuote]), expectedSpecifications[0]);
  const beforeBatchQuote = specificationInputs.length;
  await engine.quoteStudioBatch(owner, { ...body, sources: [{ name: 'one', assetId: 'current-main' }, { name: 'two', assetId: 'current-main-two' }] });
  assert.deepEqual(specificationInputs.slice(beforeBatchQuote).map(value => JSON.stringify(value)), expectedSpecifications);
  const batchItem = await prepare(body, true);
  assert.equal(batchItem.task.billing_contract_json, expectedOne.task.billing_contract_json);
  const restoredFingerprint = engine.batchQuoteFingerprint(body);
  assert.notEqual(restoredFingerprint, engine.batchQuoteFingerprint({ ...body, restoredSettings: undefined }));
  checks.push('single_batch_quote_and_preparation_share_effective_inputs', 'source_mode_is_in_quote_fingerprint');

  const noMarkerDraft = { ...body, restoredSettings: undefined, draft: { styleGroupIds: [styleId] } };
  await assert.rejects(() => prepare(noMarkerDraft));
  const readsBeforeAccepted = sourceReads;
  accepted = { module_id: moduleId, snapshot_json: JSON.stringify({ sharedLive: intent }) };
  deleted = true;
  const acceptedId = await engine.submitStudioBatch(owner, { ...body, restoredSettings: { invalid: true }, revision: -1 });
  assert.equal(acceptedId, createHash('sha256').update(`${owner}:${body.requestId}`).digest('hex'));
  assert.equal(sourceReads, readsBeforeAccepted); accepted = null; deleted = false;
  await engine.submitStudioBatch(owner, body);
  assert.equal(created.length, 1); assert.equal(created[0].prompt, '');
  checks.push('ordinary_shared_unsaved_definition_still_rejected', 'accepted_recovery_precedes_new_source_and_config_checks', 'creation_uses_same_empty_personal_input');

  assert.equal(forbiddenCalls, 0);
  writeFileSync(destination, JSON.stringify({ schema: 'studio-restored-settings-engineering.v1', synthetic: true, completed: true,
    checks, sourceSha256: Object.fromEntries(files.map(file => [file, createHash('sha256').update(sources.get(file)!).digest('hex')])),
    applicationDatabaseOpened: false, forbiddenCalls, networkCalls: 0, paidRequests: 0, browserRuns: 0,
    scope: 'Selected production request/restore/projection/quote declarations with synthetic external dependencies; not functional acceptance or full worker dispatch' }),
  { mode: 0o600, flag: 'wx' });
  console.log('STUDIO_RESTORED_SETTINGS_ENGINEERING_RECEIPT=' + destination);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
