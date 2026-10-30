import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { PrismaClient } from '@prisma/client';
import type { SessionUser } from '../src/lib/auth/session';
import type { StudioAssetInput, StudioRunSnapshot, StudioTemplateRecipe } from '../src/lib/template-studio/types';

type FixtureResult = { fixture: 'pricing-video-context-contract'; completed: true; assertions: number; evidence: string[] };
type DatabaseEntry = { name: string; file: string };

function contained(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function assertDatabase(client: PrismaClient, filename: string) {
  const databases = await client.$queryRawUnsafe<DatabaseEntry[]>('PRAGMA database_list');
  const main = databases.find(database => database.name === 'main');
  assert.ok(main?.file, 'Global Prisma must use the explicit on-disk fixture database');
  assert.equal(fs.realpathSync(main.file), filename, 'Global Prisma must not point at a different database');
}

async function tableCounts(client: PrismaClient) {
  const tables = await client.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations' ORDER BY name",
  );
  for (const name of ['User', 'Project', 'VideoCard', 'VideoStudioDraft', 'VideoStudioRun', 'Asset', 'CreditAccount', 'CreditLedger', 'ApprovalRecord']) {
    assert.ok(tables.some(table => table.name === name), `Initialized fixture schema must contain ${name}`);
  }
  const counts: Record<string, number> = {};
  for (const table of tables) {
    assert.match(table.name, /^[A-Za-z_][A-Za-z0-9_]*$/, 'Only schema-owned table identifiers may enter the count query');
    const result = await client.$queryRawUnsafe<Array<{ amount: bigint | number }>>(`SELECT COUNT(*) AS amount FROM "${table.name}"`);
    counts[table.name] = Number(result[0].amount);
  }
  return counts;
}

