import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import ts from 'typescript';
import { ARCH03_CHECKS, ARCH03_SOURCES, ARCH03_MODULE_ID } from './arch03-fixture-inputs.mjs';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
async function main() {
  const root = realpathSync(process.cwd()), startedAt = new Date().toISOString();
  const capacityRequested = process.env.ARCH03_CAPACITY === '1';
  const writersOnly = process.env.ARCH03_WRITERS_ONLY === '1';
  const runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID || randomUUID();
  const scratch = path.join(root, '.role-tests'); mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'arch03-'));
  const databasePath = path.join(directory, 'synthetic.db');
  const sourceSha256 = Object.fromEntries(ARCH03_SOURCES.map((file: string) => [file, hash(readFileSync(path.join(root, file)))]));
  const require = createRequire(import.meta.url), prismaPackage = require.resolve('prisma/package.json');
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { NODE_ENV: 'test', DATABASE_URL: `file:${databasePath}`, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', NEXT_TELEMETRY_DISABLED: '1' });
  const schemaLog = execFileSync(process.execPath, [path.join(path.dirname(prismaPackage), 'build/index.js'), 'db', 'push', '--skip-generate',
    '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
  writeFileSync(path.join(directory, 'schema.log'), schemaLog, { mode: 0o600 });
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  const { PrismaClient } = await import('@prisma/client');
  const database = new PrismaClient();
  let scanned = 0, maximumPage = 0, forbiddenCalls = 0, completed = false;
  let measureReads = false, measuredRows = 0, largestRead = 0;
  const forbidden = () => { forbiddenCalls++; throw new Error('ARCH03 engineering cannot access network or application services'); };
  mock.method(globalThis, 'fetch', forbidden); mock.method(http, 'request', forbidden); mock.method(http, 'get', forbidden);
  mock.method(https, 'request', forbidden); mock.method(https, 'get', forbidden); mock.method(dns, 'lookup', forbidden);
  const resolver = require('node:module') as { _resolveFilename: (...args: unknown[]) => string };
  const originalResolve = resolver._resolveFilename;
  const marker = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js');
  mock.method(resolver, '_resolveFilename', (...args: unknown[]) => args[0] === 'server-only' ? marker : originalResolve.apply(resolver, args));
  const { catalogDirectoryWrites } = await import('../src/lib/catalog-directory-writes');
  const observed = catalogDirectoryWrites(database).$extends({ query: { async $allOperations({ operation, args, query }) {
    const result = await query(args);
    if (Array.isArray(result)) {
      if (measureReads) { measuredRows += result.length; largestRead = Math.max(largestRead, result.length); }
      if (operation === 'findMany' && (args as { take?: number }).take === 32) { scanned += result.length; maximumPage = Math.max(maximumPage, result.length); }
    }
    return result;
  } } });
  Reflect.set(globalThis, 'prisma', observed); Reflect.set(globalThis, 'prismaSqlitePragmasStarted', true);
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  const previousCwd = process.cwd(); process.chdir(directory);
  const checks: string[] = [];
  const metrics: Record<string, unknown> = {};
  try {
    const { verifyDirectoryWriterTransactions } = await import('./arch03-directory-writers');
    metrics.directoryWriters = await verifyDirectoryWriterTransactions(observed as unknown as typeof database);
    checks.push(ARCH03_CHECKS[9]);
    const { verifyGalleryDirectory } = await import('./arch03-gallery-directory');
    metrics.galleryDirectory = await verifyGalleryDirectory(observed as unknown as typeof database);
    checks.push(ARCH03_CHECKS[11]);
    const { verifyPickerDirectory } = await import('./arch03-picker-directory');
    metrics.pickerDirectory = await verifyPickerDirectory(observed as unknown as typeof database, root);
    checks.push(ARCH03_CHECKS[12]);
    const { verifyLibraryDirectory } = await import('./arch03-library-directory');
    metrics.libraryDirectory = await verifyLibraryDirectory(observed as unknown as typeof database, root);
    checks.push(ARCH03_CHECKS[13]);
    if (writersOnly) { completed = true; return; }
    const { projectStudioTaskSummary } = await import('../src/lib/image-studio/task-summary');
    const detail = { id: 'summary-fixture', prompt: 'PRIVATE_SYNTHETIC_TEXT', referenceIds: ['input'], model: 'fixture',
      billing: { status: 'pending' }, delivery: { phase: 'download' }, feishu: { state: 'pending' }, asset: { id: 'output' },
      snapshot: { prompt: 'PRIVATE_SYNTHETIC_TEXT', globalContext: 'PRIVATE_SYNTHETIC_TEXT', moduleContext: 'PRIVATE_SYNTHETIC_TEXT',
        skills: [{ prompt: 'PRIVATE_SYNTHETIC_TEXT' }], sourceAvailable: true, contextAvailable: true,
        resolution: '2K', moduleContextVersion: 'ABC123', moduleContextVersionState: 'ready',
        primaryReferenceImages: [{ id: 'input', originalUrl: '/synthetic/input', thumbnailUrl: '/synthetic/thumb', note: 'PRIVATE_SYNTHETIC_TEXT' }] } };
    const summary = projectStudioTaskSummary(detail);
    assert.equal('snapshot' in summary, false); assert.equal(JSON.stringify(summary).includes('PRIVATE_SYNTHETIC_TEXT'), false);
    assert.equal(summary.summary.resolution, '2K'); assert.equal(summary.summary.sourceAvailable, true);
    assert.deepEqual(summary.billing, detail.billing); assert.deepEqual(summary.delivery, detail.delivery); assert.deepEqual(summary.feishu, detail.feishu);
    assert.equal(summary.detailState, 'unloaded'); assert.equal(detail.snapshot.prompt, 'PRIVATE_SYNTHETIC_TEXT');
    checks.push(ARCH03_CHECKS[0]);

    const now = new Date('2026-10-20T10:00:00Z');
    await database.user.create({ data: { id: 'fixture-owner', name: 'Fixture Owner', username: 'fixture-owner',
      email: 'fixture@example.invalid', password_hash: 'not-a-real-password', role: 'admin' } });
    const { validStudioModuleId } = await import('../src/lib/image-studio/modules');
    assert.ok(validStudioModuleId(ARCH03_MODULE_ID, 'fixture-owner'));
    const task = (id: string, offset: number, blocked = false) => ({ id, batch_id: id, owner_id: 'fixture-owner', module_id: ARCH03_MODULE_ID,
      ordinal: 1, fingerprint: hash(id), prompt: 'synthetic', context: '', revision: 1, model: 'fixture', reference_ids: '[]', unit_credits: 5,
      status: 'queued', snapshot_json: blocked ? '{"sharedLive":{}}' : '{}', created_at: new Date(now.getTime() + offset) });
    for (let index = 0; index < 70; index++) await database.imageStudioTask.create({ data: task(`blocked-${index}`, index, true) });
    await database.imageStudioTask.create({ data: task('eligible-tail', 100) });
    const { claimStudioTask } = await import('../src/lib/image-studio/tasks');
    assert.equal(await claimStudioTask(), null); assert.equal(scanned, 32);
    const checkpoint = await database.platformSetting.findUnique({ where: { key: 'studio_task_claim_scan_v1' } });
    assert.ok(checkpoint); assert.equal(JSON.parse(checkpoint.value_json).cursor.id, 'blocked-31');
    await database.imageStudioTask.delete({ where: { id: 'blocked-31' } });
    await database.imageStudioTask.update({ where: { id: 'blocked-0' }, data: { snapshot_json: '{}' } });
    assert.equal(await claimStudioTask(), null); assert.ok(scanned <= 64);
    await database.imageStudioTask.create({ data: task('continuous-tail', 200) });
    const claimed = await claimStudioTask(); assert.equal(claimed?.id, 'eligible-tail'); assert.ok(claimed?.lease_token);
    let prefixReached = false;
    for (let round = 0; round < 8; round++) {
      const before = scanned;
      const value = await claimStudioTask(); assert.ok(scanned - before <= 32);
      if (value?.id === 'blocked-0') { prefixReached = true; break; }
      await database.imageStudioTask.create({ data: task(`arriving-${round}`, 300 + round) });
    }
    assert.ok(prefixReached, 'A fixed ceiling must revisit an unlocked prefix despite arriving tail tasks');
    assert.equal(await database.creditLedger.count(), 0); assert.equal(maximumPage, 32);
    assert.equal(await database.imageStudioTask.count({ where: { id: 'eligible-tail', status: 'running' } }), 1);
    metrics.claim = { maximumPage, scanned, durableCheckpoint: true, deletedCursorSurvived: true, prefixReached };
    checks.push(ARCH03_CHECKS[1]);

    const { activeStudioTaskPage } = await import('../src/lib/image-studio/active-tasks');
    const seen = new Set<string>(); let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await activeStudioTaskPage('fixture-owner', ARCH03_MODULE_ID, cursor);
      assert.ok(result.ids.length <= 24); result.ids.forEach(id => { assert.ok(!seen.has(id)); seen.add(id); });
      cursor = result.nextCursor || undefined; if (!cursor) break;
    }
    assert.ok(seen.has('continuous-tail'));
    await database.imageStudioTask.update({ where: { id: 'eligible-tail' }, data: { status: 'succeeded', billing_next_check_at: now } });
    assert.ok((await activeStudioTaskPage('fixture-owner', ARCH03_MODULE_ID)).ids.length <= 24);
    let lateFound = false; cursor = undefined;
    for (let page = 0; page < 10; page++) { const result = await activeStudioTaskPage('fixture-owner', ARCH03_MODULE_ID, cursor);
      lateFound ||= result.ids.includes('eligible-tail'); cursor = result.nextCursor || undefined; if (!cursor) break; }
    assert.ok(lateFound); assert.deepEqual((await activeStudioTaskPage('another-owner', ARCH03_MODULE_ID)).ids, []);
    await database.imageStudioTask.updateMany({ data: { status: 'succeeded', snapshot_json: '{}', billing_next_check_at: null } });
    await database.imageStudioTask.create({ data: task('concurrent-claim', 500) });
    let concurrent: Awaited<ReturnType<typeof claimStudioTask>>[] = [];
    for (let round = 0; round < 3 && !concurrent.length; round++) concurrent = (await Promise.all([claimStudioTask(), claimStudioTask()])).filter(Boolean);
    assert.equal(concurrent.length, 1); assert.equal(concurrent[0]?.id, 'concurrent-claim');
    const { studioClaimScanPage } = await import('../src/lib/image-studio/claim-scan');
    await database.platformSetting.deleteMany({ where: { key: 'studio_task_claim_scan_v1' } });
    for (let index = 0; index < 33; index++) await database.imageStudioTask.create({ data: task(`cas-blocked-${index}`, 600 + index, true) });
    const eligible = { status: 'queued' };
    const left = await studioClaimScanPage(database, eligible), right = await studioClaimScanPage(database, eligible);
    await left.advance(left.rows.at(-1));
    const acceptedCheckpoint = (await database.platformSetting.findUniqueOrThrow({ where: { key: 'studio_task_claim_scan_v1' } })).value_json;
    await right.advance(right.rows[0]);
    assert.equal((await database.platformSetting.findUniqueOrThrow({ where: { key: 'studio_task_claim_scan_v1' } })).value_json, acceptedCheckpoint);
    await database.platformSetting.deleteMany({ where: { key: 'studio_task_claim_scan_v1' } });
    metrics.claim = { ...metrics.claim as object, concurrentClaimReturnedOnce: true, staleCheckpointWriteRejected: true };
    checks.push(ARCH03_CHECKS[2]);

    await database.project.createMany({ data: Array.from({ length: 45 }, (_, index) => ({ id: `project-${String(index).padStart(3, '0')}`,
      name: index === 2 ? 'Smoke Project' : `Project ${index}`, description: index === 3 ? 'closure smoke' : '',
      type: 'team', owner_user_id: 'fixture-owner', created_by: 'fixture-owner', status: index < 40 ? 'active' : 'archived', updated_at: new Date(now.getTime() + index) })) });
    const { readAdminProjectPage } = await import('../src/lib/projects/admin-directory');
    const first = await readAdminProjectPage(database, new URLSearchParams('filter=all&search=Fixture Owner&page=1'), true);
    const second = await readAdminProjectPage(database, new URLSearchParams('filter=all&search=Fixture Owner&page=2'), true);
    assert.equal(first.projects.length, 20); assert.equal(second.projects.length, 20); assert.equal(first.pagination.total, 45);
    assert.equal(new Set([...first.projects, ...second.projects].map(project => project.id)).size, 40);
    const adminFile = ts.createSourceFile('AdminProjectsClient.tsx', readFileSync(path.join(root, 'src/app/admin/projects/AdminProjectsClient.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const selectionDeclarations: string[] = [];
    const collectSelection = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && ['toggleProject', 'toggleCurrentPage'].includes(node.name.text)) selectionDeclarations.push(`const ${node.getText(adminFile)};`); ts.forEachChild(node, collectSelection); }; collectSelection(adminFile);
    assert.equal(selectionDeclarations.length, 2);
    const selectionCode = ts.transpileModule(`${selectionDeclarations.join('\n')} exports.toggleProject = toggleProject; exports.toggleCurrentPage = toggleCurrentPage;`,
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    let selectedIds = new Set<string>(); const selectedRecords = { current: new Map<string, unknown>() };
    const bindSelectionPage = (projects: typeof first.projects) => {
      const exports = {} as { toggleProject: (id: string) => void; toggleCurrentPage: () => void };
      new Function('projects', 'pagedProjects', 'selectedRecords', 'setSelectedIds', 'setMergePreview', 'setMergeConfirmed', 'exports', selectionCode)(projects, projects,
        selectedRecords, (update: (current: Set<string>) => Set<string>) => { selectedIds = update(selectedIds); }, () => {}, () => {}, exports);
      return exports;
    };
    bindSelectionPage(first.projects).toggleProject(first.projects[0].id);
    bindSelectionPage(second.projects).toggleCurrentPage();
    assert.equal(selectedIds.size, 21); assert.ok(selectedIds.has(first.projects[0].id)); assert.ok(selectedRecords.current.has(first.projects[0].id));
    bindSelectionPage(second.projects).toggleCurrentPage(); assert.deepEqual(Array.from(selectedIds), [first.projects[0].id]);
    assert.equal((await readAdminProjectPage(database, new URLSearchParams('filter=smoke'), true)).pagination.total, 2);
    assert.equal((await readAdminProjectPage(database, new URLSearchParams('filter=archived&search=Fixture Owner'), true)).pagination.total, 5);
    assert.equal((await readAdminProjectPage(database, new URLSearchParams('filter=empty'), false)).pagination.total, 0);
    const { getProjectDeletionBlockers } = await import('../src/lib/projects/permissions');
    assert.deepEqual(await getProjectDeletionBlockers(database, 'project-000'), []);
    assert.equal((await readAdminProjectPage(database, new URLSearchParams('filter=empty'), true)).pagination.total, 45);
    await database.operationLog.create({ data: { operator_id: 'fixture-owner', action: 'fixture_unknown_history', target_type: 'project', target_id: 'project-000', detail: '{}' } });
    assert.ok((await getProjectDeletionBlockers(database, 'project-000')).length);
    assert.equal((await readAdminProjectPage(database, new URLSearchParams('filter=empty'), true)).pagination.total, 44);
    await database.operationLog.deleteMany({ where: { action: 'fixture_unknown_history' } });
    const focused = await readAdminProjectPage(database, new URLSearchParams('filter=archived&focus=project-000&locate=1'), true);
    assert.ok(focused.projects.some(project => project.id === 'project-000'));
    assert.equal((await readAdminProjectPage(database, new URLSearchParams('filter=all&search=Fixture Owner'), true)).pagination.total, 45);
    assert.equal((await readAdminProjectPage(database, new URLSearchParams('filter=all&focus=project-000&page=2'), true)).focusedAvailable, true);
    checks.push(ARCH03_CHECKS[3]);

    await database.imageStudioTask.updateMany({ data: { status: 'succeeded', snapshot_json: '{}', billing_next_check_at: null } });
    await database.imageStudioTask.create({ data: { ...task('old-late-cash', -50), status: 'succeeded', created_at: new Date('2026-08-02T00:00:00Z'), finished_at: now } });
    await database.imageStudioTask.create({ data: { ...task('frozen-time', -40), status: 'succeeded', created_at: new Date('2026-08-03T00:00:00Z') } });
    await database.usageAttribution.create({ data: { source_kind: 'image_task', source_id: 'frozen-time', owner_user_id: 'fixture-owner',
      occurred_at: now, context_origin: 'synthetic', context_version: 1 } });
    for (const id of ['eligible-tail', 'old-late-cash', 'frozen-time']) await database.costLedger.create({ data: {
      source_type: 'image_task', source_id: id, image_task_id: id, provider_name: 'synthetic', provider_account_id: 'fixture-scope',
      provider_task_id: `acceptance-${id}`, event_type: 'official_charge', amount_micros: 1000000, currency: 'USD', cost_source: 'official_bill',
      confidence: 'confirmed', official_charge_id: `proof-${id}`, occurred_at: new Date('2026-11-01T00:00:00Z') } });
    const { readUsageFacts } = await import('../src/lib/usage/facts');
    const { usageFactMatches } = await import('../src/lib/admin/usage-analytics');
    const { parseUsageQuery } = await import('../src/lib/admin/usage-query');
    const asOf = '2026-12-01T00:00:00Z';
    const query = parseUsageQuery(new URLSearchParams('range=month&year=2026&month=10&time_zone=America/Los_Angeles'), new Date(asOf));
    const reference = await readUsageFacts(database, asOf);
    const bounded = await readUsageFacts(database, asOf, undefined, { startUtc: query.startUtc, endUtc: query.endUtc });
    assert.deepEqual(bounded.facts.filter(fact => usageFactMatches(fact, query, asOf)), reference.facts.filter(fact => usageFactMatches(fact, query, asOf)));
    assert.ok(bounded.facts.some(fact => fact.sourceId === 'frozen-time')); assert.ok(!bounded.facts.some(fact => fact.sourceId === 'old-late-cash'));
    assert.ok(bounded.cashEvents.some(event => event.sourceKey === 'image_task:eligible-tail'));
    assert.equal(await database.creditLedger.count(), 0);
    checks.push(ARCH03_CHECKS[4]);

    const { likedStudioTaskPage } = await import('../src/lib/image-studio/liked-task-page');
    for (let index = 0; index < 30; index++) {
      const assetId = `liked-output-${index}`, taskId = `liked-task-${index}`;
      await database.asset.create({ data: { id: assetId, owner_id: 'fixture-owner', type: 'image', file_name: `${assetId}.png`, mime_type: 'image/png', file_size: 0, original_url: `/uploads/${assetId}.png` } });
      await database.imageStudioTask.create({ data: { ...task(taskId, 1000 + index), status: 'succeeded', asset_id: assetId } });
      await database.contentReaction.create({ data: { user_id: 'fixture-owner', content_key: `asset:${assetId}`, category: 'generated', liked: index !== 1, favorited: index === 1 } });
    }
    const liked = await likedStudioTaskPage(database, 'fixture-owner', ARCH03_MODULE_ID, undefined, 25, [], true);
    assert.equal(liked.total, 30); assert.equal(liked.rows.length, 25);
    const likedNext = await likedStudioTaskPage(database, 'fixture-owner', ARCH03_MODULE_ID, liked.rows.at(-1)!.id, 25, [], true);
    assert.equal(likedNext.rows.length, 5); assert.equal(new Set([...liked.rows, ...likedNext.rows].map(row => row.id)).size, 30);
    assert.equal((await likedStudioTaskPage(database, 'another-owner', ARCH03_MODULE_ID, undefined, 25)).total, 0);
    checks.push(ARCH03_CHECKS[7]);

    await database.imageStudioTask.createMany({ data: Array.from({ length: 1100 }, (_, index) => ({ ...task(`streamed-${index}`, 2000 + index), status: 'succeeded' })) });
    const { readUsageAnalyticsSnapshot, getUsageAnalyticsReferenceSnapshot, summarizeUsageFacts } = await import('../src/lib/admin/usage-analytics');
    const { UsageSummaryFold } = await import('../src/lib/usage/summary-fold');
    const { streamUsageCsv } = await import('../src/lib/admin/usage-csv');
    const { usageRowSpool } = await import('../src/lib/usage/row-spool');
    const allQuery = parseUsageQuery(new URLSearchParams('range=all&sort=oldest&page=3&page_size=20'), new Date(asOf));
    const originalReport = await getUsageAnalyticsReferenceSnapshot(allQuery);
    const streamed = await readUsageAnalyticsSnapshot(database, allQuery, originalReport.report.dataAsOf);
    const reportValues = (value: typeof streamed.report) => ({ ...value, dataAsOf: '', reportFingerprint: '',
      coverage: value.coverage.map(({ detail: _detail, ...item }) => item) });
    assert.deepEqual(reportValues(streamed.report), reportValues(originalReport.report));
    assert.ok(Array.isArray(originalReport.records)); assert.ok(!Array.isArray(streamed.records));
    const materialized = [];
    for await (const fact of streamed.records.values()) materialized.push(fact);
    assert.deepEqual(materialized, originalReport.records);
    assert.ok(streamed.records.metrics.maxBatchRows <= 500); assert.ok(streamed.records.metrics.peakMergeReaders <= 16);
    const folded = new UsageSummaryFold(); for (const fact of originalReport.records) folded.add(fact);
    assert.deepEqual(folded.value(), summarizeUsageFacts(originalReport.records));
    const text = await new Response(streamUsageCsv(streamed, 'records')).text();
    assert.equal((text.match(/^"record",/gm) || []).length, originalReport.records.length);
    await assert.rejects(streamed.records.values().next(), /usage_spool_closed/);
    const cancellation = await usageRowSpool<(typeof materialized)[number]>((a, b) => a.sourceId.localeCompare(b.sourceId));
    await cancellation.add(materialized.slice(0, 2)); const cancelledRows = await cancellation.finish();
    const cancelledStream = streamUsageCsv({ ...streamed, records: cancelledRows, cashEvents: [], dispose: cancelledRows.dispose }, 'records');
    await cancelledStream.cancel(); await assert.rejects(cancelledRows.values().next(), /usage_spool_closed/);
    metrics.usage = { rows: originalReport.records.length, maxBatchRows: streamed.records.metrics.maxBatchRows,
      peakMergeReaders: streamed.records.metrics.peakMergeReaders, reportEqualsReference: true, exportEqualsReference: true, cancellationCleaned: true };
    checks.push(ARCH03_CHECKS[8]);

    const { createSelfUsageScope } = await import('../src/lib/usage/access');
    const { parseUsageQuery: parsePublicQuery } = await import('../src/lib/usage/query');
    const { getUsagePublicReferenceSnapshot, readUsagePublicSnapshot } = await import('../src/lib/usage/personal');
    const publicUser = await database.user.findUniqueOrThrow({ where: { id: 'fixture-owner' } });
    const publicScope = createSelfUsageScope({ ...publicUser, role: 'admin', account_type: 'internal', status: 'active' });
    const publicQuery = parsePublicQuery(new URLSearchParams('month=2026-10&type=image&page=3&limit=20'), publicScope);
    const originalPublic = await getUsagePublicReferenceSnapshot(publicScope, publicQuery);
    const boundedPublic = await readUsagePublicSnapshot(database, publicScope, publicQuery, originalPublic.report.asOf);
    const comparablePublic = (value: typeof boundedPublic.report) => ({ ...value, fingerprint: '' });
    assert.deepEqual(comparablePublic(boundedPublic.report), comparablePublic(originalPublic.report));
    assert.ok(!Array.isArray(boundedPublic.records)); assert.ok(boundedPublic.records.metrics.maxBatchRows <= 500);
    const publicRecords = []; for await (const record of boundedPublic.records.values()) publicRecords.push(record);
    assert.deepEqual(publicRecords, originalPublic.records);
    await boundedPublic.dispose?.(); await assert.rejects(boundedPublic.records.values().next(), /usage_spool_closed/);
    metrics.publicUsage = { rows: publicRecords.length, reportEqualsReference: true, recordsEqualReference: true, maxBatchRows: boundedPublic.records.metrics.maxBatchRows };
    const { createProjectUsageScope } = await import('../src/lib/usage/access');
    await database.imageStudioTask.createMany({ data: ['public-project-owned', 'public-project-other'].map((id, index) => ({ ...task(id, 4000 + index),
      owner_id: index ? 'picker-directory-owner' : 'fixture-owner', status: 'succeeded', created_at: new Date('2026-08-01T00:00:00Z') })) });
    await database.usageAttribution.createMany({ data: ['public-project-owned', 'public-project-other'].map((id, index) => ({ source_kind: 'image_task', source_id: id,
      owner_user_id: index ? 'picker-directory-owner' : 'fixture-owner', project_id: 'project-000', occurred_at: now, context_origin: 'synthetic', context_version: 1 })) });
    const projectScope = await createProjectUsageScope({ ...publicUser, role: 'admin', account_type: 'internal', status: 'active' }, 'project-000');
    const projectQuery = parsePublicQuery(new URLSearchParams('month=2026-10&type=image'), projectScope);
    const originalProject = await getUsagePublicReferenceSnapshot(projectScope, projectQuery);
    const boundedProject = await readUsagePublicSnapshot(database, projectScope, projectQuery, originalProject.report.asOf);
    assert.deepEqual(comparablePublic(boundedProject.report), comparablePublic(originalProject.report));
    assert.equal(boundedProject.report.records.total, 2); assert.equal(boundedProject.report.records.items.find(record => record.id.endsWith('public-project-other'))?.media, undefined);
    await boundedProject.dispose?.(); metrics.publicUsage = { ...metrics.publicUsage as object, projectEqualsReference: true, frozenProjectCohort: true, foreignMediaNotGranted: true };
    checks.push(ARCH03_CHECKS[10]);

    const file = ts.createSourceFile('studio.tsx', readFileSync(path.join(root, 'src/app/image-studio/studio.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let restore: ts.FunctionDeclaration | undefined;
    const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === 'restoreResultSettings') restore = node; ts.forEachChild(node, visit); }; visit(file);
    assert.ok(restore);
    const compiled = ts.transpileModule(`${restore!.getText(file)}; exports.run = restoreResultSettings;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    let resolveDetail: (value: unknown) => void = () => {}, restored = 0;
    const context = { taskReadScope: 'owner:module', currentView: { current: { token: 1, active: true } }, liveGenerationSignature: { current: 'initial' },
      currentInputRevision: { current: 1 }, detailReadSequence: { current: 0 }, taskReadScopeRef: { current: 'owner:module' },
      isClientSessionBlocked: () => false, readTaskDetail: () => new Promise(resolve => { resolveDetail = resolve; }),
      restoreTask: () => { restored++; return null; }, setError: () => {} };
    const factory = new Function(...Object.keys(context), 'exports', compiled);
    const exports: { run?: (task: unknown) => Promise<void> } = {}; factory(...Object.values(context), exports);
    const pending = exports.run!({ id: 'task' }); context.currentInputRevision.current++; resolveDetail({ snapshot: {} }); await pending;
    assert.equal(restored, 0);
    const next = exports.run!({ id: 'task' }); context.taskReadScopeRef.current = 'another:module'; resolveDetail({ snapshot: {} }); await next;
    assert.equal(restored, 0);
    checks.push(ARCH03_CHECKS[5]);

    const { verifyPagedGroupDeletion } = await import('./arch03-group-consumer');
    metrics.groupDeletion = await verifyPagedGroupDeletion(file.getFullText());
    checks.push(ARCH03_CHECKS[14]);

    const { hdDirectory } = await import('../src/lib/media/hd-storage-root');
    const { synchronizeHdScheduler } = await import('../src/lib/media/hd-scheduler');
    const schedulerFile = path.join(hdDirectory(), 'scheduler-v1.json');
    assert.ok(schedulerFile.startsWith(directory + path.sep));
    await fs.mkdir(hdDirectory(), { recursive: true, mode: 0o700 });
    const bucket = `user:${hash('fixture-owner')}`;
    const jobs = Array.from({ length: 100 }, (_, index) => ({ key: hash(`hd-${index}`), version: 'fixture-version',
      encoderStrategy: 'hd-legacy-e6-v1', status: 'queued', attempts: 0 }));
    const state = { protocol: 'hd-user-round-robin-v1', revision: 0, globalTurn: 0, consecutiveViewer: 0, consecutiveForeground: 0,
      buckets: { [bucket]: { lastServedTurn: 0 } }, entries: Object.fromEntries(jobs.map(job => [job.key, { key: job.key,
        sourceVersion: job.version, strategy: job.encoderStrategy, homeBucket: bucket, ownerEvidence: { kind: 'asset', id: job.key,
          ownerId: 'fixture-owner', checkedAt: now.toISOString() }, firstQueuedAt: now.toISOString(), role: 'new', interests: [] }])) };
    await fs.writeFile(schedulerFile, JSON.stringify(state), { mode: 0o600 });
    let schedulerReads = 0;
    const originalRead = fs.readFile;
    const readMock = mock.method(fs, 'readFile', (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === schedulerFile) schedulerReads++;
      return originalRead(...args);
    });
    try { await synchronizeHdScheduler(jobs as unknown as Parameters<typeof synchronizeHdScheduler>[0]); }
    finally { readMock.mock.restore(); }
    assert.equal(schedulerReads, 2); metrics.hd = { jobs: jobs.length, schedulerReads, historicalFileScanEliminated: false };
    checks.push(ARCH03_CHECKS[6]);
    if (capacityRequested) {
      const { runArch03Capacity } = await import('./arch03-capacity');
      metrics.capacity = await runArch03Capacity(observed as unknown as typeof database,
        () => { measuredRows = 0; largestRead = 0; measureReads = true; },
        () => { measureReads = false; return { rows: measuredRows, largestRead }; });
    }
    assert.deepEqual([...checks].sort(), [...ARCH03_CHECKS].sort()); assert.equal(forbiddenCalls, 0); completed = true;
  } finally {
    await database.$disconnect();
    await (Reflect.get(globalThis, 'hdReadonlyDb') as { $disconnect?: () => Promise<void> } | undefined)?.$disconnect?.();
    process.chdir(previousCwd); mock.restoreAll();
    const receipt = path.join(directory, 'receipt.json');
    writeFileSync(receipt, JSON.stringify({ schema: 'arch03-engineering.v1', runId, startedAt, finishedAt: new Date().toISOString(),
      fixtureSha256: sourceSha256['scripts/arch03-engineering.ts'], sourceSha256, checks: [...checks].sort((a, b) => ARCH03_CHECKS.indexOf(a) - ARCH03_CHECKS.indexOf(b)), metrics, completed, forbiddenCalls,
      synthetic: true, productionWrites: 0, paidRequests: 0, browserRuns: 0 }, null, 2), { mode: 0o600 });
    console.log(`ARCH03 engineering receipt: ${receipt}`);
  }
}
process.exitCode = 1;
void main().then(() => { process.exitCode = 0; }, error => { console.error(error); process.exitCode = 1; });
