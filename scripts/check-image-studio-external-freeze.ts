import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

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
    const require = createRequire(import.meta.url);
    const storage = await import('../src/lib/image-studio/private-storage.server');
    const crypto = await import('../src/lib/security/private-prompts.server');
    const batchId = 'b'.repeat(64), requestId = 'r'.repeat(20);
    const intent = { protocol: 'shared-live-v1', presetId: source, definitionToken: 'source-version' };
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
    class StudioError extends Error { constructor(message: string, public status = 400) { super(message); } }
    class SharedStudioDefinitionError extends StudioError {}
    const preparedSkills: string[] = [];
    const tasks = { StudioError, SharedStudioDefinitionError, parseSharedStudioIntent: (value: unknown) => value,
      resolveOwnedStudioTaskSharedUse: async () => ({ definition: { skills: [{ id: skillId, promptVersion }] } }),
      submitStudioBatch: async (_owner: string, input: any, _avatar: unknown, preparation: any) => {
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
    const sourceText = fs.readFileSync(file, 'utf8'), prepareStart = sourceText.indexOf('async function prepareBatch(');
    assert.ok(prepareStart >= 0);
    // Keep production failure behavior; expose the swallowed synthetic cause across native environments.
    const diagnosticSource = sourceText.slice(0, prepareStart) + sourceText.slice(prepareStart).replace('  } catch (error) {',
      `  } catch (error) { console.error('[external-freeze-diagnostic]', JSON.stringify({ name: error?.name, code: error?.code, message: error?.message, stack: error?.stack }));`);
    const compiled = ts.transpileModule(`${diagnosticSource}\nexport const fixturePrepareBatch = prepareBatch;`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const module = { exports: {} as { fixturePrepareBatch: (owner: string, id: string) => Promise<void> } };
    const imports: Record<string, unknown> = { '@/lib/prisma': { prisma: db }, './tasks': tasks, './private-storage.server': storage,
      '@/lib/credits/precision': require(path.join(root, 'src/lib/credits/precision.ts')),
      './submit-receipts.server': { assertStudioRequestWritable: async () => undefined },
      './pricing-state': { PRICING_BATCH_PREFIX: 'pricing_batch:', PRICING_BATCH_ITEM_PREFIX: 'pricing_batch_item:' } };
    const routeRequire = (id: string) => id.startsWith('node:') ? require(id) : imports[id] || {};
    vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename: file })(routeRequire, module, module.exports);
    await module.exports.fixturePrepareBatch(owner, batchId);
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
      'no-plaintext-prepared-persistence', 'two-child-consistency', 'wrong-id-rejected'], supplierCalls: 0, productionWrites: 0 }));
  } finally {
    for (const key of Object.keys(process.env).filter(key => key.startsWith('PRIVATE_PROMPTS_') || key === 'NODE_ENV')) delete process.env[key];
    Object.assign(process.env, prior); fs.rmSync(policyRoot, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
