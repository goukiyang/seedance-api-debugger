import 'server-only';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { readUsageFacts, type UsageFactSnapshot } from './facts';
import type { UsageFact } from '@/lib/admin/usage-types';
import { usageExchangeRate, usageInteger } from '@/lib/admin/usage-money';
import { usageLocalDate } from '@/lib/admin/usage-query';
import type { PublicUsageScope, UsageCoverageDTO, UsageExportSnapshot, UsagePublicQuery, UsageRecordDTO, UsageReportDTO } from './dto';
import { parseUsageQuery, shiftUsageMonth, usageMonthRange } from './query';
import { resolveUsageReadOptions } from './source-scope';
import { usageScopeUser } from './access';
import { publicUsageCash, publicUsagePoints, publicUsageProject, publicUsageSummaries, usagePublicType, usageSourceKey } from './aggregate';
import { readUsageMedia, type UsageMediaProjection } from './media';

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

async function snapshot(scope: PublicUsageScope, input: UsagePublicQuery): Promise<UsageExportSnapshot> {
  if (scope.kind !== 'self' && scope.kind !== 'project') throw new AuthError('此入口只接受本人或项目用量范围', 403);
  const user = usageScopeUser(scope);
  const query = canonicalQuery(scope, input);
  return prisma.$transaction(async db => {
    const options = await resolveUsageReadOptions(db, scope, query);
    const asOf = new Date().toISOString();
    const source = await readUsageFacts(db, asOf, options);
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
    const range = usageMonthRange(query);
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
    const trendMonths = Array.from({ length: 6 }, (_, i) => shiftUsageMonth(query.month, i - 5));
    const trend = { range: { startUtc: usageMonthRange({ ...query, month: trendMonths[0] }).startUtc,
      endUtc: range.endUtc, label: `${trendMonths[0]} 至 ${query.month}（近6月）` }, items: trendMonths.map(month => ({ month,
      ...summary(allFacts.filter(fact => usageLocalDate(new Date(fact.occurredAt), query.time_zone).slice(0, 7) === month)) })) };
    const safe = { schema: 1 as const, scope: scope.kind, query: actualQuery, asOf, range, summary: summary(monthFacts), coverage,
      records: { items: records.slice((page - 1) * query.limit, page * query.limit), total: records.length, page, pageSize: query.limit,
        ...(page !== query.page ? { updated: true } : {}) },
      projects: Array.from(projects.values()).sort((a, b) => a.label.localeCompare(b.label) || (a.id || '').localeCompare(b.id || '')),
      trend, restricted: true };
    const fingerprint = createHash('sha256').update('public-usage.v1\0').update(scope.kind).update('\0').update(user.id)
      .update(JSON.stringify(actualQuery)).update(JSON.stringify(usageExchangeRate)).update(JSON.stringify(records))
      .update(JSON.stringify([safe.summary, safe.coverage, safe.projects, safe.trend]))
      .update(JSON.stringify(allFacts.map(fact => [usageSourceKey(fact), fact.updatedAt])))
      .update(JSON.stringify(source.sourceFingerprintParts)).digest('hex');
    return { report: { ...safe, fingerprint }, records };
  }, { maxWait: 10000, timeout: 120000 });
}

export async function getUsageReport(scope: PublicUsageScope, query: UsagePublicQuery): Promise<UsageReportDTO> {
  return (await snapshot(scope, query)).report;
}

export async function getUsageExportSnapshot(scope: PublicUsageScope, query: UsagePublicQuery): Promise<UsageExportSnapshot> {
  return snapshot(scope, query);
}
