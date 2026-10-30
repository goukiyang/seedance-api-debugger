import 'server-only';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { iterateUsageFactBatches, readUsageFacts, type UsageFactSnapshot } from './facts';
import type { UsageFact } from '@/lib/admin/usage-types';
import { usageExchangeRate, usageInteger } from '@/lib/admin/usage-money';
import { usageLocalDate } from '@/lib/admin/usage-query';
import type { PublicUsageScope, UsageCoverageDTO, UsageExportSnapshot, UsagePublicQuery, UsageRecordDTO, UsageReportDTO } from './dto';
import { parseUsageQuery, shiftUsageMonth, usageMonthRange } from './query';
import { resolveUsageReadOptions } from './source-scope';
import { readUsageProjectDirectory } from './project-directory';
import { usageScopeUser } from './access';
import { publicUsageCash, publicUsagePoints, publicUsageProject, publicUsageSummaries, usagePublicType, usageSourceKey } from './aggregate';
import { readUsageMedia, type UsageMediaProjection } from './media';
import { PublicUsageSummaryFold } from './public-summary-fold';
import { usageRowSpool } from './row-spool';
import { observeOperation } from '@/lib/performance/server-operations';

function canonicalQuery(scope: PublicUsageScope, query: UsagePublicQuery) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== null && value !== undefined) params.set(key, String(value));
  // A self query cannot contain even a null member selector on the wire.
  return parseUsageQuery(params, scope);
}

function projectProjection(fact: UsageFact, source: UsageFactSnapshot): UsageRecordDTO['project'] {
  return publicUsageProject(fact, source.projectDirectory);
}

function projectRecord(fact: UsageFact, source: UsageFactSnapshot, viewerId: string, media: Map<string, UsageMediaProjection>, events: UsageFactSnapshot['cashEvents']): UsageRecordDTO {
  const image = fact.sourceKind === 'image_task';
  const video = fact.sourceKind === 'video_task';
  const success = ['succeeded', 'completed', 'adopted', 'received'].includes(fact.status);
  const sourceMedia = image || video ? media.get(usageSourceKey(fact)) : undefined;
  const ownedImage = image && fact.currentOwnerUserId === viewerId;
  const parent = !fact.leaf;
  return { id: usageSourceKey(fact), sourceKind: fact.sourceKind, type: usagePublicType(fact), occurredAt: fact.occurredAt,
    status: fact.status, model: fact.model, project: projectProjection(fact, source),
    taskCount: parent ? null : 1, requestCount: null, successfulCount: parent ? null : success ? 1 : 0,
    outputCount: parent ? null : fact.outputCount,
    availableCount: image ? sourceMedia?.available ?? (fact.outputCount === 0 ? 0 : null)
      : video ? sourceMedia?.available ?? null : null,
    cash: publicUsageCash([fact], events), points: publicUsagePoints([fact]),
    originalHref: video ? `/tasks/${encodeURIComponent(fact.sourceId)}` : null,
    ...(ownedImage ? { imageTaskId: fact.sourceId,
      ...(source.publicMetadata?.get(usageSourceKey(fact))?.batchId ? { groupId: source.publicMetadata.get(usageSourceKey(fact))!.batchId } : {}) } : {}),
    ...(sourceMedia?.media ? { media: sourceMedia.media } : {}) };
}

