import assert from 'node:assert/strict';
import { setFixtureDatabase } from './fixtures/database-client';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

async function main() {
  const root = realpathSync(process.cwd()), output = path.resolve(process.argv[2] || '');
  assert.ok(output.startsWith(path.join(root, '.role-tests') + path.sep));
  const startedAt = new Date().toISOString();
  let forbiddenCalls = 0;
  const forbidden = () => { forbiddenCalls++; throw new Error('Offline creation gate cannot open business services'); };
  const globalDb = new Proxy({}, { get: () => forbidden });
  setFixtureDatabase(globalDb);
  Object.assign(globalThis, { prismaSqlitePragmasStarted: true, fetch: forbidden });
  const { isCreationV2, creationIdentity } = await import('../src/lib/creation/contract');
  const { normalizeVideoCreationSpec, creationSpecHash } = await import('../src/lib/creation/intents');
  const { videoCreationSchemaReady } = await import('../src/lib/creation/context');
  const { videoIntentChildKeys, consumeCreationApproval } = await import('../src/lib/creation/approval');
  const { creationParent, assertCreationLineageUnlocked } = await import('../src/lib/creation/lineage');
  const { buildTaskReuseOperationRequest, canonicalTaskReuseOperation, parseTaskReuseOperationRequest,
    taskReuseAutoAction } = await import('../src/lib/navigation/task-reuse-intent');
  const checks: string[] = [];
  assert.equal(isCreationV2({}), false); assert.equal(isCreationV2({ creation_contract_version: 1 }), false);
  assert.equal(isCreationV2({ creation_contract_version: 2 }), true);
  for (const version of [0, 3, '2', null]) assert.throws(() => isCreationV2({ creation_contract_version: version }));
  assert.equal(creationIdentity(null, 'card', true), null); assert.throws(() => creationIdentity('../project', 'project'));
  checks.push('v1_v2_and_unknown_contracts_fail_closed');
  const body = { project_id: 'project', model: 'seedance', duration: 5, resolution: '720p', prompt: 'fixture', provider: 'seedance' };
  const spec = normalizeVideoCreationSpec(body);
  assert.equal(spec.video_card_id, null); assert.equal(spec.continuation.mode, 'new'); assert.equal(creationParent(spec), null);
  assert.throws(() => normalizeVideoCreationSpec({ ...body, video_branch_id: 'branch' }));
  assert.throws(() => normalizeVideoCreationSpec({ ...body, continuation: { mode: 'continue' } }));
  assert.throws(() => normalizeVideoCreationSpec({ ...body, count: 3 }));
  const independent = normalizeVideoCreationSpec({ ...body, input_source_task_ids: ['old-task'] });
  assert.equal(creationParent(independent), null);
  assert.notEqual(creationSpecHash(spec), creationSpecHash({ ...spec, input: { ...spec.input, prompt: 'changed' } }));
  assert.deepEqual(videoIntentChildKeys({ id: 'i', count: 1 }), ['single']);
  assert.deepEqual(videoIntentChildKeys({ id: 'i', count: 4 }), ['intent:i:1', 'intent:i:2', 'intent:i:3', 'intent:i:4']);
  checks.push('project_only_specs_real_parent_and_child_identity');
  const columns: Record<string, string[]> = {
    VideoTask: ['creation_contract_version','creation_intent_id','derived_from_task_id','lineage_root_task_id'],
    VideoCreationIntent: ['id','revision','state','spec_json','batch_id','quote_business_hash'],
    VideoDeliverySelection: ['lineage_root_task_id','revision','state','selected_task_id'],
    ApprovalRecord: ['creation_intent_id','intent_revision','revision','authorized_cost_cents','used_cost_cents'],
    ApprovalUsage: ['creation_intent_id','intent_revision','authorization_revision','child_key','authorized_cost_cents'],
    CanvasVideoBatch: ['creation_intent_id','authorization_round'],
    CanvasVideoBatchChild: ['intent_spec_revision','authorization_revision','approval_record_id','approval_scope_hash'],
  };
  const schemaDb = { $queryRawUnsafe: async (sql: string) => columns[/table_info\("([^"]+)"\)/.exec(sql)![1]].map(name => ({ name })) };
  assert.equal(await videoCreationSchemaReady(schemaDb as never), true);
  columns.CanvasVideoBatchChild.pop(); assert.equal(await videoCreationSchemaReady(schemaDb as never), false);
  checks.push('schema_capability_uses_actual_required_columns');
  const user = { id: 'owner', role: 'admin', account_type: 'internal', status: 'active' } as never;
  let locked = true;
  const baseline = { id: 'baseline', project_id: 'project', owner_user_id: 'owner', local_status: 'succeeded', public_video_url: 'https://fixture.invalid/complete.mp4', video_card_id: null, lineage_root_task_id: 'baseline' };
  const sourceDb = { videoTask: { findUnique: async () => baseline }, project: { findUnique: async () => ({ id: 'project', type: 'team', status: 'active', members: [] }) },
    videoDeliverySelection: { findUnique: async () => locked ? { state: 'locked' } : { state: 'selected' } } };
  await assert.rejects(() => assertCreationLineageUnlocked(sourceDb as never, user, 'baseline', 'project'), /锁定交付/);
  locked = false; assert.equal((await assertCreationLineageUnlocked(sourceDb as never, user, 'baseline', 'project')).rootId, 'baseline');
  await assert.rejects(() => assertCreationLineageUnlocked(sourceDb as never, user, 'baseline', 'other'), /跨项目/);
  checks.push('delivery_selection_is_not_lock_and_independent_provenance_is_not_lineage');
  const hdSpec = { ...spec, input: { ...spec.input, resolution: '1080p' }, baseline_task_id: 'baseline' };
  const intent = { id: 'intent', owner_id: 'owner', revision: 2, project_id: 'project', payer_kind: 'project', payer_account_id: 'project', input_hash: 'input', quote_business_hash: 'quote', pricing_revision: 'prices' };
  const approval = { id: 'approval', type: 'video_creation_1080p', status: 'approved', expires_at: new Date(Date.now() + 60000), creation_intent_id: 'intent', intent_revision: 2,
    scope_hash: 'quote', project_id: 'project', requester_user_id: 'owner', billing_scope: 'project', billing_account_id: 'project', usage_limit: 1, used_count: 0,
    authorized_cost_cents: 1000, used_cost_cents: 0, revision: 1, task_id: 'baseline', scope_json: JSON.stringify({ version: 2, input_hash: 'input', pricing_revision: 'prices', authorization_round: 1, child_authorizations: [{ key: 'single', maximum: 1000 }] }) };
  let prior: { task_id: string } | null = null, writes = 0, failCas = false;
  const approvalDb = { ...sourceDb, approvalRecord: { findUnique: async () => approval, updateMany: async () => { if (failCas) return { count: 0 }; writes++; return { count: 1 }; } },
    approvalUsage: { findUnique: async () => prior, create: async ({ data }: { data: { task_id: string } }) => { prior = data; writes++; } } };
  const consume = (overrides: Record<string, unknown> = {}) => consumeCreationApproval(approvalDb as never, user, intent as never, hdSpec, 'team', { taskId: 'accepted', cost: 5, pricingRevision: 'prices', ...overrides }, 'approval');
  await consume(); assert.equal(writes, 2); await consume(); assert.equal(writes, 2);
  await assert.rejects(() => consume({ taskId: 'other' }), /原任务/);
  prior = null; approval.status = 'revoked'; await assert.rejects(() => consume(), /失效/); approval.status = 'approved';
  approval.expires_at = new Date(0); await assert.rejects(() => consume(), /失效/); approval.expires_at = new Date(Date.now() + 60000);
  await assert.rejects(() => consume({ cost: 11 }), /范围/);
  await assert.rejects(() => consume({ pricingRevision: 'changed' }), /范围/);
  failCas = true; await assert.rejects(() => consume(), /余量/); assert.equal(writes, 2);
  checks.push('approval_actual_helper_expiry_revoke_scope_cost_cas_and_same_task_once');
  const acceptanceSources = ['src/server/video-tasks/standard-create.ts', 'src/server/video-tasks/ip-create.ts',
    'src/app/api/tasks/enhance-video/create/route.ts', 'src/lib/tasks/seedance-draft-upgrade.ts'];
  for (const file of acceptanceSources) {
    const source = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(source) === 'acceptVideoCreationIntent') calls.push(node); ts.forEachChild(node, visit); };
    visit(source); assert.equal(calls.length, 1, `${file} must bind its one original acceptance`);
    const call = calls[0]; assert.equal(call.arguments[0].getText(source), 'tx');
    let transaction: ts.Node | null = null;
    for (let current: ts.Node | undefined = call; current; current = current.parent) {
      if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isCallExpression(current.parent)
        && ts.isPropertyAccessExpression(current.parent.expression) && current.parent.expression.name.text === '$transaction') { transaction = current; break; }
    }
    assert.ok(transaction, `${file} acceptance must remain in the original transaction`);
    let createsTask = false;
    const findTask = (node: ts.Node) => {
      if (ts.isCallExpression(node) && (node.expression.getText(source) === 'tx.videoTask.create'
        || node.expression.getText(source) === 'createVideoTaskRecord' && node.arguments[0]?.getText(source) === 'tx')) createsTask = true;
      ts.forEachChild(node, findTask);
    };
    findTask(transaction); assert.ok(createsTask, `${file} must create the task in the same transaction`);
  }
  const taskStateSource = readFileSync(path.join(root, 'src/lib/video/task-state.ts'), 'utf8');
  assert.match(taskStateSource, /createVideoTaskRecord\(tx:[\s\S]*?tx\.videoTask\.create\(/, 'shared create must use the supplied transaction');
  checks.push('all_four_acceptors_bind_real_task_and_approval_in_original_transaction');
  // The original receipt hash includes owner, source, workspace, nonce and expected items.
  const operation = await buildTaskReuseOperationRequest('owner', 'task', { surface: 'normal', tabId: 'tab', workspaceId: 'workspace', expectedWorkspaceAssets: [] });
  assert.ok(parseTaskReuseOperationRequest(operation));
  assert.notEqual(canonicalTaskReuseOperation('owner', 'task', operation), canonicalTaskReuseOperation('other', 'task', operation));
  assert.notEqual(canonicalTaskReuseOperation('owner', 'task', operation), canonicalTaskReuseOperation('owner', 'other', operation));
  assert.equal(parseTaskReuseOperationRequest({ ...operation, protocolVersion: 1 }), null);
  assert.equal(taskReuseAutoAction({ phase: 'unknown' } as never, {} as never), 'none');
  checks.push('reuse_original_identity_scope_and_unknown_never_replays');
  const sources = [
    'ops/video-creation-contract-check.mjs', 'scripts/video-creation-contract-engineering.ts',
    'src/lib/creation/contract.ts','src/lib/creation/context.ts','src/lib/creation/intents.ts','src/lib/creation/approval.ts','src/lib/creation/availability.ts','src/lib/creation/lineage.ts',
    'src/lib/navigation/task-reuse-intent.ts','src/lib/navigation/task-reuse-client.ts','src/lib/navigation/task-reuse-operation.server.ts',
    'src/lib/hooks/useWorkspace.ts','src/components/ResourceLibraryPicker.tsx','src/components/useResultPages.ts',
    ...acceptanceSources,
  ];
  const hash = (file: string) => createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex');
  const receipt = { schema: 'video-creation-contract-engineering.v1', synthetic: true, runId: process.env.IMAGE_RECOVERY_GATE_RUN_ID,
    completed: true, startedAt, finishedAt: new Date().toISOString(), forbiddenCalls, productionWrites: 0, paidRequests: 0, browserRuns: 0,
    fixtureSha256: hash('ops/video-creation-contract-check.mjs'), sourceSha256: Object.fromEntries(sources.map(file => [file, hash(file)])), checks };
  assert.equal(forbiddenCalls, 0); writeFileSync(output, JSON.stringify(receipt), { mode: 0o600 });
  console.log(`Video creation contract engineering receipt: ${output}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
