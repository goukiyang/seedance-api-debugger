import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import type { SessionUser } from '../src/lib/auth/session';

type Row = Record<string, any>;

async function main() {
  const root = realpathSync(process.cwd());
  const destination = path.resolve(process.argv[2] || '');
  assert.ok(destination.startsWith(path.join(root, '.role-tests') + path.sep));
  const startedAt = Date.now();
  let forbiddenCalls = 0;
  const forbidden = () => { forbiddenCalls++; throw new Error('Project fixture cannot access a real database or business service'); };
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'file:/nonexistent/project-operations-engineering.db' });
  let projects: Row[] = [], members: Row[] = [], logs: Row[] = [];
  let settings = new Map<string, Row>();
  let countRows = new Map<string, number>();
  let budgetAccount: Row | null = null, invite: Row | null = null;
  let usage = false, priorFlow = false, failCas = false, failAudit = false;
  let casCalls = 0, inviteUses = 0;
  const tx: Row = {
    project: {
      create: async ({ data }: Row) => {
        const project = { ...data, id: `project-${projects.length + 1}`, updated_at: new Date('2026-10-21T08:00:00Z'), created_at: new Date('2026-10-21T08:00:00Z') };
        projects.push(project); return project;
      },
      findUnique: async ({ where, include }: Row) => {
        const project = projects.find(row => row.id === where.id);
        const memberUserId = include?.members?.where?.user_id;
        return project ? { ...project, members: members.filter(row => row.project_id === where.id && (!memberUserId || row.user_id === memberUserId)) } : null;
      },
      updateMany: async ({ where, data }: Row) => {
        casCalls++;
        const project = projects.find(row => row.id === where.id && row.status === where.status && row.updated_at.getTime() === where.updated_at.getTime());
        if (failCas || !project) return { count: 0 };
        Object.assign(project, data); return { count: 1 };
      },
    },
    projectMember: {
      create: async ({ data }: Row) => { const member = { ...data, id: `member-${members.length + 1}`, status: 'active' }; members.push(member); return member; },
      findUnique: async ({ where }: Row) => members.find(row => row.project_id === where.project_id_user_id.project_id && row.user_id === where.project_id_user_id.user_id) || null,
      upsert: async ({ where, create, update }: Row) => {
        const member = members.find(row => row.project_id === where.project_id_user_id.project_id && row.user_id === where.project_id_user_id.user_id);
        if (member) { Object.assign(member, update); return member; }
        const created = { ...create, id: `member-${members.length + 1}`, status: 'active' }; members.push(created); return created;
      },
      count: async () => countRows.get('projectMember') || 0,
    },
    platformSetting: {
      findUnique: async ({ where }: Row) => settings.get(where.key) || null,
      create: async ({ data }: Row) => { if (settings.has(data.key)) throw new Error('Unique key conflict'); settings.set(data.key, data); return data; },
      update: async ({ where, data }: Row) => { const row = { ...settings.get(where.key), ...data }; settings.set(where.key, row); return row; },
    },
    operationLog: {
      create: async ({ data }: Row) => { if (failAudit) throw new Error('Audit unavailable'); logs.push(data); return data; },
      findMany: async ({ where }: Row) => logs.filter(row => row.target_type === where.target_type && row.target_id === where.target_id),
    },
    projectInvite: {
      findUnique: async () => invite,
      count: async () => countRows.get('projectInvite') || 0,
      updateMany: async ({ where }: Row) => {
        if (!invite || invite.status !== where.status || invite.used_count !== where.used_count) return { count: 0 };
        invite.used_count++; inviteUses++; return { count: 1 };
      },
    },
    projectBudgetAccount: { findUnique: async () => budgetAccount },
    $queryRaw: async (sql: TemplateStringsArray) => sql.join('').includes('ToolFlowRun') ? priorFlow ? [{ found: 1 }] : [] : usage ? [{ found: 1 }] : [],
  };
  const countTables = ['videoCard', 'videoTask', 'canvasDocument', 'referenceAlbum', 'referenceImage', 'providerApiRequest',
    'costLedger', 'costAllocation', 'projectBudgetLedger', 'approvalRecord', 'contentAuditLog', 'feishuRequirement', 'reviewCard', 'notification', 'toolFlow'];
  for (const table of countTables) tx[table] = { count: async () => countRows.get(table) || 0 };
  const mock = new Proxy({ $transaction: async (fn: (db: Prisma.TransactionClient) => Promise<unknown>) => {
    const before = structuredClone({ projects, members, logs, settings });
    try { return await fn(tx as unknown as Prisma.TransactionClient); }
    catch (error) { ({ projects, members, logs, settings } = before); throw error; }
  } }, { get(target, property) { return property in target ? Reflect.get(target, property) : forbidden; } });
  Reflect.set(globalThis, 'prisma', mock);
  Reflect.set(globalThis, 'prismaSqlitePragmasStarted', true);
  globalThis.fetch = forbidden;
  const { createTeamProject, getProjectCreateOperation, closeProjectCreateOperation, joinProjectInvite } = await import('../src/lib/projects/operations');
  const { assertProjectActiveInTransaction, getProjectDeletionBlockers, compareAndSetProject, projectListOperationProjection } = await import('../src/lib/projects/permissions');
  const user: SessionUser = { id: 'owner', name: 'Fixture', username: 'fixture', email: '', role: 'user', account_type: 'internal',
    user_profile: 'other', feature_profile_id: null, status: 'active', expires_at: null,
    feishu: { user_id: 'fixture', open_id: null, union_id: null, tenant_key: null, employee_no: null, department_ids: [], last_sync_at: null } };
  const db = tx as unknown as Prisma.TransactionClient;
  const checks: string[] = [];
  const key = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const request = (n: number, name = 'Fixture project') => ({ requestId: key(n), operationVersion: 1, type: 'team', name, description: ' description ' });
  const first = await createTeamProject(user, request(1));
  assert.equal(first.body.operation.state, 'accepted');
  const firstId = first.body.project!.id;
  assert.equal((await createTeamProject(user, { ...request(1), name: ' Fixture project ', description: 'description' })).body.project!.id, firstId);
  assert.equal((await createTeamProject(user, request(1, 'Changed'))).status, 409);
  assert.equal(projects.length, 1);
  assert.equal(logs.length, 2);
  checks.push('same_key_normalization_replay_and_different_input_conflict');
  assert.equal((await getProjectCreateOperation({ ...user, id: 'another' }, key(1))).operation.state, 'unknown');
  projects[0].status = 'deleted';
  const deleted = await getProjectCreateOperation(user, key(1));
  assert.equal(deleted.operation.state, 'accepted'); assert.equal(deleted.project, null); assert.equal(deleted.operation.projectHref, null);
  assert.equal((await closeProjectCreateOperation(user, key(1))).operation.state, 'accepted');
  assert.equal(projects.length, 1);
  projects[0].status = 'active';
  checks.push('owner_key_isolation_accepted_deleted_project_not_recreated');
  assert.equal((await getProjectCreateOperation(user, key(2))).operation.state, 'unknown');
  assert.equal((await closeProjectCreateOperation(user, key(2))).operation.state, 'closed');
  assert.equal((await createTeamProject(user, request(2))).body.operation.state, 'closed');
  assert.equal(projects.length, 1);
  assert.equal((await createTeamProject(user, request(3, ''))).body.operation.state, 'rejected');
  assert.equal((await closeProjectCreateOperation(user, key(3))).operation.state, 'closed');
  assert.equal((await createTeamProject(user, request(3))).body.operation.state, 'closed');
  await assert.rejects(createTeamProject(user, { name: 'No key' }));
  checks.push('unknown_is_not_rejected_closed_tombstone_fences_late_create');
  failAudit = true;
  await assert.rejects(createTeamProject(user, request(4)));
  failAudit = false;
  assert.equal(projects.length, 1); assert.equal((await getProjectCreateOperation(user, key(4))).operation.state, 'unknown');
  checks.push('audit_failure_rolls_back_project_membership_and_receipt_in_mock_tx');
  invite = { id: 'invite', token: 'fixture-token', project_id: firstId, project: projects[0], status: 'active', expires_at: new Date(Date.now() + 60000),
    max_uses: 2, used_count: 0, allowed_account_type: null, default_role: 'viewer', created_by: user.id };
  const duplicate = await joinProjectInvite(db, user, 'fixture-token');
  assert.equal(duplicate.deduplicated, true); assert.equal(duplicate.member.role, 'project_owner'); assert.equal(inviteUses, 0);
  const joining = { ...user, id: 'joining' };
  assert.equal((await joinProjectInvite(db, joining, 'fixture-token')).member.role, 'viewer'); assert.equal(inviteUses, 1);
  assert.equal((await joinProjectInvite(db, joining, 'fixture-token')).deduplicated, true); assert.equal(inviteUses, 1);
  members.find(row => row.user_id === 'joining')!.status = 'removed';
  assert.equal((await joinProjectInvite(db, joining, 'fixture-token')).deduplicated, false); assert.equal(inviteUses, 2);
  assert.equal((await joinProjectInvite(db, joining, 'fixture-token')).deduplicated, true); assert.equal(inviteUses, 2);
  await assert.rejects(joinProjectInvite(db, { ...user, id: 'exhausted' }, 'fixture-token'));
  checks.push('invite_active_repeat_keeps_role_new_rejoin_consumes_once_exhausted_rejects');
  logs = logs.filter(row => row.action === 'project_create' || row.action === 'project_member_join' && JSON.parse(row.detail).source === 'create_project');
  assert.deepEqual(await getProjectDeletionBlockers(db, firstId), []);
  for (const table of [...countTables, 'projectInvite', 'projectMember']) {
    countRows.set(table, 1); assert.ok((await getProjectDeletionBlockers(db, firstId)).length > 0, table); countRows.clear();
  }
  usage = true; assert.ok((await getProjectDeletionBlockers(db, firstId)).includes('使用历史')); usage = false;
  priorFlow = true; assert.ok((await getProjectDeletionBlockers(db, firstId)).includes('工具流运行历史')); priorFlow = false;
  budgetAccount = { id: 'account', budget_credits: 0, used_credits: 0, frozen_credits: 0, currency: 'credits', status: 'active', reconciliation_status: 'normal', freeze_reason: null, threshold_notified_json: null };
  assert.deepEqual(await getProjectDeletionBlockers(db, firstId), []);
  countRows.set('projectBudgetLedger', 1); assert.ok((await getProjectDeletionBlockers(db, firstId)).length); countRows.clear();
  budgetAccount.frozen_credits = 1; assert.ok((await getProjectDeletionBlockers(db, firstId)).length); budgetAccount = null;
  logs.push({ action: 'unknown_project_history', target_type: 'project', target_id: firstId, detail: null });
  assert.ok((await getProjectDeletionBlockers(db, firstId)).includes('协作或管理历史')); logs.pop();
  checks.push('all_project_relationships_history_unknown_and_nonzero_budget_block_delete');
  const listProject = { id: firstId, type: 'team', status: 'active', updated_at: projects[0].updated_at as Date };
  const emptyBlockers = await getProjectDeletionBlockers(db, firstId);
  const emptyProjection = projectListOperationProjection(listProject, true, emptyBlockers);
  assert.deepEqual(emptyProjection, {
    status_version: { status: 'active', updated_at: listProject.updated_at.toISOString() },
    can_delete: true, can_archive: true, can_restore: false,
  });
  // Zero visible task/album counts do not establish structural emptiness.
  usage = true;
  const historyProjection = projectListOperationProjection(listProject, true, await getProjectDeletionBlockers(db, firstId));
  usage = false;
  assert.equal(historyProjection.can_delete, false);
  assert.equal(historyProjection.can_archive, true);
  assert.deepEqual(Object.keys(historyProjection).sort(), ['can_archive', 'can_delete', 'can_restore', 'status_version']);
  for (const blockers of [null, emptyBlockers, ['private history']]) {
    assert.deepEqual(projectListOperationProjection(listProject, false, blockers), {
      status_version: emptyProjection.status_version,
      can_delete: false, can_archive: false, can_restore: false,
    });
  }
  assert.equal(projectListOperationProjection(listProject, true, null).can_delete, false);
  for (const type of ['personal', 'system']) {
    const projection = projectListOperationProjection({ ...listProject, type }, true, emptyBlockers);
    assert.equal(projection.can_delete, false); assert.equal(projection.can_archive, false); assert.equal(projection.can_restore, false);
  }
  const archivedProjection = projectListOperationProjection({ ...listProject, status: 'archived' }, true, emptyBlockers);
  assert.equal(archivedProjection.status_version.status, 'archived');
  assert.equal(archivedProjection.can_archive, false); assert.equal(archivedProjection.can_restore, true);
  const listRouteSource = readFileSync(path.join(root, 'src/app/api/projects/route.ts'), 'utf8');
  const viewListStart = listRouteSource.indexOf('if (viewList) {');
  const legacyListStart = listRouteSource.indexOf('    const projects = await prisma.project.findMany({', viewListStart);
  const postStart = listRouteSource.indexOf('export async function POST');
  assert.ok(viewListStart >= 0 && legacyListStart > viewListStart && postStart > legacyListStart);
  for (const source of [listRouteSource.slice(viewListStart, legacyListStart), listRouteSource.slice(legacyListStart, postStart)]) {
    assert.match(source, /const operationFields = await getProjectListOperationFields\(project, canManageProject\)/);
    assert.match(source, /\.\.\.operationFields/);
  }
  const listHelperSource = listRouteSource.slice(listRouteSource.indexOf('async function getProjectListOperationFields'), listRouteSource.indexOf('export async function GET'));
  assert.match(listHelperSource, /canManageProject && !\['personal', 'system'\]\.includes\(project\.type\)\s*\? await prisma\.\$transaction\(tx => getProjectDeletionBlockers\(tx, project\.id\)\)\s*: null/);
  assert.equal((listHelperSource.match(/getProjectDeletionBlockers\(/g) || []).length, 1);
  assert.match(listHelperSource, /return projectListOperationProjection\(project, canManageProject, blockers\)/);
  checks.push('legacy_and_paginated_list_share_version_and_capability_projection_with_manager_scoped_single_empty_check');
  checks.push('list_capabilities_distinguish_empty_history_nonmanager_unchecked_and_immutable_projects');
  const project = projects[0];
  const version = { status: project.status, updated_at: project.updated_at };
  failCas = true;
  await assert.rejects(compareAndSetProject(db, project as any, version, { status: 'deleted' }));
  assert.equal(project.status, 'active'); failCas = false;
  const beforeCas = casCalls;
  await assert.rejects(compareAndSetProject(db, project as any, { ...version, status: 'archived' }, { status: 'deleted' }));
  assert.equal(casCalls, beforeCas);
  await compareAndSetProject(db, project as any, version, { status: 'archived' });
  assert.equal(project.status, 'archived');
  await assert.rejects(assertProjectActiveInTransaction(db, user, firstId));
  project.status = 'active';
  await assertProjectActiveInTransaction(db, user, firstId);
  await assert.rejects(assertProjectActiveInTransaction(db, { ...user, id: 'stranger' }, firstId));
  project.status = 'deleted'; await assert.rejects(assertProjectActiveInTransaction(db, user, firstId));
  checks.push('cas_zero_or_stale_fails_closed_active_gate_rejects_archive_delete_or_lost_permission');
  assert.equal(forbiddenCalls, 0);
  const sources = ['scripts/project-operations-engineering.ts', 'src/lib/projects/operations.ts', 'src/lib/projects/permissions.ts',
    'src/app/api/projects/route.ts', 'src/app/api/projects/[id]/route.ts', 'src/app/api/project-invites/[token]/join/route.ts'];
  writeFileSync(destination, JSON.stringify({ schema: 'project-operations-engineering.v1', completed: true, synthetic: true,
    candidateRoot: root, startedAt, finishedAt: Date.now(), checks,
    sourceSha256: Object.fromEntries(sources.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')])),
    forbiddenCalls, productionWrites: 0, paidRequests: 0, browserRuns: 0, databaseOpened: false,
    scope: 'Isolated in-memory service fixtures only; not SQLite concurrency or functional acceptance' }), { flag: 'wx', mode: 0o600 });
  console.log('PROJECT_OPERATIONS_ENGINEERING_RECEIPT=' + destination);
}

void main().catch(error => { console.error(error instanceof Error ? error.message : 'Project fixture failed'); process.exitCode = 1; });