function fileProjection(root: string) {
  const files: Array<{ path: string; size: number; hash: string }> = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, 'Fixture media tree must never contain storage symlinks');
      if (entry.isDirectory()) visit(filename);
      else {
        assert.ok(entry.isFile(), 'Fixture media tree contains only private directories and files');
        const bytes = fs.readFileSync(filename);
        files.push({ path: path.relative(root, filename), size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  };
  visit(root);
  return files;
}

async function protectedProjection(client: PrismaClient) {
  return {
    counts: await tableCounts(client),
    users: await client.user.findMany({ orderBy: { id: 'asc' } }),
    settings: await client.platformSetting.findMany({ orderBy: { key: 'asc' } }),
    tasks: await client.videoTask.findMany({ orderBy: { id: 'asc' } }),
    wallets: await client.creditAccount.findMany({ orderBy: { id: 'asc' } }),
    buckets: await client.creditBucket.findMany({ orderBy: { id: 'asc' } }),
    ledger: await client.creditLedger.findMany({ orderBy: { id: 'asc' } }),
    budgets: await client.projectBudgetAccount.findMany({ orderBy: { id: 'asc' } }),
    budgetLedger: await client.projectBudgetLedger.findMany({ orderBy: { id: 'asc' } }),
    workspaces: await client.workspace.findMany({ orderBy: { id: 'asc' } }),
    workspaceAssets: await client.workspaceAsset.findMany({ orderBy: { id: 'asc' } }),
    approvals: await client.approvalRecord.findMany({ orderBy: { id: 'asc' } }),
    approvalUsage: await client.approvalUsage.findMany({ orderBy: { id: 'asc' } }),
    drafts: await client.videoStudioDraft.findMany({ orderBy: { id: 'asc' } }),
    runs: await client.videoStudioRun.findMany({ orderBy: { id: 'asc' } }),
    assets: await client.asset.findMany({ orderBy: { id: 'asc' } }),
    projects: await client.project.findMany({ orderBy: { id: 'asc' } }),
    members: await client.projectMember.findMany({ orderBy: { id: 'asc' } }),
    cards: await client.videoCard.findMany({ orderBy: { id: 'asc' } }),
    templates: await client.videoStudioTemplate.findMany({ orderBy: { id: 'asc' } }),
    versions: await client.videoStudioTemplateVersion.findMany({ orderBy: { id: 'asc' } }),
  };
}

// No top-level execution: G29 supplies a fresh schema and awaits this function.
export async function runPricingVideoContextContractFixture(): Promise<FixtureResult> {
  assert.equal(process.env.NODE_ENV, 'test', 'Video context fixture requires the isolated test environment');
  assert.equal(Object.hasOwn(process.env, 'HD_DERIVATIVES_ROOT'), false, 'Production derivative storage must not enter this fixture');
  const originalCwd = process.cwd(), candidateRoot = fs.realpathSync(originalCwd);
  const roleRoot = fs.realpathSync(path.join(candidateRoot, '.role-tests'));
  assert.ok(contained(candidateRoot, roleRoot), '.role-tests must resolve inside the candidate, not production storage');
  const supplied = process.env.PRICING_VIDEO_CONTEXT_FIXTURE_DB;
  assert.ok(supplied && path.isAbsolute(supplied), 'PRICING_VIDEO_CONTEXT_FIXTURE_DB must be an explicit absolute path');
  const filename = fs.realpathSync(supplied);
  assert.ok(contained(roleRoot, filename), 'Fixture database must be under the candidate .role-tests directory');
  assert.ok(fs.statSync(filename).isFile());
  assert.equal(fs.statSync(filename).nlink, 1, 'Fixture database must not be a hard link to another database');
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(typeof databaseUrl === 'string' && databaseUrl.startsWith('file:') && path.isAbsolute(databaseUrl.slice(5)), 'DATABASE_URL must be the explicit fixture SQLite path');
  assert.equal(fs.realpathSync(databaseUrl.slice(5)), filename, 'DATABASE_URL and the supplied fixture DB must be the same file');
  const cached = (globalThis as unknown as { prisma?: PrismaClient }).prisma;
  if (cached) await assertDatabase(cached, filename);

  const runtime = fs.mkdtempSync(path.join(roleRoot, 'pricing-video-context-runtime-'));
  fs.chmodSync(runtime, 0o700);
  assert.ok(contained(roleRoot, fs.realpathSync(runtime)));
  const secretBefore = process.env.SESSION_SECRET;
  const fixtureSecret = `pricing-video-context-fixture-only-${randomUUID()}`;
  let client: PrismaClient | undefined, seeded = false, assertions = 0;
  const evidence: string[] = [];
  const nonce = randomUUID();
  const id = (name: string) => `pvc-${nonce}-${name}`;
  const ids = {
    users: ['actor-a', 'actor-b', 'outsider', 'external', 'legacy-email'].map(id),
    projects: ['personal', 'team', 'public', 'foreign'].map(id),
    cards: ['personal-card-a', 'personal-card-b', 'team-card', 'public-card', 'foreign-card', 'archived-card'].map(id),
    assets: ['video-a', 'video-b'].map(id), template: id('template'), version: id('template-version'),
    draft: id('studio-draft'), run: id('studio-run'), task: id('accepted-draft-task'), workspace: id('workspace'),
    approval: id('approval'), settings: id('settings'), budget: id('budget'),
  };
  const equal = (actual: unknown, expected: unknown, label: string) => { assert.deepEqual(actual, expected, label); assertions++; };
  const ok = (condition: unknown, label: string) => { assert.ok(condition, label); assertions++; };
  const session = (index: number, accountType: SessionUser['account_type'] = 'internal', withFeishu = true): SessionUser => ({
    id: ids.users[index], name: `Fixture actor ${index}`, username: id(`user-${index}`),
    email: `${id(`user-${index}`)}@fixture.invalid`, role: 'user', account_type: accountType, user_profile: 'other', feature_profile_id: null,
    status: 'active', expires_at: null,
    ...(withFeishu ? { feishu: { user_id: id(`feishu-user-${index}`), open_id: id(`feishu-open-${index}`),
      union_id: id(`feishu-union-${index}`), tenant_key: id('feishu-tenant'), employee_no: id(`employee-${index}`),
      department_ids: [id('department')], last_sync_at: null } } : {}),
  });
  const actorA = session(0), actorB = session(1), outsider = session(2);
  const external = session(3, 'external'), legacyEmail = session(4, 'internal', false);
  const actors = [actorA, actorB, outsider, external, legacyEmail];
  const videoUrls = ids.assets.map(assetId => `/uploads/pricing-video-context-fixture/${assetId}.mp4`);
  const recipe: StudioTemplateRecipe = { instruction: 'Private production direction for isolated scope verification.', fields: [],
    assetSlots: [{ key: 'referenceVideo', label: 'Reference video', role: 'reference', types: ['video'], required: true, maxItems: 1 }],
    defaultParameters: {} };
  const inputs: StudioAssetInput[] = [{ assetId: ids.assets[0], type: 'video', role: 'reference', slotKey: 'referenceVideo' }];
  const prompt = 'A fixture subject turns once.';
  const snapshot: StudioRunSnapshot = { input: { name: 'Fixture video', groupName: 'Fixture', values: {}, draftPrompt: prompt },
    templateVersion: { templateId: ids.template, templateSource: 'studio', versionId: ids.version, versionNumber: 1,
      templateName: 'Fixture private template', sourceRevision: 'studio:1' }, recipe, prompt, parameters: { duration: 5, resolution: '480p' }, assets: inputs,
    owner: { userId: actorA.id, username: actorA.username, displayName: actorA.name, accountType: 'internal' },
    privateContext: { global: '', module: recipe.instruction, globalRevision: 1, moduleRevision: 1 } };

  const cleanup = async () => {
    if (!client || !seeded) return;
    await assertDatabase(client, filename);
    await client.$transaction(async tx => {
      await tx.approvalUsage.deleteMany({ where: { approval_id: ids.approval } });
      await tx.approvalRecord.deleteMany({ where: { id: ids.approval } });
      await tx.creditLedger.deleteMany({ where: { user_id: { in: ids.users } } });
      await tx.creditBucket.deleteMany({ where: { user_id: { in: ids.users } } });
      await tx.creditAccount.deleteMany({ where: { user_id: { in: ids.users } } });
      await tx.projectBudgetLedger.deleteMany({ where: { project_id: { in: ids.projects } } });
      await tx.projectBudgetAccount.deleteMany({ where: { project_id: { in: ids.projects } } });
      await tx.videoTask.deleteMany({ where: { id: ids.task } });
      await tx.workspaceAsset.deleteMany({ where: { workspace_id: ids.workspace } });
      await tx.workspace.deleteMany({ where: { id: ids.workspace } });
      await tx.videoStudioRun.deleteMany({ where: { id: ids.run } });
      await tx.videoStudioDraft.deleteMany({ where: { id: ids.draft } });
      await tx.videoStudioTemplate.updateMany({ where: { id: ids.template }, data: { published_version_id: null } });
      await tx.videoStudioTemplateVersion.deleteMany({ where: { id: ids.version } });
      await tx.videoStudioTemplate.deleteMany({ where: { id: ids.template } });
      await tx.asset.deleteMany({ where: { id: { in: ids.assets } } });
      await tx.videoCard.deleteMany({ where: { id: { in: ids.cards } } });
      await tx.projectMember.deleteMany({ where: { project_id: { in: ids.projects } } });
      await tx.project.deleteMany({ where: { id: { in: ids.projects } } });
      await tx.platformSetting.deleteMany({ where: { key: ids.settings } });
      await tx.user.deleteMany({ where: { id: { in: ids.users } } });
      await tx.platformSetting.deleteMany({ where: { key: { in: ['catalog_directory_revision_v1:templates', 'catalog_directory_revision_v1:assets'] } } });
    }, { maxWait: 10000, timeout: 30000 });
    seeded = false;
    ok(Object.values(await tableCounts(client)).every(count => count === 0), 'Owned fixture rows are removed and the supplied database is empty again');
  };

  try {
    process.chdir(runtime);
    process.env.SESSION_SECRET = fixtureSecret;
    fs.mkdirSync(path.join(runtime, 'public/uploads/pricing-video-context-fixture'), { recursive: true, mode: 0o700 });
    for (const [index, url] of Array.from(videoUrls.entries())) {
      fs.writeFileSync(path.join(runtime, 'public', url.slice(1)), Buffer.from(`Readable fixture bytes ${index}; not a decoded video.`), { flag: 'wx', mode: 0o600 });
    }
    // Load after the cwd guard, using one graph for runtime functions and Error classes.
    const loadRuntime = createRequire(path.join(candidateRoot, 'package.json'));
    const databaseRuntime: typeof import('../src/lib/prisma') = loadRuntime(path.join(candidateRoot, 'src/lib/prisma.ts'));
    client = databaseRuntime.prisma;
    await assertDatabase(client, filename);
    ok(Object.values(await tableCounts(client)).every(count => count === 0), 'Every business table must be empty before any committed seed');
    const contextRuntime: typeof import('../src/lib/pricing/video-context') = loadRuntime(path.join(candidateRoot, 'src/lib/pricing/video-context.ts'));
    const chargeRuntime: typeof import('../src/lib/pricing/frozen-charge') = loadRuntime(path.join(candidateRoot, 'src/lib/pricing/frozen-charge.ts'));
    const accessRuntime: typeof import('../src/lib/access/external-role') = loadRuntime(path.join(candidateRoot, 'src/lib/access/external-role.ts'));
    const { resolveVideoPricingContext, savedVideoPricingContextInput, issueVideoPricingCredential, verifyVideoPricingCredential, assertVideoPricingFinalReferences, VideoPricingContextError } = contextRuntime;
    const { PricingChargeError } = chargeRuntime;
    const { isExternalUser } = accessRuntime;
    const directError = new PricingChargeError('fixture class identity');
    ok(directError instanceof PricingChargeError, 'Direct errors retain the real runtime class');
    equal(directError.constructor, PricingChargeError, 'Direct constructor identity is stable');
    equal(Object.getPrototypeOf(directError), PricingChargeError.prototype, 'Direct prototype identity is stable');
    const db = client;
    const seed = await db.$transaction(async tx => {
      for (const actor of actors) await tx.user.create({ data: { id: actor.id, name: actor.name, username: actor.username,
        email: actor.email, password_hash: 'fixture-only-no-login', role: actor.role, account_type: actor.account_type,
        user_profile: actor.user_profile, feature_profile_id: actor.feature_profile_id, status: actor.status, expires_at: actor.expires_at,
        feishu_user_id: actor.feishu?.user_id ?? null, feishu_open_id: actor.feishu?.open_id ?? null,
        feishu_union_id: actor.feishu?.union_id ?? null, feishu_tenant_key: actor.feishu?.tenant_key ?? null,
        feishu_employee_no: actor.feishu?.employee_no ?? null,
        feishu_department_ids: actor.feishu ? JSON.stringify(actor.feishu.department_ids) : null,
        last_feishu_sync_at: actor.feishu?.last_sync_at ?? null } });
      for (const [index, projectId] of Array.from(ids.projects.entries())) await tx.project.create({ data: { id: projectId, name: id(`project-${index}`),
        type: ['personal', 'team', 'public', 'personal'][index], visibility: 'private', status: 'active',
        owner_user_id: index === 3 ? actorB.id : actorA.id, created_by: index === 3 ? actorB.id : actorA.id } });
      const member = await tx.projectMember.create({ data: { project_id: ids.projects[1], user_id: actorB.id, role: 'editor', status: 'active', joined_by: actorA.id } });
      await tx.projectMember.create({ data: { project_id: ids.projects[1], user_id: outsider.id, role: 'viewer', status: 'active', joined_by: actorA.id } });
      for (const actor of [external, legacyEmail]) await tx.projectMember.create({ data: {
        project_id: ids.projects[1], user_id: actor.id, role: 'editor', status: 'active', joined_by: actorA.id } });
      const cardProjects = [0, 0, 1, 2, 3, 0];
      for (const [index, cardId] of Array.from(ids.cards.entries())) await tx.videoCard.create({ data: { id: cardId, project_id: ids.projects[cardProjects[index]],
        title: id(`card-${index}`), created_by: index === 4 ? actorB.id : actorA.id, owner_user_id: index === 4 ? actorB.id : actorA.id,
        status: index === 5 ? 'archived' : 'active' } });
      await tx.platformSetting.create({ data: { key: ids.settings, value_json: JSON.stringify({ fixture: 'video-context', untouched: true }) } });
      await tx.workspace.create({ data: { id: ids.workspace, owner_id: actorA.id, name: 'Existing fixture workspace' } });
      for (const [index, assetId] of Array.from(ids.assets.entries())) {
        const bytes = fs.readFileSync(path.join(runtime, 'public', videoUrls[index].slice(1)));
        await tx.asset.create({ data: { id: assetId, owner_id: actorA.id, type: 'video', original_url: videoUrls[index],
          file_name: `${assetId}.mp4`, mime_type: 'video/mp4', file_size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'), status: 'active' } });
      }
      await tx.workspaceAsset.create({ data: { workspace_id: ids.workspace, asset_id: ids.assets[0], role: 'reference_video' } });
      const template = await tx.videoStudioTemplate.create({ data: { id: ids.template, owner_user_id: actorA.id, name: 'Fixture private template',
        group_name: 'Fixture', status: 'published', visibility: 'private', recipe_json: JSON.stringify(recipe), revision: 1 } });
      await tx.videoStudioTemplateVersion.create({ data: { id: ids.version, template_id: ids.template, version_number: 1,
        name: template.name, group_name: template.group_name, recipe_json: JSON.stringify(recipe), created_by: actorA.id } });
      const published = await tx.videoStudioTemplate.update({ where: { id: ids.template }, data: { published_version_id: ids.version } });
      await tx.videoStudioDraft.create({ data: { id: ids.draft, owner_user_id: actorA.id, name: 'Saved fixture draft', prompt,
        source_template_id: ids.template, source_version_id: ids.version, template_source: 'studio', revision: 1,
        assets_json: JSON.stringify(inputs), parameters_json: JSON.stringify(snapshot.parameters), template_snapshot_json: JSON.stringify(snapshot.templateVersion) } });
      await tx.videoStudioRun.create({ data: { id: ids.run, owner_user_id: actorA.id, draft_id: ids.draft, draft_revision: 1,
        request_id: id('run-request'), request_fingerprint: id('run-fingerprint'), source: 'studio', mode: 'direct', status: 'succeeded',
        delivery_state: 'not_sent', prompt, snapshot_json: JSON.stringify(snapshot), completed_at: new Date() } });
      await tx.videoTask.create({ data: { id: ids.task, provider: 'seedance', model: 'dreamina-seedance-2-0-260128', generation_mode: 'multimodal',
        prompt, local_status: 'succeeded', is_draft: true, provider_task_id: id('original-provider-request'), user_id: actorA.id, owner_user_id: actorA.id,
        project_id: ids.projects[0], video_card_id: ids.cards[0], workspace_id: ids.workspace, ratio: '16:9', duration: 5, resolution: '480p',
        reference_video_urls: JSON.stringify(videoUrls.slice(0, 1)), frozen_cost: 0.05, billing_scope: 'user', billing_account_id: actorA.id } });
      await tx.creditAccount.create({ data: { user_id: actorA.id, balance: 20.15, frozen_credits: 0.05, monthly_used: 0.1, total_used: 0.1 } });
      await tx.creditBucket.create({ data: { user_id: actorA.id, source_type: 'daily_quota', amount_total: 2, amount_remaining: 2, idempotency_key: id('bucket') } });
      await tx.creditLedger.create({ data: { user_id: actorA.id, type: 'admin_grant', amount: 20.2, balance_before: 0, balance_after: 20.2,
        frozen_before: 0, frozen_after: 0, idempotency_key: id('grant') } });
      await tx.creditLedger.create({ data: { user_id: actorA.id, type: 'task_freeze', amount: -0.05, balance_before: 20.2, balance_after: 20.15,
        frozen_before: 0, frozen_after: 0.05, related_task_id: ids.task, idempotency_key: id('freeze') } });
      await tx.projectBudgetAccount.create({ data: { id: ids.budget, project_id: ids.projects[2], budget_credits: 100, created_by: actorA.id } });
      await tx.projectBudgetLedger.create({ data: { project_id: ids.projects[2], account_id: ids.budget, type: 'budget_grant', amount: 100,
        budget_before: 0, budget_after: 100, used_before: 0, used_after: 0, frozen_before: 0, frozen_after: 0, idempotency_key: id('budget-grant') } });
      await tx.approvalRecord.create({ data: { id: ids.approval, type: 'resolution_1080p', status: 'approved', effect_status: 'applied',
        project_id: ids.projects[1], video_card_id: ids.cards[2], requester_user_id: actorA.id, approver_user_id: actorB.id,
        usage_limit: 1, used_count: 0, approved_at: new Date() } });
      return { member, template: published };
    }, { maxWait: 10000, timeout: 30000 });
    seeded = true;
    const baseline = await protectedProjection(db), mediaBaseline = fileProjection(runtime);
    for (const actor of actors) {
      const persisted = baseline.users.find(user => user.id === actor.id);
      ok(persisted, 'Every session actor has a committed fixture user');
      equal({ role: persisted!.role, accountType: persisted!.account_type, profile: persisted!.feature_profile_id,
        feishuUser: persisted!.feishu_user_id, feishuOpen: persisted!.feishu_open_id, feishuUnion: persisted!.feishu_union_id },
      { role: actor.role, accountType: actor.account_type, profile: actor.feature_profile_id,
        feishuUser: actor.feishu?.user_id ?? null, feishuOpen: actor.feishu?.open_id ?? null, feishuUnion: actor.feishu?.union_id ?? null },
      'Session account authorization fields match the persisted seed without administrator privileges');
      equal(actor.role, 'user', 'Positive and negative cases remain ordinary users');
    }
    for (const actor of [actorA, actorB, outsider]) equal(isExternalUser(actor), false, 'Internal fixture users carry the real persisted Feishu identity');
    equal(isExternalUser(external), true, 'Explicit external account stays external even with Feishu identity');
    equal(isExternalUser(legacyEmail), true, 'The historical internal label alone does not authorize an email account');
    equal(baseline.runs[0].status, 'succeeded', 'Resolver reads a genuinely persisted successful studio run');
    equal(JSON.parse(baseline.runs[0].snapshot_json).assets, inputs, 'Persisted snapshot contains the video reference');
    equal(baseline.wallets[0].balance, 20.15, 'Non-integer existing wallet value participates in the no-write comparison');
    equal(baseline.ledger.length, 2, 'Existing grant and freeze ledger rows are present before read-only calls');
    equal(baseline.approvals[0].used_count, 0, 'Approved entitlement begins unconsumed');
    equal(mediaBaseline.length, 2, 'Only two private readable-byte media fixtures exist');

    const readOnly = async <T>(label: string, action: () => Promise<T>): Promise<T> => {
      const before = await protectedProjection(db), filesBefore = fileProjection(runtime);
      try { return await action(); }
      finally {
        equal(await protectedProjection(db), before, `${label}: all business counts and protected row projections remain unchanged`);
        equal(fileProjection(runtime), filesBefore, `${label}: no upload, file rewrite or generated media`);
      }
    };
    const rejected = async (action: () => Promise<unknown>, expected: RegExp, status?: number) => {
      await assert.rejects(action, (error: unknown) => (error instanceof VideoPricingContextError || error instanceof PricingChargeError)
        && expected.test(error.message) && (status === undefined || error.status === status));
      assertions++;
    };
    const rejectsCredential = (action: () => unknown, label: string) => {
      let actual: unknown;
      assert.throws(() => { try { action(); } catch (error) { actual = error; throw error; } }, PricingChargeError, label); assertions++;
      assert.ok(actual instanceof PricingChargeError); assertions++;
      equal(actual.constructor, PricingChargeError, `${label}: real constructor identity`);
      equal(Object.getPrototypeOf(actual), PricingChargeError.prototype, `${label}: real prototype identity`);
      equal(actual.status, 409, `${label}: refused with the real status`);
      equal(actual.code, 'pricing_quote_changed', `${label}: real pricing refusal code`);
      equal(actual.message, '报价范围或有效期已变化，请保留输入重新报价；尚未生成', `${label}: real refusal message`);
    };
    const plain = { project_id: ids.projects[0], video_card_id: ids.cards[0], provider: 'seedance', model: 'dreamina-seedance-2-0-260128',
      resolution: '480p', ratio: '16:9', duration: 5, draft: false, reference_video_urls: [] };
    const templateBody = { ...plain, template_studio_run_id: ids.run, template_studio_assets: inputs };
    const revision = id('pricing-revision'), amount = 24.1;

    await readOnly('Saved template video and exact final references', async () => {
      const context = await resolveVideoPricingContext(actorA, templateBody);
      equal(context.referenceVideo, 'present', 'Empty body video list cannot hide saved template video');
      equal(context.referenceVideoCount, 1, 'Saved video is counted once');
      equal(context.purpose, 'standard', 'Ordinary non-draft template request is standard');
      equal(context.templateRunId, ids.run, 'Context retains the authorized run identity');
      assertVideoPricingFinalReferences(context, [videoUrls[0]]); assertions++;
      assert.throws(() => assertVideoPricingFinalReferences(context, [videoUrls[1]]), VideoPricingContextError, 'Same count with a different video cannot use the old scope'); assertions++;
      assert.throws(() => assertVideoPricingFinalReferences(context, []), VideoPricingContextError); assertions++;
      const overriddenBody = await resolveVideoPricingContext(actorA, { ...templateBody, reference_video_urls: [videoUrls[1]] });
      equal(overriddenBody.fingerprint, context.fingerprint, 'Saved submitted template assets, not body-only media, define final scope');
      const token = issueVideoPricingCredential(context, revision, amount);
      verifyVideoPricingCredential(token, context, revision, amount); assertions++;
      const payloadText = Buffer.from(token.split('.')[0], 'base64url').toString('utf8');
      for (const privateValue of [...videoUrls, ids.template, ids.run, recipe.instruction, prompt]) {
        equal(payloadText.includes(privateValue), false, 'Pricing credential does not expose private media, template or prompt content');
      }
    });
    evidence.push('Real committed studio draft/run/version and owner video pass the actual handoff/assets resolver; empty body remains present, final same-count substitution is rejected.');

    await readOnly('None, purposes and credential scope binding', async () => {
      const standard = await resolveVideoPricingContext(actorA, plain);
      equal(standard.referenceVideo, 'none', 'No template and no reference video is none');
      equal(standard.referenceVideoCount, 0, 'No reference video has a zero count');
      assertVideoPricingFinalReferences(standard, []); assertions++;
      const draft = await resolveVideoPricingContext(actorA, { ...plain, draft: true, pricingPurpose: 'standard', pricing_purpose: 'standard' });
      const acceptedDraft = await db.videoTask.findUniqueOrThrow({ where: { id: ids.task } });
      const upgradeInput = { ...savedVideoPricingContextInput(acceptedDraft, true), pricingPurpose: 'standard', pricing_purpose: 'standard' };
      const upgrade = await resolveVideoPricingContext(actorA, upgradeInput, 'draft_upgrade');
      equal(draft.purpose, 'draft', 'Body standard claim cannot relabel a draft');
      equal(upgrade.purpose, 'draft_upgrade', 'Server upgrade operation overrides a body standard claim');
      equal(upgrade.referenceVideo, 'present', 'Upgrade context preserves the saved draft task reference video');
      const sameInputCreate = await resolveVideoPricingContext(actorA, upgradeInput);
      rejectsCredential(() => verifyVideoPricingCredential(issueVideoPricingCredential(sameInputCreate, revision, amount), upgrade, revision, amount), 'Changing only the trusted operation purpose invalidates the credential');
      const token = issueVideoPricingCredential(standard, revision, amount);
      verifyVideoPricingCredential(token, standard, revision, amount); assertions++;
      for (const context of [draft, upgrade,
        await resolveVideoPricingContext(actorA, { ...plain, video_card_id: ids.cards[1] }),
        await resolveVideoPricingContext(actorA, { ...plain, project_id: ids.projects[1], video_card_id: ids.cards[2] }),
        await resolveVideoPricingContext(actorA, { ...plain, duration: 6 }),
        await resolveVideoPricingContext(actorA, { ...plain, resolution: '720p' }),
        await resolveVideoPricingContext(actorA, { ...plain, reference_video_urls: [videoUrls[0]] }),
      ]) rejectsCredential(() => verifyVideoPricingCredential(token, context, revision, amount), 'Purpose, card, project, parameters or media change cannot reuse a quote');
      const teamA = await resolveVideoPricingContext(actorA, { ...plain, project_id: ids.projects[1], video_card_id: ids.cards[2] });
      const teamB = await resolveVideoPricingContext(actorB, { ...plain, project_id: ids.projects[1], video_card_id: ids.cards[2] });
      equal(teamA.payer, { kind: 'user', id: actorA.id }, 'Team project follows the current personal-wallet contract');
      rejectsCredential(() => verifyVideoPricingCredential(issueVideoPricingCredential(teamA, revision, amount), teamB, revision, amount), 'Another allowed actor cannot reuse the credential');
      const publicContext = await resolveVideoPricingContext(actorA, { ...plain, project_id: ids.projects[2], video_card_id: ids.cards[3] });
      equal(publicContext.payer, { kind: 'project', id: ids.projects[2] }, 'Public project quote binds the actual project-budget payer');
      rejectsCredential(() => verifyVideoPricingCredential(token, publicContext, revision, amount), 'Personal-wallet credential cannot authorize project-budget payment');
      rejectsCredential(() => verifyVideoPricingCredential(`${token}x`, standard, revision, amount), 'Credential signature tampering is rejected');
      rejectsCredential(() => verifyVideoPricingCredential(token, standard, `${revision}-changed`, amount), 'Another pricing revision is rejected');
      rejectsCredential(() => verifyVideoPricingCredential(token, standard, revision, amount + 0.1), 'A changed amount or ceiling is rejected');
      const expiredPayload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
      expiredPayload.expires = Date.now() - 1000;
      const expiredBody = Buffer.from(JSON.stringify(expiredPayload)).toString('base64url');
      const expiredSignature = createHmac('sha256', fixtureSecret).update(`video-pricing-context-v1\0${expiredBody}`).digest('base64url');
      rejectsCredential(() => verifyVideoPricingCredential(`${expiredBody}.${expiredSignature}`, standard, revision, amount), 'A correctly signed but expired fixture credential is rejected without changing the clock');
    });
    evidence.push('Real resolver derives none/draft/draft_upgrade, actor/project/card/parameter/payer bindings; real issue/verify rejects tampering, changed revision/ceiling and a genuinely signed expired token.');

    await readOnly('Template role and required-slot refusals', async () => {
      await rejected(() => resolveVideoPricingContext(actorA, { ...templateBody, template_studio_assets: [] }), /必填素材/);
      await rejected(() => resolveVideoPricingContext(actorA, { ...templateBody, template_studio_assets: [{ ...inputs[0], role: 'first' }] }), /角色/);
      await rejected(() => resolveVideoPricingContext(actorA, { ...templateBody, template_studio_assets: [{ ...inputs[0], slotKey: 'forgedSlot' }] }), /角色|槽位/);
      await rejected(() => resolveVideoPricingContext(actorA, { ...templateBody, template_studio_assets: undefined }), /缺少最终素材/);
      await rejected(() => resolveVideoPricingContext(actorB, { ...templateBody, project_id: ids.projects[1], video_card_id: ids.cards[2] }), /运行记录不存在或无权访问/, 404);
      await rejected(() => resolveVideoPricingContext(outsider, { ...plain, project_id: ids.projects[1], video_card_id: ids.cards[2] }), /无权/, 403);
      await rejected(() => resolveVideoPricingContext(actorA, { ...plain, project_id: ids.projects[3], video_card_id: ids.cards[4] }), /无权/, 403);
      await rejected(() => resolveVideoPricingContext(actorA, { ...plain, project_id: ids.projects[1] }), /视频卡不属于当前项目/, 400);
      await rejected(() => resolveVideoPricingContext(actorA, { ...plain, video_card_id: ids.cards[5] }), /封板或归档/, 403);
    });
    await readOnly('External and legacy email template-studio refusals', async () => {
      const allowedProject = { ...plain, project_id: ids.projects[1], video_card_id: ids.cards[2] };
      for (const actor of [external, legacyEmail]) {
        const context = await resolveVideoPricingContext(actor, allowedProject);
        equal(context.projectId, ids.projects[1], 'External negative cases first pass their real editor project/card permissions');
        equal(context.referenceVideo, 'none', 'A permitted non-template project scope remains distinct from internal studio access');
        await rejected(() => resolveVideoPricingContext(actor, { ...allowedProject,
          template_studio_run_id: ids.run, template_studio_assets: inputs }), /外部账号无权访问视频模板工作台/, 403);
      }
    });
    evidence.push('Ordinary internal actors use committed Feishu/session account fields; explicit external and legacy email-only internal labels pass their own project/card scope but are refused by the real template-studio internal-account gate without writes.');

    await db.projectMember.update({ where: { id: seed.member.id }, data: { status: 'removed' } });
    try {
      await readOnly('Revoked project membership', async () => {
        await rejected(() => resolveVideoPricingContext(actorB, { ...plain, project_id: ids.projects[1], video_card_id: ids.cards[2] }), /无权/, 403);
      });
    } finally { await db.projectMember.update({ where: { id: seed.member.id }, data: { status: seed.member.status } }); }
    await db.asset.update({ where: { id: ids.assets[0] }, data: { owner_id: actorB.id } });
    try {
      await readOnly('Revoked source video access', async () => {
        await rejected(() => resolveVideoPricingContext(actorA, templateBody), /无权使用此素材/, 403);
      });
    } finally { await db.asset.update({ where: { id: ids.assets[0] }, data: { owner_id: actorA.id } }); }
    await db.asset.update({ where: { id: ids.assets[0] }, data: { status: 'hidden' } });
    try {
      await readOnly('Unavailable saved video', async () => {
        await rejected(() => resolveVideoPricingContext(actorA, templateBody), /素材不存在|已停用|无权/, 403);
      });
    } finally { await db.asset.update({ where: { id: ids.assets[0] }, data: { status: 'active' } }); }
    await db.videoStudioTemplate.update({ where: { id: ids.template }, data: { owner_user_id: actorB.id } });
    try {
      await readOnly('Revoked template access', async () => {
        await rejected(() => resolveVideoPricingContext(actorA, templateBody), /模板不存在或无权访问/, 404);
      });
    } finally { await db.videoStudioTemplate.update({ where: { id: ids.template }, data: { owner_user_id: actorA.id, updated_at: seed.template.updated_at } }); }
    evidence.push('Real project membership, card ownership/status, private template and saved asset checks reject revoked access, missing slots and forged roles instead of returning none.');
    equal(await protectedProjection(db), baseline, 'After controlled negative-case seed changes are restored, every protected row and all business counts match the committed baseline');
    equal(fileProjection(runtime), mediaBaseline, 'Resolver and credentials never upload, rewrite or generate fixture media');
    evidence.push('All business-table counts plus existing settings/tasks/wallets/buckets/ledgers/budgets/workspaces/approvals/drafts/runs/assets/projects/card/template projections are compared before and after each read-only group.');
    evidence.push('Media evidence is private synthetic readable bytes only, not decoding, generation, supplier acceptance or fee evidence.');
  } finally {
    try { await cleanup(); }
    finally {
      try { await client?.$disconnect(); }
      finally {
        if (secretBefore === undefined) delete process.env.SESSION_SECRET;
        else process.env.SESSION_SECRET = secretBefore;
        process.chdir(originalCwd);
        assert.ok(contained(roleRoot, fs.realpathSync(runtime)), 'Cleanup is limited to the created private fixture runtime');
        fs.rmSync(runtime, { recursive: true, force: true });
      }
    }
  }
  return { fixture: 'pricing-video-context-contract', completed: true, assertions, evidence };
}