function safeCoverage(source: UsageFactSnapshot, scope: PublicUsageScope): UsageCoverageDTO[] {
  const result: UsageCoverageDTO[] = source.coverage.filter(item => !['agent_text_step', 'cutout_receipt'].includes(item.source)).map(item => ({
    source: item.source, label: item.label, status: item.status === 'complete' ? 'complete' : 'partial',
    detail: item.source === 'cost_ledger' ? '仅连接到当前可读原任务的唯一成本事件；孤立、关联冲突及镜像不计入已确认小计，不提供原账本。'
      : item.source === 'usage_attribution' ? '优先使用原任务冻结归属；缺少记录时只采用可证明的历史字段，不补写历史。'
        : item.source === 'role_run' || item.source === 'toolflow_run' ? '父运行只列运行记录，费用及点数在原叶子计算，不重复相加。'
          : '仅含当前有权查看的原来源；缺少现金或点数依据时保留未知，不按现价估算。',
  }));
  result.push({ source: 'agent_text_step', label: 'Agent文字调用', status: 'unsupported', detail: '本人来源读取尚未支持，未读取或纳入小计。' },
    { source: 'cutout_receipt', label: '抠图回执', status: 'unsupported', detail: '本人回执读取尚未支持，未读取或纳入小计。' },
    { source: 'visibility', label: '可读范围', status: 'restricted', detail: scope.kind === 'self'
      ? '仅统计本人当前可读来源；已失去项目或画布读取权的视频、角色内容不纳入，受限内容不提供数量。本人图片账务与项目名称、媒体权限分别核对。'
      : '这是本项目当前可读小计，不代表全体成员完整费用；成员筛选不会增加他人图片或私人画布的读取权。受限内容不提供数量。' });
  return result;
}

function compareRecords(a: UsageRecordDTO, b: UsageRecordDTO, sort: UsagePublicQuery['sort']) {
  if (sort === 'cost') {
    const aa = usageInteger(a.cash.netCnyMicros), bb = usageInteger(b.cash.netCnyMicros);
    if (aa === null && bb !== null) return 1;
    if (aa !== null && bb === null) return -1;
    if (aa !== null && bb !== null && aa !== bb) return aa > bb ? -1 : 1;
  }
  return (sort === 'oldest' ? a.occurredAt.localeCompare(b.occurredAt) : b.occurredAt.localeCompare(a.occurredAt)) || a.id.localeCompare(b.id);
}

