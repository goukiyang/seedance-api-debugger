import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { addCredits, sumCredits } from '../src/lib/credits/precision';
import { externalStudioCanUsePresetId, isExternalImageStudioActor } from '../src/lib/image-studio/access';
import { EXTERNAL_IMAGE_ADMISSION_ENABLED } from '../src/lib/image-studio/external-admission';

function declarations(root: string, file: string, names: string[]) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return names.map(name => {
    const node = source.statements.find(statement => (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
      ? statement.name?.text === name : ts.isVariableStatement(statement)
        && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name));
    assert.ok(node, `Missing production declaration ${file}:${name}`);
    return node.getText(source);
  }).join('\n');
}

function evaluate(source: string, bindings: Record<string, unknown>, filename: string) {
  const scope = { exports: {}, Error, console, ...bindings };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, scope, { filename });
  return scope.exports as Record<string, any>;
}

/** Production prepareBatch + real private storage; memory-only parent/items, no supplier or database. */
async function main() {
  const root = fs.realpathSync(process.cwd());
  const policyRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-external-freeze-')));
  const prior = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PRIVATE_PROMPTS_') || key === 'NODE_ENV'));
  const owner = 'fixture-external', author = 'fixture-author', source = 'fixture-source', skillId = 'fixture-skill';
  const sourceOrigin = { kind: 'image-preset', id: source, ownerId: author };
  const skillOrigin = { kind: 'skill', id: skillId, ownerId: author };
  const prompt = 'SYNTHETIC_PRIVATE_SOURCE_PROMPT', context = 'SYNTHETIC_PRIVATE_SOURCE_CONTEXT';
  const skillPrompt = 'SYNTHETIC_PRIVATE_SKILL_BODY', promptVersion = createHash('sha256').update(skillPrompt).digest('hex');
  const write = (file: string, value: unknown) => fs.writeFileSync(file, Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 });
  for (const key of Object.keys(process.env).filter(key => key.startsWith('PRIVATE_PROMPTS_'))) delete process.env[key];
  Object.assign(process.env, { NODE_ENV: 'test', PRIVATE_PROMPTS_FIXTURE_ROOT: policyRoot,
    PRIVATE_PROMPTS_POLICY_FILE: path.join(policyRoot, 'policy.json'), PRIVATE_PROMPTS_MIN_STATE: 'compatible-read',
    PRIVATE_PROMPTS_CONSUMER_ID: 'fixture', PRIVATE_PROMPTS_RUNTIME_REVISION: 'a'.repeat(40) });
  const policy = { schema: 'private-prompt-policy.v1', revision: 'external-freeze-fixture', state: 'encrypted-write', minimumReader: 1,
    identities: [{ userId: author, tenant: 'fixture', subject: 'fixture-author', administrator: true }],
    origins: [sourceOrigin, skillOrigin], authorKinds: [{ ownerId: author, kinds: ['image-preset', 'skill'] }],
    keys: Object.fromEntries(['body', 'index', 'backup'].map(domain => { const file = path.join(policyRoot, `${domain}.key`);
      write(file, randomBytes(32)); return [domain, { active: domain, files: { [domain]: file } }]; })),
    destinations: [], consumers: ['fixture'], activation: { inventoryId: 'fixture', restoreId: 'fixture', writerFenceId: 'fixture',
      attestationFile: path.join(policyRoot, 'consumers.json') } };
  write(process.env.PRIVATE_PROMPTS_POLICY_FILE!, policy);
  write(policy.activation.attestationFile, { schema: 'private-prompt-consumers.v1', policyRevision: policy.revision,
    inventoryId: 'fixture', restoreId: 'fixture', writerFenceId: 'fixture',
    consumers: [{ id: 'fixture', reader: 1, permissionContract: 1, sourceRevision: 'a'.repeat(40) }] });
  try {
    const storage = await import('../src/lib/image-studio/private-storage.server');
    const crypto = await import('../src/lib/security/private-prompts.server');
    const admissionSource = declarations(root, 'src/lib/image-studio/tasks.ts', ['StudioError', 'SharedStudioDefinitionError', 'assertExternalStudioAdmission']);
    assert.equal(typeof EXTERNAL_IMAGE_ADMISSION_ENABLED, 'boolean');
    const admissionBindings = { isExternalImageStudioActor, externalStudioCanUsePresetId, EXTERNAL_IMAGE_ADMISSION_ENABLED: true };
    const admission = evaluate(admissionSource, admissionBindings, 'external-freeze-admission.vm.ts');
    const { StudioError, SharedStudioDefinitionError, assertExternalStudioAdmission } = admission;
    const batchId = 'b'.repeat(64), requestId = 'r'.repeat(20);
    const intent = { protocol: 'shared-live-v1', presetId: source, definitionToken: 'source-version' };
    const actor = { id: owner, role: 'user', account_type: 'external', externalStudioAccess: {
      enabled: true, revision: 1, presetIds: [] as string[], allShared: true,
    } };
    const sharedUse = { binding: { mode: 'live', ownerId: owner }, definition: { intent, skills: [{ id: skillId, promptVersion }] } };
    const denied = (run: () => void) => assert.throws(run, (error: any) => error instanceof StudioError && error.status === 403);
    assert.doesNotThrow(() => assertExternalStudioAdmission(actor, 'fixture-module', sharedUse));
    assert.doesNotThrow(() => assertExternalStudioAdmission(actor, 'fixture-module', {
      ...sharedUse, definition: { ...sharedUse.definition, intent: { ...intent, presetId: 'fixture-new-shared-source' } },
    }));
    const legacy = { ...actor, externalStudioAccess: { enabled: true, revision: 1, presetIds: [source], allShared: false } };
    assert.doesNotThrow(() => assertExternalStudioAdmission(legacy, 'fixture-module', sharedUse));
    denied(() => assertExternalStudioAdmission({ ...legacy, externalStudioAccess: { ...legacy.externalStudioAccess, presetIds: [] } }, 'fixture-module', sharedUse));
    denied(() => assertExternalStudioAdmission({ ...actor, externalStudioAccess: { ...actor.externalStudioAccess, enabled: false } }, 'fixture-module', sharedUse));
    denied(() => assertExternalStudioAdmission({ id: owner, role: 'admin', account_type: 'external' }, 'fixture-module', sharedUse));
    denied(() => assertExternalStudioAdmission(actor, undefined, sharedUse));
    denied(() => assertExternalStudioAdmission(actor, 'fixture-module', null));
    denied(() => assertExternalStudioAdmission(actor, 'fixture-module', { ...sharedUse, binding: { mode: 'publisher', ownerId: owner } }));
    denied(() => assertExternalStudioAdmission(actor, 'fixture-module', { ...sharedUse, binding: { mode: 'live', ownerId: author } }));
    denied(() => assertExternalStudioAdmission(actor, 'fixture-module', { ...sharedUse, definition: { ...sharedUse.definition,
      intent: { ...intent, presetId: 'parameter-copy-11111111-1111-4111-8111-111111111111' } } }));
    const guarded = evaluate(admissionSource, { ...admissionBindings, EXTERNAL_IMAGE_ADMISSION_ENABLED: false }, 'external-freeze-guard.vm.ts');
    assert.throws(() => guarded.assertExternalStudioAdmission(actor, 'fixture-module', sharedUse),
      (error: any) => error instanceof guarded.StudioError && error.status === 403);
    assert.doesNotThrow(() => guarded.assertExternalStudioAdmission({ id: author, role: 'admin', account_type: 'internal' }, undefined, null));
    const batch = { version: 1, sizePolicyVersion: 2, id: batchId, ownerId: owner, requestId, fingerprint: 'fixture',
      moduleId: 'fixture-module', moduleName: 'Fixture', state: 'preparing', note: '', total: 2, budget: 2, committedCredits: 0,
      unitCredits: 1, prepared: 0, input: { sharedLive: intent, referenceIds: [] },
      items: [1, 2].map(ordinal => ({ ordinal, sourceName: `image-${ordinal}`, taskId: null, attempt: 0, prepared: false, cancelled: false })) };
    const parentKey = `studio_batch_v1:${owner}:${batchId}`;
    type Row = { id: string; key: string; value_json: string };
    const rows = new Map<string, Row>([[parentKey, { id: 'parent', key: parentKey, value_json: JSON.stringify(batch) }]]);
    const db: any = { user: { findUniqueOrThrow: async () => ({ account_type: 'external' }) }, platformSetting: {
      findFirst: async ({ where }: any) => Array.from(rows.values()).find(row => where.key.in.includes(row.key)) || null,
      findUnique: async ({ where }: any) => rows.get(where.key) || null,
      create: async ({ data }: any) => { assert.ok(!rows.has(data.key)); const row = { id: data.key, ...data }; rows.set(data.key, row); return row; },
      updateMany: async ({ where, data }: any) => { const row = Array.from(rows.values()).find(item => item.id === where.id && item.value_json === where.value_json);
        if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
    } };
    db.$transaction = async (operation: (tx: any) => Promise<unknown>) => operation(db);
    const preparedSkills: string[] = [];
    const tasks = { StudioError, SharedStudioDefinitionError, parseSharedStudioIntent: (value: unknown) => value,
      resolveOwnedStudioTaskSharedUse: async () => { assertExternalStudioAdmission(actor, batch.moduleId, sharedUse); return sharedUse; },
      submitStudioBatch: async (_owner: string, input: any, _avatar: unknown, preparation: any) => {
        assertExternalStudioAdmission(actor, batch.moduleId, sharedUse);
        const id = `quote-task-${input.requestId.split('-').at(-1)}`;
        const raw = { id, owner_id: owner, module_id: batch.moduleId, source_preset_id: source, batch_id: batchId, ordinal: 1,
          prompt, context, unit_credits: 1, reference_ids: '[]', snapshot_json: JSON.stringify({ moduleId: batch.moduleId,
            sourcePresetId: source, sharedSourceOwnerId: author, prompt, templatePrompt: prompt, moduleContext: context,
            globalContext: '', effectiveContext: context, inputFingerprint: 'fixture', sharedLive: intent,
            settingsRevision: 1, styleGroups: [], fixedReferenceImages: [], skills: [{ id: skillId, name: 'Fixture skill', ownerId: author, prompt: skillPrompt, promptVersion }] }) };
        const sealed = storage.transformPrivateImageTask(raw, true, [sourceOrigin]);
        const runtime = storage.transformPrivateImageTask(sealed, false);
        preparedSkills.push((storage.readPrivateImageTaskSnapshot(runtime).skills as any[])[0].promptVersion);
        await preparation.save(db, runtime);
      } };
    const file = path.join(root, 'src/lib/image-studio/batches.ts');
    const batchSource = declarations(root, 'src/lib/image-studio/batches.ts', ['PREFIX', 'ITEM_PREFIX', 'CHANNEL_PREFIX', 'CHANNEL_ITEM_PREFIX',
      'key', 'batchKeys', 'itemKey', 'childId', 'parse', 'validId', 'readOwned', 'writeBatch', 'sharedDefinitionError', 'invalidateUnacceptedDefinition', 'prepareBatch']);
    // Keep production failure behavior; expose the swallowed synthetic cause across native environments.
    const diagnosticSource = batchSource.replace('  } catch (error) {',
      `  } catch (error) { console.error('[external-freeze-diagnostic]', JSON.stringify({ name: error?.name, code: error?.code, message: error?.message, stack: error?.stack }));`);
    const engine = evaluate(`${diagnosticSource}\nexport const fixturePrepareBatch = prepareBatch;`, {
      prisma: db, ...tasks, ...storage, addCredits, sumCredits,
      assertStudioRequestWritable: async (_tx: unknown, currentOwner: string, currentRequest: string) => {
        assert.equal(currentOwner, owner); assert.equal(currentRequest, requestId);
      },
      PRICING_BATCH_PREFIX: 'pricing_batch:', PRICING_BATCH_ITEM_PREFIX: 'pricing_batch_item:',
    }, file);
    await engine.fixturePrepareBatch(owner, batchId);
    const completed = JSON.parse(rows.get(parentKey)!.value_json);
    assert.equal(completed.state, 'ready', completed.note);
    assert.equal(completed.prepared, 2);
    assert.deepEqual(preparedSkills, [promptVersion, promptVersion]);
    for (const ordinal of [1, 2]) {
      const row = rows.get(`studio_batch_item_v1:${batchId}:${ordinal}`)!;
      assert.ok(row);
      for (const secret of [prompt, context, skillPrompt, promptVersion]) assert.ok(!row.value_json.includes(secret), 'Prepared persistence must keep source values sealed');
      const frozen = JSON.parse(row.value_json);
      assert.equal(frozen.id, `${batchId}-${ordinal}-a0`);
      assert.equal(crypto.inspectPrivatePrompt(frozen.context).binding.id, frozen.id);
      assert.equal(crypto.inspectPrivatePrompt(frozen.prompt).binding.id, frozen.id);
      const snapshot = storage.readPrivateImageTaskSnapshot(frozen);
      assert.equal((snapshot.skills as any[])[0].promptVersion, promptVersion);
      assert.equal((snapshot.skills as any[])[0].prompt, skillPrompt);
      assert.equal(crypto.inspectPrivatePrompt(JSON.parse(frozen.snapshot_json).skills[0].promptVersion).binding.id, `${frozen.id}:0`);
      const runtime = storage.transformPrivateImageTask(frozen, false);
      assert.ok(runtime.context.startsWith(context));
      assert.ok(runtime.context.includes(`本批条目 ${ordinal}/2`));
      assert.throws(() => storage.transformPrivateImageTask({ ...frozen, id: 'wrong-final-id' }, false),
        (error: unknown) => crypto.isPrivatePromptError(error) && error.code === 'PRIVATE_PROMPT_UNAVAILABLE');
    }
    console.log(JSON.stringify({ synthetic: true, checks: ['final-child-id-private-bindings', 'source-skill-version-preserved',
      'no-plaintext-prepared-persistence', 'two-child-consistency', 'wrong-id-rejected',
      'global-and-legacy-admission-respect-closed-and-live-owner'], supplierCalls: 0, productionWrites: 0 }));
  } finally {
    for (const key of Object.keys(process.env).filter(key => key.startsWith('PRIVATE_PROMPTS_') || key === 'NODE_ENV')) delete process.env[key];
    Object.assign(process.env, prior); fs.rmSync(policyRoot, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
