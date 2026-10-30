import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { CodexVideoApiSettings } from '../src/lib/integrations/codex';

type FixtureResult = {
  fixture: 'pricing-request-status-contract';
  completed: true;
  assertions: number;
  evidence: string[];
};
type DatabaseEntry = { name: string; file: string };
type DatabaseProjection = Record<string, { rows: number; sha256: string }>;

function contained(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertDatabase(client: PrismaClient, filename: string) {
  const databases = await client.$queryRawUnsafe<DatabaseEntry[]>('PRAGMA database_list');
  const main = databases.find(database => database.name === 'main');
  assert.ok(main?.file, 'Request-status fixture requires an explicit on-disk database');
  assert.equal(fs.realpathSync(main.file), filename, 'Prisma must use the same guarded fixture database');
}

async function databaseProjection(client: PrismaClient): Promise<DatabaseProjection> {
  const tables = await client.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations' ORDER BY name",
  );
  const projection: DatabaseProjection = {};
  for (const { name } of tables) {
    assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/, 'Only real schema identifiers may enter the projection query');
    const rows = await client.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM "${name}"`);
    const serialized = rows.map(row => JSON.stringify(row, (_key, value: unknown) => (
      typeof value === 'bigint' ? { bigint: value.toString() } : value
    ))).sort();
    // Compare every persisted value without including fixture credentials in assertion output.
    projection[name] = { rows: rows.length, sha256: createHash('sha256').update(JSON.stringify(serialized)).digest('hex') };
  }
  return projection;
}

// G30 supplies the empty schema and awaits this function; importing it never runs a fixture.
export async function runPricingRequestStatusContractFixture(): Promise<FixtureResult> {
  assert.equal(process.env.NODE_ENV, 'test', 'Request-status fixture requires the isolated test environment');
  assert.equal(Object.hasOwn(process.env, 'HD_DERIVATIVES_ROOT'), false, 'Production derivative storage must not enter this fixture');
  const candidateRoot = fs.realpathSync(process.cwd());
  const roleRoot = fs.realpathSync(path.join(candidateRoot, '.role-tests'));
  assert.ok(contained(candidateRoot, roleRoot), '.role-tests must resolve inside the candidate');
  const supplied = process.env.PRICING_REQUEST_STATUS_FIXTURE_DB;
  assert.ok(supplied && path.isAbsolute(supplied), 'PRICING_REQUEST_STATUS_FIXTURE_DB must be an explicit absolute path');
  const suppliedStat = fs.lstatSync(supplied);
  assert.ok(suppliedStat.isFile() && !suppliedStat.isSymbolicLink(), 'Fixture database must be a regular file, not a symlink');
  assert.equal(suppliedStat.nlink, 1, 'Fixture database must not be a hard link to another database');
  const filename = fs.realpathSync(supplied);
  assert.ok(contained(roleRoot, filename), 'Fixture database must remain inside candidate .role-tests');
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl !== undefined, 'DATABASE_URL must be explicitly supplied');
  assert.ok(databaseUrl.startsWith('file:') && path.isAbsolute(databaseUrl.slice(5)), 'DATABASE_URL must identify the explicit SQLite fixture');
  assert.equal(fs.realpathSync(databaseUrl.slice(5)), filename, 'Both fixture variables must identify the same database');

  const { PrismaClient: FixturePrismaClient } = await import('@prisma/client');
  const probe = new FixturePrismaClient({ datasources: { db: { url: `file:${filename}` } } });
  let client: PrismaClient | undefined;
  let assertions = 0;
  const evidence: string[] = [];
  const equal = (actual: unknown, expected: unknown, label: string) => { assert.deepEqual(actual, expected, label); assertions++; };
  const ok = (value: unknown, label: string) => { assert.ok(value, label); assertions++; };

  try {
    await assertDatabase(probe, filename);
    const empty = await databaseProjection(probe);
    for (const name of ['User', 'PlatformSetting', 'Project', 'VideoCard', 'VideoTask', 'CreditAccount', 'CreditBucket', 'CreditLedger', 'ProjectBudgetAccount', 'ProjectBudgetLedger']) {
      assert.ok(Object.hasOwn(empty, name), `Runner must initialize the real schema including ${name}`);
    }
    assert.ok(Object.values(empty).every(table => table.rows === 0), 'Every business table must be empty before application imports or seed writes');
    const cached = (globalThis as unknown as { prisma?: PrismaClient }).prisma;
    if (cached) await assertDatabase(cached, filename);
    client = (await import('../src/lib/prisma')).prisma;
    await assertDatabase(client, filename);
    equal(await databaseProjection(client), empty, 'The real singleton sees the same empty schema as the pre-import probe');

    const { NextRequest } = await import('next/server');
    const { GET } = await import('../src/app/api/tasks/request-status/route');
    const { CODEX_VIDEO_API_SETTING_KEY } = await import('../src/lib/integrations/codex');
    equal(CODEX_VIDEO_API_SETTING_KEY, 'codex_video_api_v1', 'Seed the actual Codex settings contract');
    const db = client;
    const nonce = randomUUID();
    const id = (label: string) => `prs-${nonce}-${label}`;
    const actorA = id('actor-a'), actorB = id('actor-b');
    const projectA = id('project-a'), projectB = id('project-b');
    const cardA = id('card-a'), cardB = id('card-b');
    const sharedKey = id('shared-request'), foreignKey = id('foreign-only-request');
    const missingKey = id('missing-request'), deniedKey = id('inaccessible-project-request');
    const hiddenKey = id('hidden-request');
    const fixtureToken = randomBytes(32).toString('hex');
    const wrongToken = `${fixtureToken}-invalid`;
    const settingsFor = (userId: string, enabled = true): CodexVideoApiSettings => ({
      enabled, source_label: 'Request-status isolated fixture', user_selector: { type: 'id', value: userId },
      token_hash: `sha256:${createHash('sha256').update(fixtureToken).digest('hex')}`, token_preview: null,
    });
    const tasks = [
      { id: id('task-a'), user_id: actorA, project_id: projectA, video_card_id: cardA, idempotency_key: sharedKey,
        local_status: 'submitted', retention_status: 'active', frozen_cost: 0.25 },
      { id: id('task-b'), user_id: actorB, project_id: projectB, video_card_id: cardB, idempotency_key: sharedKey,
        local_status: 'running', retention_status: 'active', frozen_cost: 0.75 },
      { id: id('foreign-only-task'), user_id: actorB, project_id: projectB, video_card_id: cardB, idempotency_key: foreignKey,
        local_status: 'succeeded', retention_status: 'active', frozen_cost: 0 },
      { id: id('inaccessible-project-task'), user_id: actorA, project_id: projectB, video_card_id: cardB, idempotency_key: deniedKey,
        local_status: 'succeeded', retention_status: 'active', frozen_cost: 0 },
      { id: id('hidden-task'), user_id: actorA, project_id: projectA, video_card_id: cardA, idempotency_key: hiddenKey,
        local_status: 'succeeded', retention_status: 'admin_hidden', frozen_cost: 0 },
    ];

    // Commit synthetic seed rows before GET: the route reads the real global Prisma client.
    await db.$transaction(async tx => {
      for (const [index, userId] of Array.from([actorA, actorB].entries())) {
        await tx.user.create({ data: { id: userId, name: `Request-status fixture ${index}`, username: id(`username-${index}`),
          email: `${id(`email-${index}`)}@fixture.invalid`, password_hash: 'not-a-login-credential', role: 'user', account_type: 'internal', status: 'active' } });
      }
      for (const [projectId, userId, cardId] of [[projectA, actorA, cardA], [projectB, actorB, cardB]]) {
        await tx.project.create({ data: { id: projectId, name: projectId, type: 'personal', visibility: 'private',
          owner_user_id: userId, created_by: userId, status: 'active' } });
        await tx.videoCard.create({ data: { id: cardId, project_id: projectId, title: cardId, owner_user_id: userId, created_by: userId } });
      }
      for (const task of tasks) await tx.videoTask.create({ data: { ...task, owner_user_id: task.user_id,
        provider: 'seedance', model: 'dreamina-seedance-2-0-260128', generation_mode: 'all_in_one_reference',
        prompt: 'Private fixture prompt; never returned by request-status GET.', source_type: 'codex_api',
        duration: 5, resolution: '480p', ratio: '16:9', estimated_cost: task.frozen_cost, visibility: 'project',
        credit_freeze_snapshot: task.frozen_cost > 0 ? JSON.stringify([{ source_type: 'balance', amount: task.frozen_cost }]) : null } });
      for (const [index, userId] of Array.from([actorA, actorB].entries())) {
        const amount = tasks[index].frozen_cost;
        await tx.creditAccount.create({ data: { id: id(`wallet-${index}`), user_id: userId, balance: 123.45,
          frozen_credits: amount, monthly_used: 2.34, total_used: 7.89 } });
        await tx.creditLedger.create({ data: { id: id(`ledger-${index}`), user_id: userId, type: 'task_freeze', amount: -amount,
          balance_before: 123.45, balance_after: 123.45, frozen_before: 0, frozen_after: amount,
          related_task_id: tasks[index].id, idempotency_key: id(`freeze-${index}`), reason: 'Isolated pre-existing request freeze' } });
      }
      await tx.platformSetting.create({ data: { id: id('settings'), key: CODEX_VIDEO_API_SETTING_KEY,
        value_json: JSON.stringify(settingsFor(actorA)), updated_by: actorA } });
    }, { maxWait: 10000, timeout: 30000 });
    const seeded = await databaseProjection(db);
    equal(seeded.User.rows, 2, 'Both fixture actors are real ordinary internal users');
    equal(seeded.VideoTask.rows, tasks.length, 'Only explicit original tasks exist before GET');
    equal(seeded.CreditLedger.rows, 2, 'Existing freezes have real ledger rows for the no-write comparison');
    equal((await db.platformSetting.findMany({ select: { key: true }, orderBy: { key: 'asc' } })).map(row => row.key),
      [CODEX_VIDEO_API_SETTING_KEY, 'catalog_directory_revision_v1:templates', 'catalog_directory_revision_v1:assets'].sort(),
      'Only API settings and the two directory markers exist before GET; no request receipt');

    const setMapping = async (userId: string, enabled = true) => {
      await db.platformSetting.update({ where: { key: CODEX_VIDEO_API_SETTING_KEY }, data: { value_json: JSON.stringify(settingsFor(userId, enabled)) } });
    };
    const query = async (label: string, key: string, token = fixtureToken, extraHeaders: Record<string, string> = {}) => {
      const before = await databaseProjection(db);
      const url = new URL('https://pricing-request-status.fixture.invalid/api/tasks/request-status');
      url.searchParams.set('idempotency_key', key);
      const request = new NextRequest(url, { method: 'GET', headers: { authorization: `Bearer ${token}`, ...extraHeaders } });
      const response = await GET(request);
      const body: unknown = await response.json();
      equal(await databaseProjection(db), before, `${label}: GET changes no business row, including settings, receipts, original tasks, balances, freezes and ledgers`);
      const cacheControl = (response.headers.get('cache-control') || '').toLowerCase().split(',').map(part => part.trim());
      ok(cacheControl.includes('private') && cacheControl.includes('no-store'), `${label}: response is private and no-store`);
      const vary = (response.headers.get('vary') || '').toLowerCase().split(',').map(part => part.trim());
      ok(vary.includes('authorization'), `${label}: Vary includes Authorization`);
      return { status: response.status, body };
    };
    const found = (task: typeof tasks[number]) => ({
      task: { id: task.id, status: task.local_status, project_id: task.project_id, video_card_id: task.video_card_id },
      lookup: 'found', safeToResubmit: false,
    });
    const absent = { task: null, lookup: 'not_found', safeToResubmit: false };
    const denial = (error: string) => ({ error, safeToResubmit: false });

    equal(await query('Mapped actor A without an expected-actor header', sharedKey), { status: 200, body: found(tasks[0]) },
      'A valid old Bearer client reads only its mapped original task and the public task projection');
    equal(await query('Mapped actor A with a matching expected actor', sharedKey, fixtureToken, { 'x-app-session-user': actorA }),
      { status: 200, body: found(tasks[0]) }, 'Matching expected-actor header preserves the real authenticated identity');
    evidence.push('G30/1: real NextRequest GET authenticates the random fixture Bearer through persisted Codex settings; omitted or matching expected-actor headers retain the mapped user and minimal original-task projection.');

    await setMapping(actorB);
    equal(await query('Mapped actor B with the same original key', sharedKey), { status: 200, body: found(tasks[1]) },
      'A different real account with the same request key cannot receive actor A task');
    await setMapping(actorA);
    equal(await query('Only another account owns this key', foreignKey), { status: 200, body: absent },
      'An existing foreign original task is not disclosed or treated as actor A task');
    equal(await query('Expected actor cannot impersonate another account', sharedKey, fixtureToken, { 'x-app-session-user': actorB }),
      { status: 409, body: { error: '\u8d26\u53f7\u5df2\u53d8\u5316\uff0c\u8bf7\u5207\u56de\u539f\u8d26\u53f7\u67e5\u8be2\u539f\u8bf7\u6c42', code: 'pricing_actor_changed', safeToResubmit: false } },
      'Valid Bearer plus the wrong expected actor is rejected without switching lookup identity');
    evidence.push('G30/2: two real mapped accounts sharing one key remain isolated; foreign-only keys are not found, and a conflicting x-app-session-user returns 409 pricing_actor_changed with safeToResubmit:false.');

    equal(await query('No original task or receipt exists', missingKey), { status: 200, body: absent },
      'A missing original request never authorizes resubmission or creates a receipt, task or credit reservation');
    evidence.push('G30/3: a fresh missing key stays not_found with safeToResubmit:false; full persisted-table projections detect any task, receipt or reservation creation.');

    equal(await query('Original task belongs to an inaccessible private project', deniedKey),
      { status: 403, body: denial('\u65e0\u6743\u67e5\u770b\u6b64\u9879\u76ee') }, 'Task ownership never bypasses project visibility');
    equal(await query('Original task is hidden from regular users', hiddenKey),
      { status: 404, body: denial('\u4efb\u52a1\u4e0d\u5b58\u5728\u6216\u5df2\u5220\u9664') }, 'Hidden original tasks disclose neither task data nor receipt authority');
    evidence.push('G30/4: real project permissions reject a mapped-user task in an inaccessible project; real retention permissions reject a hidden task.');

    // No Next cookie request-store is installed. Exact Codex denials must short-circuit it.
    const cookieSentinel = { cookie: 'session=fixture-only-not-a-web-session' };
    equal(await query('Wrong Bearer must not enter Cookie authentication', sharedKey, wrongToken, cookieSentinel),
      { status: 401, body: denial('Codex \u89c6\u9891\u63a5\u53e3 token \u65e0\u6548') }, 'Invalid Bearer retains the specific Codex refusal');
    await db.user.update({ where: { id: actorA }, data: { status: 'disabled' } });
    equal(await query('Disabled mapped user must not enter Cookie authentication', sharedKey, fixtureToken, cookieSentinel),
      { status: 403, body: denial('Codex \u89c6\u9891\u63a5\u53e3\u7ed1\u5b9a\u7528\u6237\u4e0d\u53ef\u7528') }, 'Disabled mapped users are refused by real Codex validation');
    await db.user.update({ where: { id: actorA }, data: { status: 'active', expires_at: new Date(Date.now() - 60000) } });
    equal(await query('Expired mapped user must not enter Cookie authentication', sharedKey, fixtureToken, cookieSentinel),
      { status: 403, body: denial('Codex \u89c6\u9891\u63a5\u53e3\u7ed1\u5b9a\u7528\u6237\u5df2\u8fc7\u671f') }, 'Expired mapped users are refused while their stored task remains unchanged');
    await db.user.update({ where: { id: actorA }, data: { expires_at: null } });
    await setMapping(actorA, false);
    equal(await query('Disabled Codex settings must not enter Cookie authentication', sharedKey, fixtureToken, cookieSentinel),
      { status: 503, body: denial('Codex \u89c6\u9891\u63a5\u53e3\u672a\u5728\u540e\u53f0\u542f\u7528') }, 'Disabled integration returns its specific refusal, not a generic lookup or login result');
    await setMapping(actorA);
    equal(await query('Restored fixture mapping remains readable', sharedKey), { status: 200, body: found(tasks[0]) },
      'The same original task remains readable after fixture-only authentication state changes');
    evidence.push('G30/5: wrong Bearer, disabled or expired mapped user, and disabled integration keep their exact real-auth denial and safeToResubmit:false; no Cookie request-store or browser-login fixture is introduced.');

    const final = await databaseProjection(db);
    for (const name of ['VideoTask', 'CreditAccount', 'CreditBucket', 'CreditLedger', 'ProjectBudgetAccount', 'ProjectBudgetLedger']) {
      equal(final[name], seeded[name], `${name}: all original task and financial values, including cent-level freezes, remain unchanged across GET cases`);
    }
    equal(final.PlatformSetting.rows, 1, 'No GET creates a durable request receipt or an extra setting');
    evidence.push('G30/6: every response is private,no-store and varies on Authorization; each GET compares hashes of every real business-table row before/after, including settings/receipts and pre-existing wallet/ledger freezes.');
    evidence.push('Boundary: direct real GET only, no HTTP listener, identity/Prisma/GET mocks, POST invocation, web-session acceptance, provider request or generation.');
    ok(assertions > 0, 'The awaited fixture completed actual assertions');
    return { fixture: 'pricing-request-status-contract', completed: true, assertions, evidence };
  } finally {
    try { await client?.$disconnect(); }
    finally { await probe.$disconnect(); }
  }
}