export async function getUsagePublicReferenceSnapshot(scope: PublicUsageScope, input: UsagePublicQuery): Promise<UsageExportSnapshot> {
  if (scope.kind !== 'self' && scope.kind !== 'project') throw new AuthError('此入口只接受本人或项目用量范围', 403);
  const user = usageScopeUser(scope);
  const query = canonicalQuery(scope, input);
  return prisma.$transaction(async db => {
    const options = await resolveUsageReadOptions(db, scope, query);
    const asOf = new Date().toISOString();
    const range = usageMonthRange(query);
    const trendMonths = Array.from({ length: 6 }, (_, i) => shiftUsageMonth(query.month, i - 5));
    const source = await readUsageFacts(db, asOf, options, {
      startUtc: usageMonthRange({ ...query, month: trendMonths[0] }).startUtc, endUtc: range.endUtc,
    });
    const projectDirectory = await readUsageProjectDirectory(db, options, query.status, asOf);
    const directoryFacts = source.facts.filter(fact => fact.occurredAt <= asOf && (!query.status || fact.status === query.status));
    const allFacts = directoryFacts.filter(fact => !query.project_id || (query.project_id === 'unassigned'
      ? fact.projectId === null : fact.projectId === query.project_id));
    let media = new Map<string, UsageMediaProjection>();
    let mediaUnavailable = false;
    try { media = await readUsageMedia(db, user, allFacts, scope); }
    catch { mediaUnavailable = true; }
    const eventsBySource = new Map<string, UsageFactSnapshot['cashEvents']>();
    for (const event of source.cashEvents) if (event.sourceKey) {
      const values = eventsBySource.get(event.sourceKey) || [];
      values.push(event); eventsBySource.set(event.sourceKey, values);
    }
    const recordById = new Map(allFacts.map(fact => [usageSourceKey(fact), projectRecord(fact, source, user.id, media, eventsBySource.get(usageSourceKey(fact)) || [])]));
    const monthFacts = allFacts.filter(fact => fact.occurredAt >= range.startUtc && fact.occurredAt < range.endUtc);
    const summary = (facts: UsageFact[]) => publicUsageSummaries(facts, recordById, source.cashEvents);
    const records = monthFacts.filter(fact => usagePublicType(fact) === query.type).map(fact => recordById.get(usageSourceKey(fact))!)
      .sort((a, b) => compareRecords(a, b, query.sort));
    const page = Math.min(query.page, Math.max(1, Math.ceil(records.length / query.limit)));
    const actualQuery = { ...query, page };
    const coverage = safeCoverage(source, scope);
    if (mediaUnavailable) coverage.push({ source: 'media', label: '结果媒体', status: 'partial', detail: '媒体读取权暂时无法确认，保留可读费用，未提供未经核实的媒体入口。' });
    const projects = new Map<string, { id: string | null; label: string }>();
    for (const fact of directoryFacts) {
      const project = projectProjection(fact, source);
      if (project.available) projects.set(project.id || 'unassigned', { id: project.id, label: project.label });
    }
    const trend = { range: { startUtc: usageMonthRange({ ...query, month: trendMonths[0] }).startUtc,
      endUtc: range.endUtc, label: `${trendMonths[0]} 至 ${query.month}（近6月）` }, items: trendMonths.map(month => ({ month,
      ...summary(allFacts.filter(fact => usageLocalDate(new Date(fact.occurredAt), query.time_zone).slice(0, 7) === month)) })) };
    const safe = { schema: 1 as const, scope: scope.kind, query: actualQuery, asOf, range, summary: summary(monthFacts), coverage,
      records: { items: records.slice((page - 1) * query.limit, page * query.limit), total: records.length, page, pageSize: query.limit,
        ...(page !== query.page ? { updated: true } : {}) },
      projects: projectDirectory,
      trend, restricted: true };
    const fingerprint = createHash('sha256').update('public-usage.v1\0').update(scope.kind).update('\0').update(user.id)
      .update(JSON.stringify(actualQuery)).update(JSON.stringify(usageExchangeRate)).update(JSON.stringify(records))
      .update(JSON.stringify([safe.summary, safe.coverage, safe.projects, safe.trend]))
      .update(JSON.stringify(allFacts.map(fact => [usageSourceKey(fact), fact.updatedAt])))
      .update(JSON.stringify(source.sourceFingerprintParts)).digest('hex');
    return { report: { ...safe, fingerprint }, records };
  }, { maxWait: 10000, timeout: 120000 });
}

