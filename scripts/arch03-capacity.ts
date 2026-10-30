import assert from 'node:assert/strict';
import { Prisma, type PrismaClient } from '@prisma/client';
import { ARCH03_MODULE_ID } from './arch03-fixture-inputs.mjs';

type ReadMetrics = { rows: number; largestRead: number };
export async function runArch03Capacity(db: PrismaClient, begin: () => void, end: () => ReadMetrics,
  progress: (measurements: Array<Record<string, unknown>>) => void = () => {}) {
  const { listStudioTasks, claimStudioTask } = await import('../src/lib/image-studio/tasks');
  const { activeStudioTaskPage } = await import('../src/lib/image-studio/active-tasks');
  const { readAdminProjectPage } = await import('../src/lib/projects/admin-directory');
  const { readUsageFacts } = await import('../src/lib/usage/facts');
  const { projectStudioTaskSummary } = await import('../src/lib/image-studio/task-summary');
  const measurements: Array<Record<string, unknown>> = [];
  const baselineProjects = (await readAdminProjectPage(db, new URLSearchParams('filter=all'), true)).pagination.total;
  const clone = async (table: 'ImageStudioTask' | 'Project' | 'Asset' | 'ImageStudioPreset', sourceId: string, start: number, finish: number) => {
    const columns = await db.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("${table}")`);
    assert.ok(columns.length && columns.every(column => /^[a-zA-Z0-9_]+$/.test(column.name)));
    const quoted = (name: string) => Prisma.raw(`"${name}"`);
    const identity = Prisma.sql`${({ Project: 'scale-project-', ImageStudioTask: 'scale-task-', Asset: 'scale-asset-', ImageStudioPreset: 'scale-preset-' })[table]} || printf('%08d', n)`;
    const values = columns.map(({ name }) => name === 'id' || table === 'ImageStudioTask' && ['batch_id', 'fingerprint'].includes(name)
      ? identity : table === 'ImageStudioTask' && name === 'created_at' ? Prisma.sql`${Date.parse('2020-01-01T00:00:00Z')} + n`
      : ['Project', 'ImageStudioPreset'].includes(table) && name === 'name' ? identity
      : table === 'Asset' && name === 'original_url' ? Prisma.sql`'/uploads/scale-' || n || '.png'`
      : table === 'Asset' && name === 'file_name' ? identity : Prisma.sql`s.${quoted(name)}`);
    await db.$executeRaw(Prisma.sql`WITH RECURSIVE sequence(n) AS (SELECT ${start} UNION ALL SELECT n + 1 FROM sequence WHERE n < ${finish})
      INSERT INTO ${quoted(table)} (${Prisma.join(columns.map(column => quoted(column.name)))})
      SELECT ${Prisma.join(values)} FROM sequence CROSS JOIN ${quoted(table)} s WHERE s."id" = ${sourceId}`);
  };
  const measure = async (history: number, operation: string, read: () => Promise<unknown>) => {
    begin(); const start = performance.now(); const result = await read();
    const metrics = end(), bytes = Buffer.byteLength(JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value));
    measurements.push({ history, operation, elapsedMs: Math.round((performance.now() - start) * 10) / 10, bytes, ...metrics });
    progress(measurements);
    return result;
  };
  const pendingId = 'scale-live-original';
  const seed = await db.imageStudioTask.findUniqueOrThrow({ where: { id: 'eligible-tail' } });
  await db.imageStudioTask.create({ data: { ...seed, id: pendingId, batch_id: pendingId, fingerprint: pendingId,
    status: 'queued', snapshot_json: '{}', billing_next_check_at: null, lease_token: null, lease_until: null, created_at: new Date(), updated_at: new Date() } });
  const baselineFacts = (await readUsageFacts(db, '2026-12-01T00:00:00Z', undefined,
    { startUtc: '2026-10-01T00:00:00Z', endUtc: '2026-11-01T00:00:00Z' })).facts.length;
  const { readGalleryPage } = await import('../src/lib/image-studio/gallery-page');
  const { readPickerDirectory } = await import('../src/lib/assets/picker-directory');
  const { readLibraryDirectory } = await import('../src/lib/assets/library-directory');
  const { readUsageAnalyticsSnapshot } = await import('../src/lib/admin/usage-analytics');
  const { parseUsageQuery } = await import('../src/lib/admin/usage-query');
  const viewer = { ...await db.user.findUniqueOrThrow({ where: { id: 'picker-directory-owner' } }),
    role: 'user' as const, account_type: 'internal' as const, status: 'active' as const };
  const actor = { id: 'catalog-writer-fixture', role: 'admin', account_type: 'internal' };
  const reportQuery = parseUsageQuery(new URLSearchParams('range=all&sort=oldest&page_size=20'), new Date('2026-12-01T00:00:00Z'));
  const originalReport = await readUsageAnalyticsSnapshot(db, reportQuery, '2026-12-01T00:00:00Z');
  const originalTotal = originalReport.report.records.total; await originalReport.dispose?.();
  let previous = 0;
  for (const history of [10_000, 100_000]) {
    await clone('ImageStudioTask', 'eligible-tail', previous + 1, history);
    await clone('Project', 'project-000', previous / 10 + 1, history / 10);
    await clone('Asset', 'picker-asset-1', previous + 1, history);
    await clone('ImageStudioPreset', 'gallery-preset-5', previous + 1, history);
    await db.imageStudioTask.update({ where: { id: pendingId }, data: { status: 'queued', lease_token: null, lease_until: null } });
    const list = await measure(history, 'owner_summary_page', async () => {
      const page = await listStudioTasks('fixture-owner', undefined, ARCH03_MODULE_ID);
      assert.ok(page.tasks.length <= 24); return { ...page, tasks: page.tasks.map(projectStudioTaskSummary) };
    });
    assert.ok(!(JSON.stringify(list).includes('"snapshot"')));
    await measure(history, 'active_page', async () => { const page = await activeStudioTaskPage('fixture-owner', ARCH03_MODULE_ID);
      assert.deepEqual(page.ids, [pendingId]); return page; });
    await measure(history, 'admin_project_page', async () => { const page = await readAdminProjectPage(db, new URLSearchParams('filter=all'), true);
      assert.equal(page.projects.length, 20); assert.equal(page.pagination.total, baselineProjects + history / 10); return page; });
    await measure(history, 'usage_month_cohort', async () => {
      const snapshot = await readUsageFacts(db, '2026-12-01T00:00:00Z', undefined,
        { startUtc: '2026-10-01T00:00:00Z', endUtc: '2026-11-01T00:00:00Z' });
      assert.equal(snapshot.facts.length, baselineFacts); assert.ok(snapshot.facts.every(fact => !fact.sourceId.startsWith('scale-task-')));
      return { facts: snapshot.facts.length, cashEvents: snapshot.cashEvents.length };
    });
    await measure(history, 'claim_round', async () => { const task = await claimStudioTask(); assert.equal(task?.id, pendingId); return task?.id; });
    for (const sort of ['created', 'name'] as const) {
      await measure(history, `gallery_${sort}`, async () => {
        const page = await readGalleryPage(db, actor, { sort, page: 2, pageSize: 24 });
        assert.equal(page.items.length, 24); assert.ok(page.total >= history); return page;
      });
      await measure(history, `picker_${sort}`, async () => {
        const page = await readPickerDirectory(db, viewer, new URLSearchParams({ scope: 'mine', types: 'image', target: 'image-studio', sort }), null);
        assert.equal(page.keys.length, 24); assert.ok(page.total >= history); return page;
      });
    }
    await measure(history, 'library_created', async () => {
      const page = await readLibraryDirectory(db, viewer, { type: 'all', scope: 'history', status: 'all', sort: 'newest', page: 2, limit: 24,
        includeUploads: true, includeGenerated: true, collapseMultiview: true, multiviewOutputsOnly: false, projectId: null, ownerUserId: null, keyword: null, enhance: 'none' });
      assert.equal(page.keys.length, 24); assert.ok(page.total >= history); return page;
    });
    await measure(history, 'usage_all_history', async () => {
      const report = await readUsageAnalyticsSnapshot(db, reportQuery, '2026-12-01T00:00:00Z');
      try {
        assert.equal(report.report.records.total, originalTotal + history);
        assert.ok(!Array.isArray(report.records));
        assert.ok(report.records.metrics.maxBatchRows <= 500); assert.ok(report.records.metrics.peakMergeReaders <= 16);
        let count = 0; for await (const _row of report.records.values()) count++;
        assert.equal(count, originalTotal + history);
        return { count, ...report.records.metrics };
      } finally { await report.dispose?.(); }
    });
    previous = history;
  }
  for (const second of measurements.filter(value => value.history === 100_000)) {
    const first = measurements.find(value => value.history === 10_000 && value.operation === second.operation)!;
    if (!['gallery_name', 'picker_name', 'usage_all_history'].includes(String(second.operation))) {
      const directoryGrowth = second.operation === 'usage_month_cohort' ? (100_000 - 10_000) / 10 : 0;
      assert.ok(Number(second.rows) <= Number(first.rows) + directoryGrowth + 2, `${second.operation}: historical rows leaked into application loading`);
    }
    assert.ok(Number(second.largestRead) <= Math.max(Number(first.largestRead), 500), `${second.operation}: unbounded application read`);
  }
  assert.equal(await db.creditLedger.count(), 0);
  return { syntheticOnly: true, metadataHistory: [10_000, 100_000], projectHistory: [1_000, 10_000], measurements,
    proves: 'bounded returned metadata on the named operations, not bounded SQLite scan cost',
    growthBoundary: 'Name sorting and all-history reporting process all matching rows in bounded batches; total work and temporary disk grow with history. Reporting retains member/project name dimensions, which grow with directory cardinality; the monthly cohort must still exclude all out-of-month history.',
    unproved: ['media capacity', '10x concurrency', 'supplier capacity', 'backups', 'legacy compatibility full-read paths'] };
}