export async function readUsagePublicSnapshot(db: Parameters<typeof resolveUsageReadOptions>[0], scope: PublicUsageScope, input: UsagePublicQuery, asOf: string): Promise<UsageExportSnapshot> {
  const observed = observeOperation('usage.report');
  if (scope.kind !== 'self' && scope.kind !== 'project') throw new AuthError('此入口只接受本人或项目用量范围', 403);
  const user = usageScopeUser(scope), query = canonicalQuery(scope, input);
  const options = await resolveUsageReadOptions(db, scope, query), range = usageMonthRange(query);
  const trendMonths = Array.from({ length: 6 }, (_, index) => shiftUsageMonth(query.month, index - 5));
  const trendStart = usageMonthRange({ ...query, month: trendMonths[0] }).startUtc;
  const makeSummary = () => ({ video: new PublicUsageSummaryFold(), image: new PublicUsageSummaryFold(), other: new PublicUsageSummaryFold() });
  const summary = makeSummary(), trends = new Map(trendMonths.map(month => [month, makeSummary()]));
  const fingerprint = createHash('sha256').update('public-usage.v2\0').update(scope.kind).update(user.id).update(JSON.stringify(query)).update(JSON.stringify(usageExchangeRate));
  const coverageBySource = new Map<string, UsageFactSnapshot['coverage'][number]>();
  const spool = await usageRowSpool<UsageRecordDTO>((left, right) => compareRecords(left, right, query.sort));
  let mediaUnavailable = false;
  try {
    for await (const source of iterateUsageFactBatches(db, asOf, { startUtc: trendStart, endUtc: range.endUtc }, undefined, options)) {
      const facts = source.facts.filter(fact => fact.occurredAt <= asOf && (!query.status || fact.status === query.status)
        && (!query.project_id || (query.project_id === 'unassigned' ? fact.projectId === null : fact.projectId === query.project_id)));
      let media = new Map<string, UsageMediaProjection>();
      try { media = await readUsageMedia(db, user, facts, scope); } catch { mediaUnavailable = true; }
      const bySource = new Map<string, UsageFactSnapshot['cashEvents']>();
      for (const event of source.cashEvents) if (event.sourceKey) {
        const values = bySource.get(event.sourceKey) || []; values.push(event); bySource.set(event.sourceKey, values);
      }
      const records: UsageRecordDTO[] = [];
      for (const fact of facts) {
        const events = bySource.get(usageSourceKey(fact)) || [], record = projectRecord(fact, source, user.id, media, events);
        const category = usagePublicType(fact), month = usageLocalDate(new Date(fact.occurredAt), query.time_zone).slice(0, 7);
        trends.get(month)?.[category].add(fact, record, events);
        if (fact.occurredAt >= range.startUtc && fact.occurredAt < range.endUtc) {
          summary[category].add(fact, record, events);
          if (category === query.type) records.push(record);
        }
        fingerprint.update(JSON.stringify([record, fact.updatedAt]));
      }
      await spool.add(records);
      for (const part of source.sourceFingerprintParts) fingerprint.update(part);
      for (const coverage of source.coverage) {
        const previous = coverageBySource.get(coverage.source);
        coverageBySource.set(coverage.source, { ...coverage,
          status: previous && previous.status !== 'complete' ? previous.status : coverage.status });
      }
    }
    const records = await spool.finish();
    const page = Math.min(query.page, Math.max(1, Math.ceil(records.length / query.limit))), items: UsageRecordDTO[] = [];
    for await (const record of records.values((page - 1) * query.limit, query.limit)) items.push(record);
    const coverage = safeCoverage({ coverage: Array.from(coverageBySource.values()) } as UsageFactSnapshot, scope);
    if (mediaUnavailable) coverage.push({ source: 'media', label: '结果媒体', status: 'partial', detail: '媒体读取权暂时无法确认，保留可读费用，未提供未经核实的媒体入口。' });
    const projects = await readUsageProjectDirectory(db, options, query.status, asOf);
    const value = (fold: ReturnType<typeof makeSummary>) => ({ video: fold.video.value(), image: fold.image.value(), other: fold.other.value() });
    const report = { schema: 1 as const, scope: scope.kind, query: { ...query, page }, asOf, range, summary: value(summary), coverage,
      records: { items, total: records.length, page, pageSize: query.limit, ...(page !== query.page ? { updated: true } : {}) }, projects,
      trend: { range: { startUtc: trendStart, endUtc: range.endUtc, label: `${trendMonths[0]} 至 ${query.month}（近6月）` },
        items: trendMonths.map(month => ({ month, ...value(trends.get(month)!) })) }, restricted: true };
    fingerprint.update(JSON.stringify([report.query, report.summary, coverage, projects, report.trend]));
    const result = { report: { ...report, fingerprint: fingerprint.digest('hex') }, records, dispose: records.dispose };
    observed({ rows: records.length, bytes: Buffer.byteLength(JSON.stringify(result.report)) });
    return result;
  } catch (error) { await spool.dispose(); throw error; }
}

async function snapshot(scope: PublicUsageScope, input: UsagePublicQuery) {
  return prisma.$transaction(db => readUsagePublicSnapshot(db, scope, input, new Date().toISOString()), { maxWait: 10000, timeout: 120000 });
}

export async function getUsageReport(scope: PublicUsageScope, query: UsagePublicQuery): Promise<UsageReportDTO> {
  const result = await snapshot(scope, query);
  try { return result.report; } finally { await result.dispose?.(); }
}

export async function getUsageExportSnapshot(scope: PublicUsageScope, query: UsagePublicQuery): Promise<UsageExportSnapshot> {
  return snapshot(scope, query);
}
