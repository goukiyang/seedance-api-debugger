import 'server-only';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import type { UsageCoverage, UsageDistribution, UsageFact, UsagePage, UsageQuery, UsageReport, UsageSummary, UsageSourceKind } from './usage-types';
import { readUsageFacts, type UsageCashEvent, type UsageFactSnapshot } from './usage-facts';
import { usageExchangeRate, usageInteger, usageMoneyTotals } from './usage-money';
import { shiftUsageDate, usageLocalDate, usageQuerySearchParams } from './usage-query';
import { iterateUsageCashBatches, iterateUsageFactBatches, readUsageDirectories, usageSourceCoverage, type UsageSourceDiagnostic } from '@/lib/usage/facts';
import { UsageSummaryFold } from '@/lib/usage/summary-fold';
import { usageRowSpool, type UsageRows } from '@/lib/usage/row-spool';
import { observeOperation } from '@/lib/performance/server-operations';
import { tracePhase } from '@/lib/performance/request-trace';
import { usageReaderDatabase, type UsageDbSource } from '@/lib/usage/database';
import { withUsageReadSnapshot } from '@/lib/usage/sqlite-read-snapshot';
import type { Prisma } from '@prisma/client';

const ZERO = BigInt(0);
const failedStates = new Set(['failed', 'cancelled', 'canceled', 'rejected', 'not-submitted']);

export function summarizeUsageFacts(facts: UsageFact[]): UsageSummary {
  const fold = new UsageSummaryFold();
  for (const fact of facts) fold.add(fact);
  return fold.value();
}

function matchesId(actual: string | null, expected: string | null) {
  return expected === null || (expected === 'unassigned' ? actual === null : actual === expected);
}

function within(time: string, query: UsageQuery, dataAsOf: string) {
  return !!time && time <= dataAsOf && (!query.startUtc || time >= query.startUtc) && (!query.endUtc || time < query.endUtc);
}

export function usageFactMatches(fact: UsageFact, query: UsageQuery, dataAsOf: string) {
  if (!within(fact.occurredAt, query, dataAsOf) || !matchesId(fact.ownerUserId, query.owner_user_id) || !matchesId(fact.projectId, query.project_id)) return false;
  if (query.cost_status && !fact.leaf) return false;
  if ((query.resolution || query.retention_status) && fact.kind !== 'video' && fact.kind !== 'image') return false;
  for (const [expected, actual] of [[query.kind, fact.kind], [query.source_kind, fact.sourceKind], [query.model, fact.model], [query.provider, fact.provider],
    [query.status, fact.status], [query.cost_status, fact.costStatus], [query.attribution, fact.attribution],
    [query.resolution, fact.resolution || 'unknown'], [query.retention_status, fact.retentionStatus || 'unknown']]) {
    if (expected !== null && expected !== actual) return false;
  }
  if (query.result_ready !== null) {
    const expected = query.result_ready === 'unknown' ? null : query.result_ready === 'ready';
    if (fact.resultReady !== expected) return false;
  }
  // Legacy keyword links search safe record/owner/project/model metadata only.
  // Searching an original prompt would defeat this report's data boundary.
  if (query.keyword) {
    const haystack = [fact.sourceId, fact.parentSourceId, fact.ownerUserId, fact.ownerLabel, fact.projectId, fact.projectLabel, fact.model, fact.provider, fact.status].filter(Boolean).join(' ').toLocaleLowerCase();
    if (!haystack.includes(query.keyword.toLocaleLowerCase())) return false;
  }
  return true;
}

function cmpBig(a: bigint | null, b: bigint | null, descending = true) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a === b ? 0 : (a < b ? -1 : 1) * (descending ? -1 : 1);
}

function compareFact(a: UsageFact, b: UsageFact, sort: UsageQuery['sort']) {
  let comparison = 0;
  if (sort === 'cost') comparison = cmpBig(usageInteger(a.accountingCost?.amountCnyMicros), usageInteger(b.accountingCost?.amountCnyMicros));
  else if (sort === 'usage') comparison = Number(b.leaf) - Number(a.leaf) || b.outputCount - a.outputCount;
  else if (sort === 'name') comparison = a.ownerLabel.localeCompare(b.ownerLabel, 'zh-CN') || a.projectLabel.localeCompare(b.projectLabel, 'zh-CN');
  else comparison = sort === 'oldest' ? a.occurredAt.localeCompare(b.occurredAt) : b.occurredAt.localeCompare(a.occurredAt);
  return comparison || a.sourceKind.localeCompare(b.sourceKind) || a.sourceId.localeCompare(b.sourceId);
}

function page<T>(values: T[], number: number, size: number): UsagePage<T> {
  const total = values.length, actual = Math.min(Math.max(1, number), Math.max(1, Math.ceil(total / size)));
  return { rows: values.slice((actual - 1) * size, actual * size), total, page: actual, pageSize: size };
}

function distributions(facts: UsageFact[], field: 'member' | 'project', directory: Array<{ id: string; label: string }>, query: UsageQuery) {
  const groups = new Map<string | null, { label: string; facts: UsageFact[] }>();
  const selected = field === 'member' ? query.owner_user_id : query.project_id;
  for (const item of directory) {
    if (selected !== null && selected !== item.id) continue;
    groups.set(item.id, { label: item.label, facts: [] });
  }
  if (selected === 'unassigned') groups.set(null, { label: field === 'member' ? '成员未归属' : '未归属项目', facts: [] });
  for (const fact of facts) {
    const id = field === 'member' ? fact.ownerUserId : fact.projectId;
    const label = field === 'member' ? fact.ownerLabel : fact.projectLabel;
    const group = groups.get(id) || { label, facts: [] };
    group.facts.push(fact); groups.set(id, group);
  }
  const values = Array.from(groups, ([id, value]) => ({ id, label: value.label, summary: summarizeUsageFacts(value.facts),
    first: value.facts.reduce((date, fact) => date === '' || fact.occurredAt < date ? fact.occurredAt : date, ''),
    last: value.facts.reduce((date, fact) => fact.occurredAt > date ? fact.occurredAt : date, '') }));
  return values;
}

type Dimension = UsageDistribution & { first: string; last: string };
function sortedDistributions(values: Dimension[], sort: UsageQuery['sort'], search?: string | null): UsageDistribution[] {
  const filtered = search ? values.filter(value => `${value.id || 'unassigned'} ${value.label}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) : values.slice();
  filtered.sort((a, b) => {
    let comparison = 0;
    if (sort === 'cost') comparison = cmpBig(usageInteger(a.summary.accountedCostCnyMicros), usageInteger(b.summary.accountedCostCnyMicros));
    else if (sort === 'usage') comparison = b.summary.usageCount - a.summary.usageCount || b.summary.flowCount - a.summary.flowCount;
    else if (sort === 'oldest') comparison = !a.first || !b.first ? Number(!a.first) - Number(!b.first) : a.first.localeCompare(b.first);
    else if (sort === 'newest') comparison = b.last.localeCompare(a.last);
    else comparison = a.label.localeCompare(b.label, 'zh-CN');
    return comparison || (a.id || '').localeCompare(b.id || '');
  });
  return filtered.map(({ id, label, summary }) => ({ id, label, summary }));
}

function trend(facts: UsageFact[], query: UsageQuery): UsageReport['trend'] {
  const groups = new Map<string, UsageFact[]>();
  for (const fact of facts) {
    let bucket = usageLocalDate(new Date(fact.occurredAt), query.time_zone);
    if (query.grain === 'month') bucket = bucket.slice(0, 7);
    if (query.grain === 'week') {
      const day = new Date(`${bucket}T12:00:00.000Z`).getUTCDay();
      bucket = shiftUsageDate(bucket, -((day + 6) % 7));
    }
    const values = groups.get(bucket) || []; values.push(fact); groups.set(bucket, values);
  }
  // Sparse calendar buckets, no arbitrary day/history cap. An absent bucket is
  // not manufactured into a known zero for a source whose coverage is partial.
  return Array.from(groups).sort(([a], [b]) => a.localeCompare(b)).map(([bucket, values]) => ({ bucket, summary: summarizeUsageFacts(values) }));
}

function filteredCoverage(snapshot: UsageFactSnapshot, facts: UsageFact[], cashEvents: UsageCashEvent[]): UsageCoverage[] {
  return snapshot.coverage.map(value => {
    if (value.source === 'cost_ledger') {
      const total = cashEvents.filter(event => !event.id.startsWith('role-bill:')).length;
      return { ...value, total, frozen: 0, legacy: total, detail: `数量按当前任务群及单列未关联费用；来源读取边界（全历史）：${value.detail}` };
    }
    const items = value.source === 'usage_attribution' ? facts : facts.filter(fact => fact.sourceKind === value.source);
    const frozen = items.filter(fact => ['frozen', 'conflict'].includes(fact.attribution)).length;
    return { ...value, total: items.length, frozen, legacy: items.length - frozen,
      detail: `数量按当前条件；来源读取边界（全历史）：${value.detail}` };
  });
}

function unlinkedMatches(event: UsageCashEvent, query: UsageQuery, dataAsOf: string) {
  if (event.sourceKey) return false;
  if (event.occurredAt ? !within(event.occurredAt, query, dataAsOf) : query.range !== 'all') return false;
  if (!matchesId(event.ownerUserId, query.owner_user_id) || !matchesId(event.projectId, query.project_id)) return false;
  if (query.provider && query.provider !== event.provider) return false;
  if (query.cost_status && query.cost_status !== (event.status === 'confirmed' ? 'confirmed' : event.status === 'conflict' ? 'conflict' : 'pending')) return false;
  // Missing task identity cannot satisfy task-only dimensions. Such costs remain
  // explicitly available in the independent cost ledger, never guessed into a kind.
  if (query.kind || query.source_kind || query.model || query.status || query.resolution || query.retention_status || query.attribution || query.result_ready) return false;
  return !query.keyword || [event.id, event.proofId, event.provider, event.ownerUserId, event.projectId].filter(Boolean).join(' ').toLocaleLowerCase().includes(query.keyword.toLocaleLowerCase());
}

function drillHref(query: UsageQuery, extra: Record<string, string>) {
  const params = usageQuerySearchParams(query, false);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return `/admin?${params.toString()}`;
}

export interface UsageAnalyticsSnapshot {
  report: UsageReport;
  records: UsageFact[] | UsageRows<UsageFact>;
  members: UsageDistribution[];
  projects: UsageDistribution[];
  cashEvents: UsageCashEvent[] | UsageRows<UsageCashEvent>;
  dispose?: () => Promise<void>;
}

/** Auth must be checked by the caller BEFORE this function is invoked. No writer,
 * finalizer, provider sync, pricing lookup, or historical backfill is called here.
 */
export async function getUsageAnalyticsReferenceSnapshot(query: UsageQuery): Promise<UsageAnalyticsSnapshot> {
  return prisma.$transaction(async db => {
    const dataAsOf = new Date().toISOString();
    const source = await readUsageFacts(db, dataAsOf, undefined,
      query.startUtc || query.endUtc ? { startUtc: query.startUtc, endUtc: query.endUtc } : undefined);
    const facts = source.facts.filter(fact => usageFactMatches(fact, query, dataAsOf));
    const controls = query;
    const members = distributions(facts, 'member', source.memberDirectory, query);
    const projects = distributions(facts, 'project', source.projectDirectory, query);
    const memberQuery = { ...query, owner_user_id: null };
    const projectQuery = { ...query, project_id: null };
    const memberDirectory = distributions(source.facts.filter(fact => usageFactMatches(fact, memberQuery, dataAsOf)),
      'member', source.memberDirectory, memberQuery);
    const projectDirectory = distributions(source.facts.filter(fact => usageFactMatches(fact, projectQuery, dataAsOf)),
      'project', source.projectDirectory, projectQuery);
    const selected = (id: string | null, values: Dimension[], directory: Array<{ id: string; label: string }>, label: string) => {
      if (id === null) return null;
      const actualId = id === 'unassigned' ? null : id;
      const value = values.find(item => item.id === actualId);
      const metadata = directory.find(item => item.id === actualId);
      return { id: actualId, label: value?.label || metadata?.label || (actualId ? `${label} ${actualId}（已不可用）` : label === '成员' ? '成员未归属' : '未归属项目'),
        summary: value?.summary || summarizeUsageFacts([]), available: actualId === null || !!metadata };
    };
    const allMembers = sortedDistributions(members, controls.members_sort || query.sort);
    const allProjects = sortedDistributions(projects, controls.projects_sort || query.sort);
    const records = facts.slice().sort((a, b) => compareFact(a, b, query.sort));
    const unlinked = source.cashEvents.filter(event => unlinkedMatches(event, query, dataAsOf));
    const selectedKeys = new Set(facts.map(fact => `${fact.sourceKind}:${fact.sourceId}`));
    // Cash on an old task belongs to its original usage cohort even when the
    // bill arrives in another month. Unlinked bills use bill time separately.
    const unlinkedIds = new Set(unlinked.map(event => event.id));
    const cashEvents = source.cashEvents.filter(event => event.sourceKey ? selectedKeys.has(event.sourceKey) : unlinkedIds.has(event.id));
    const unlinkedMoney = usageMoneyTotals(unlinked.filter(event => event.cashEvidence && event.status === 'confirmed' && event.currency && event.amountMicros !== null)
      .map(event => ({ currency: event.currency!, amountMicros: event.amountMicros! })));
    const summary = summarizeUsageFacts(facts);
    const coverage = filteredCoverage(source, facts, cashEvents);
    const fingerprint = createHash('sha256');
    fingerprint.update('usage-report.v1\0');
    fingerprint.update(usageQuerySearchParams(query, false).toString());
    fingerprint.update(JSON.stringify({ startUtc: query.startUtc, endUtc: query.endUtc }));
    fingerprint.update(JSON.stringify(usageExchangeRate));
    for (const fact of facts.slice().sort((a, b) => `${a.sourceKind}:${a.sourceId}`.localeCompare(`${b.sourceKind}:${b.sourceId}`))) fingerprint.update(JSON.stringify(fact));
    for (const event of cashEvents.slice().sort((a, b) => a.id.localeCompare(b.id))) fingerprint.update(JSON.stringify(event));
    for (const value of source.sourceFingerprintParts) fingerprint.update(value);
    fingerprint.update(JSON.stringify([source.memberDirectory, source.projectDirectory, coverage.map(({ detail: _detail, ...value }) => value)]));
    const exceptions: UsageReport['exceptions'] = [
      ...Array.from(failedStates).map(status => ({ key: `execution-${status}`, label: status === 'failed' ? '生成失败' : status === 'rejected' ? '提交被拒绝' : '生成取消或未提交',
        count: facts.filter(fact => fact.leaf && fact.status === status).length, href: drillHref(query, { status }) })),
      { key: 'pending-cost', label: '费用待核对', count: summary.pendingCount, href: drillHref(query, { cost_status: 'pending' }) },
      { key: 'conflicting-cost', label: '费用冲突', count: facts.filter(fact => fact.leaf && fact.costStatus === 'conflict').length, href: drillHref(query, { cost_status: 'conflict' }) },
      { key: 'unconnected-cost', label: '现金依据未接入', count: facts.filter(fact => fact.leaf && fact.costStatus === 'unconnected').length, href: drillHref(query, { cost_status: 'unconnected' }) },
      { key: 'result-not-ready', label: '结果文件未就绪', count: summary.resultNotReadyCount, href: drillHref(query, { result_ready: 'not_ready' }) },
      { key: 'unassigned-project', label: '未归属项目', count: facts.filter(fact => !fact.projectId).length, href: drillHref(query, { project_id: 'unassigned' }) },
      { key: 'unassigned-member', label: '成员未归属', count: facts.filter(fact => !fact.ownerUserId).length, href: drillHref(query, { owner_user_id: 'unassigned' }) },
      { key: 'attribution-conflict', label: '原归属与当前不同', count: facts.filter(fact => fact.attribution === 'conflict').length, href: drillHref(query, { attribution: 'conflict' }) },
    ];
    const report: UsageReport = { query, dataAsOf, reportFingerprint: fingerprint.digest('hex'), summary, coverage,
      records: page(records, controls.records_page || query.page, query.page_size),
      members: page(allMembers, controls.members_page || query.page, query.page_size),
      projects: page(allProjects, controls.projects_page || query.page, query.page_size),
      memberDirectory: page(sortedDistributions(memberDirectory, controls.members_sort || query.sort, controls.members_search), controls.members_page || 1, query.page_size),
      projectDirectory: page(sortedDistributions(projectDirectory, controls.projects_sort || query.sort, controls.projects_search), controls.projects_page || 1, query.page_size),
      selectedMember: selected(query.owner_user_id, members, source.memberDirectory, '成员'),
      selectedProject: selected(query.project_id, projects, source.projectDirectory, '项目'),
      trend: trend(facts, query),
      unlinkedCosts: { count: unlinked.length, confirmedCost: unlinkedMoney, href: `/admin/usage-costs?${usageQuerySearchParams(query, false)}` }, exchangeRate: usageExchangeRate,
      exceptions: exceptions.filter(value => value.count > 0),
      options: { models: Array.from(new Set(source.facts.map(fact => fact.model).filter((value): value is string => !!value))).sort(),
        providers: Array.from(new Set(source.facts.map(fact => fact.provider).filter((value): value is string => !!value))).sort(),
        statuses: Array.from(new Set(source.facts.map(fact => fact.status))).sort() } };
    return { report, records, members: allMembers, projects: allProjects, cashEvents };
  }, { maxWait: 10000, timeout: 120000 });
}

type FoldDimension = { id: string | null; label: string; fold: UsageSummaryFold; first: string; last: string };

type CapturedUsageBatch = { kind: 'facts'; value: UsageFactSnapshot } | { kind: 'cash'; value: UsageCashEvent[] };
type UsageCaptureSpool = Awaited<ReturnType<typeof usageRowSpool<CapturedUsageBatch>>>;
function checkUsageSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Usage read interrupted');
}

async function captureUsageAnalytics(db: UsageDbSource, query: UsageQuery, dataAsOf: string, spool: UsageCaptureSpool, signal?: AbortSignal) {
  checkUsageSignal(signal);
  const directory = await readUsageDirectories(db);
  const window = query.startUtc || query.endUtc ? { startUtc: query.startUtc, endUtc: query.endUtc } : undefined;
  for await (const batch of iterateUsageFactBatches(db, dataAsOf, window)) {
    checkUsageSignal(signal);
    await spool.add([{ kind: 'facts', value: batch }]);
  }
  for await (const batch of iterateUsageCashBatches(db, window)) {
    checkUsageSignal(signal);
    await spool.add([{ kind: 'cash', value: batch }]);
  }
  checkUsageSignal(signal);
  return { directory, dataAsOf };
}

/** Compatibility for engineering callers that own a Prisma transaction. */
export async function readUsageAnalyticsSnapshot(db: Prisma.TransactionClient, query: UsageQuery, dataAsOf: string): Promise<UsageAnalyticsSnapshot> {
  const spool = await usageRowSpool<CapturedUsageBatch>(() => 0);
  try {
    const captured = await captureUsageAnalytics(db, query, dataAsOf, spool);
    return await foldUsageAnalytics(captured, spool, query);
  } finally { await spool.dispose(); }
}

async function foldUsageAnalytics(captured: Awaited<ReturnType<typeof captureUsageAnalytics>>, spool: UsageCaptureSpool, query: UsageQuery, signal?: AbortSignal): Promise<UsageAnalyticsSnapshot> {
  const { directory, dataAsOf } = captured;
  checkUsageSignal(signal);
  const capturedRows = await spool.finish();
  const observed = observeOperation('usage.report');
  const records = await usageRowSpool<UsageFact>((a, b) => compareFact(a, b, query.sort));
  const events = await usageRowSpool<UsageCashEvent>((a, b) => a.id.localeCompare(b.id)).catch(async error => { await records.dispose(); throw error; });
  let completed = false, rows = 0;
  try {
    const members = new Map<string | null, FoldDimension>(), projects = new Map<string | null, FoldDimension>();
    const memberDirectory = new Map<string | null, FoldDimension>(), projectDirectory = new Map<string | null, FoldDimension>();
    const seed = (target: Map<string | null, FoldDimension>, source: Map<string, string>, selected: string | null) => {
      for (const [id, label] of Array.from(source)) if (selected === null || selected === id) target.set(id, { id, label, fold: new UsageSummaryFold(), first: '', last: '' });
      if (selected === 'unassigned') target.set(null, { id: null, label: target === members || target === memberDirectory ? '成员未归属' : '未归属项目', fold: new UsageSummaryFold(), first: '', last: '' });
    };
    seed(members, directory.members, query.owner_user_id); seed(projects, directory.projects, query.project_id);
    seed(memberDirectory, directory.members, null); seed(projectDirectory, directory.projects, null);
    const fold = new UsageSummaryFold(), trendFolds = new Map<string, UsageSummaryFold>();
    const sourceDiagnostics = new Map<string, UsageSourceDiagnostic>();
    const exceptionCounts = new Map<string, number>();
    const matched = new Map<string, { total: number; frozen: number }>();
    const options = { models: new Set<string>(), providers: new Set<string>(), statuses: new Set<string>() };
    const memberQuery = { ...query, owner_user_id: null }, projectQuery = { ...query, project_id: null };
    let attributionAvailable = true, attributionPartial = false, cashPartial = false, invalidCashTimes = 0;
    let selectedCashCount = 0, unlinkedCount = 0;
    const unlinkedMoney = new Map<string, bigint>();
    const fingerprint = createHash('sha256').update('usage-report.v2-bounded\0').update(usageQuerySearchParams(query, false).toString())
      .update(JSON.stringify({ startUtc: query.startUtc, endUtc: query.endUtc })).update(JSON.stringify(usageExchangeRate));
    const addDimension = (target: Map<string | null, FoldDimension>, fact: UsageFact, field: 'member' | 'project') => {
      const id = field === 'member' ? fact.ownerUserId : fact.projectId, label = field === 'member' ? fact.ownerLabel : fact.projectLabel;
      const group = target.get(id) || { id, label, fold: new UsageSummaryFold(), first: '', last: '' };
      group.fold.add(fact);
      if (!group.first || fact.occurredAt < group.first) group.first = fact.occurredAt;
      if (fact.occurredAt > group.last) group.last = fact.occurredAt;
      target.set(id, group);
    };
    for await (const capturedBatch of capturedRows.values()) {
      checkUsageSignal(signal);
      if (capturedBatch.kind !== 'facts') continue;
      const batch = capturedBatch.value;
      rows += batch.facts.length;
      for (const diagnostic of batch.sourceDiagnostics || []) {
        const total = sourceDiagnostics.get(diagnostic.source) || { ...diagnostic, total: 0, frozen: 0, invalid: 0, unavailableCash: 0, pointMissing: 0, pointConflicts: 0 };
        for (const key of ['total', 'frozen', 'invalid', 'unavailableCash', 'pointMissing', 'pointConflicts'] as const) total[key] += diagnostic[key];
        sourceDiagnostics.set(diagnostic.source, total);
      }
      const attribution = batch.coverage.find(value => value.source === 'usage_attribution');
      attributionAvailable &&= attribution?.status !== 'unavailable'; attributionPartial ||= attribution?.status === 'partial';
      const selected: UsageFact[] = [], selectedKeys = new Set<string>();
      for (const fact of batch.facts) {
        if (fact.model) options.models.add(fact.model); if (fact.provider) options.providers.add(fact.provider); options.statuses.add(fact.status);
        if (usageFactMatches(fact, memberQuery, dataAsOf)) addDimension(memberDirectory, fact, 'member');
        if (usageFactMatches(fact, projectQuery, dataAsOf)) addDimension(projectDirectory, fact, 'project');
        if (!usageFactMatches(fact, query, dataAsOf)) continue;
        selected.push(fact); selectedKeys.add(`${fact.sourceKind}:${fact.sourceId}`); fold.add(fact);
        const exceptionKeys = [
          ...(fact.leaf && failedStates.has(fact.status) ? [`execution-${fact.status}`] : []),
          ...(fact.leaf && fact.costStatus === 'conflict' ? ['conflicting-cost'] : []),
          ...(fact.leaf && fact.costStatus === 'unconnected' ? ['unconnected-cost'] : []),
          ...(!fact.projectId ? ['unassigned-project'] : []), ...(!fact.ownerUserId ? ['unassigned-member'] : []),
          ...(fact.attribution === 'conflict' ? ['attribution-conflict'] : []),
        ];
        for (const key of exceptionKeys) exceptionCounts.set(key, (exceptionCounts.get(key) || 0) + 1);
        addDimension(members, fact, 'member'); addDimension(projects, fact, 'project');
        const count = matched.get(fact.sourceKind) || { total: 0, frozen: 0 };
        count.total++; if (['frozen', 'conflict'].includes(fact.attribution)) count.frozen++; matched.set(fact.sourceKind, count);
        let bucket = usageLocalDate(new Date(fact.occurredAt), query.time_zone);
        if (query.grain === 'month') bucket = bucket.slice(0, 7);
        if (query.grain === 'week') { const day = new Date(`${bucket}T12:00:00.000Z`).getUTCDay(); bucket = shiftUsageDate(bucket, -((day + 6) % 7)); }
        const trendFold = trendFolds.get(bucket) || new UsageSummaryFold(); trendFold.add(fact); trendFolds.set(bucket, trendFold);
        fingerprint.update(JSON.stringify(fact));
      }
      await records.add(selected);
      const cash = batch.cashEvents.filter(event => event.sourceKey && selectedKeys.has(event.sourceKey));
      selectedCashCount += cash.filter(event => !event.id.startsWith('role-bill:')).length;
      await events.add(cash);
      for (const part of batch.sourceFingerprintParts) fingerprint.update(part);
    }
    for await (const capturedBatch of capturedRows.values()) {
      checkUsageSignal(signal);
      if (capturedBatch.kind !== 'cash') continue;
      const batch = capturedBatch.value;
      const selected: UsageCashEvent[] = [];
      for (const event of batch) {
        cashPartial ||= !event.occurredAt || event.cashEvidence && event.status !== 'confirmed';
        if (!event.occurredAt) invalidCashTimes++;
        if (!unlinkedMatches(event, query, dataAsOf)) continue;
        selected.push(event); unlinkedCount++; selectedCashCount++;
        if (event.cashEvidence && event.status === 'confirmed' && event.currency && event.amountMicros !== null) {
          unlinkedMoney.set(event.currency, (unlinkedMoney.get(event.currency) || ZERO) + usageInteger(event.amountMicros)!);
        }
      }
      await events.add(selected);
      for (const event of selected) fingerprint.update(JSON.stringify(event));
    }
    checkUsageSignal(signal);
    const recordRows = await records.finish(), cashRows = await events.finish();
    checkUsageSignal(signal);
    const recordPage = Math.min(Math.max(1, query.records_page || query.page), Math.max(1, Math.ceil(recordRows.length / query.page_size)));
    const pageRows: UsageFact[] = [];
    for await (const fact of recordRows.values((recordPage - 1) * query.page_size, query.page_size)) pageRows.push(fact);
    const dimensions = (values: Map<string | null, FoldDimension>): Dimension[] => Array.from(values.values(), value => ({
      id: value.id, label: value.label, first: value.first, last: value.last, summary: value.fold.value(),
    }));
    const memberValues = dimensions(members), projectValues = dimensions(projects);
    const allMembers = sortedDistributions(memberValues, query.members_sort || query.sort), allProjects = sortedDistributions(projectValues, query.projects_sort || query.sort);
    const selectedDimension = (id: string | null, values: Dimension[], names: Map<string, string>, label: string) => {
      if (id === null) return null;
      const key = id === 'unassigned' ? null : id, value = values.find(item => item.id === key);
      return { id: key, label: value?.label || names.get(key || '') || (key ? `${label} ${key}（已不可用）` : label === '成员' ? '成员未归属' : '未归属项目'),
        summary: value?.summary || summarizeUsageFacts([]), available: key === null || names.has(key) };
    };
    const sourceCoverage = usageSourceCoverage(Array.from(sourceDiagnostics.values()), dataAsOf).map(value => {
      const count = matched.get(value.source) || { total: 0, frozen: 0 };
      return { ...value, ...count, legacy: count.total - count.frozen, detail: `数量按当前条件；来源采用同一截止时点分块读取：${value.detail}` };
    });
    const matchedTotal = Array.from(matched.values()).reduce((total, value) => total + value.total, 0);
    const frozenTotal = Array.from(matched.values()).reduce((total, value) => total + value.frozen, 0);
    const coverage: UsageCoverage[] = [...sourceCoverage,
      { source: 'cost_ledger', label: '原成本账本与未关联费用', status: cashPartial ? 'partial' : 'complete', total: selectedCashCount, frozen: 0, legacy: selectedCashCount,
        detail: `原CostLedger按有界批次读取；当前任务群含迟到现金，未关联费用按现金发生时间单列。${invalidCashTimes ? `${invalidCashTimes}行时间不可读，保留覆盖缺口。` : ''}` },
      { source: 'usage_attribution', label: '原使用归属冻结', status: !attributionAvailable ? 'unavailable' : attributionPartial ? 'partial' : 'complete', total: matchedTotal,
        frozen: frozenTotal, legacy: matchedTotal - frozenTotal, detail: attributionAvailable ? '仅读取现存首建归属；缺行按已支持的历史依据，报表GET不补写。' : '兼容部署尚无UsageAttribution表；使用已支持的历史依据，不写入、不回填。' }];
    const summary = fold.value();
    const exceptions: UsageReport['exceptions'] = [
      ...Array.from(failedStates).map(status => ({ key: `execution-${status}`, label: status === 'failed' ? '生成失败' : status === 'rejected' ? '提交被拒绝' : '生成取消或未提交',
        count: 0, href: drillHref(query, { status }) })),
      { key: 'pending-cost', label: '费用待核对', count: summary.pendingCount, href: drillHref(query, { cost_status: 'pending' }) },
      { key: 'conflicting-cost', label: '费用冲突', count: 0, href: drillHref(query, { cost_status: 'conflict' }) },
      { key: 'unconnected-cost', label: '现金依据未接入', count: 0, href: drillHref(query, { cost_status: 'unconnected' }) },
      { key: 'result-not-ready', label: '结果文件未就绪', count: summary.resultNotReadyCount, href: drillHref(query, { result_ready: 'not_ready' }) },
      { key: 'unassigned-project', label: '未归属项目', count: 0, href: drillHref(query, { project_id: 'unassigned' }) },
      { key: 'unassigned-member', label: '成员未归属', count: 0, href: drillHref(query, { owner_user_id: 'unassigned' }) },
      { key: 'attribution-conflict', label: '原归属与当前不同', count: 0, href: drillHref(query, { attribution: 'conflict' }) },
    ];
    for (const item of exceptions) if (exceptionCounts.has(item.key)) item.count = exceptionCounts.get(item.key)!;
    fingerprint.update(JSON.stringify([Array.from(directory.members), Array.from(directory.projects), coverage.map(({ detail: _detail, ...value }) => value)]));
    const report: UsageReport = { query, dataAsOf, reportFingerprint: fingerprint.digest('hex'), summary, coverage,
      records: { rows: pageRows, total: recordRows.length, page: recordPage, pageSize: query.page_size },
      members: page(allMembers, query.members_page || query.page, query.page_size), projects: page(allProjects, query.projects_page || query.page, query.page_size),
      memberDirectory: page(sortedDistributions(dimensions(memberDirectory), query.members_sort || query.sort, query.members_search), query.members_page || 1, query.page_size),
      projectDirectory: page(sortedDistributions(dimensions(projectDirectory), query.projects_sort || query.sort, query.projects_search), query.projects_page || 1, query.page_size),
      selectedMember: selectedDimension(query.owner_user_id, memberValues, directory.members, '成员'), selectedProject: selectedDimension(query.project_id, projectValues, directory.projects, '项目'),
      trend: Array.from(trendFolds).sort(([a], [b]) => a.localeCompare(b)).map(([bucket, value]) => ({ bucket, summary: value.value() })),
      unlinkedCosts: { count: unlinkedCount, confirmedCost: usageMoneyTotals(Array.from(unlinkedMoney, ([currency, amount]) => ({ currency, amountMicros: amount.toString() }))), href: `/admin/usage-costs?${usageQuerySearchParams(query, false)}` },
      exchangeRate: usageExchangeRate, exceptions: exceptions.filter(value => value.count > 0),
      options: { models: Array.from(options.models).sort(), providers: Array.from(options.providers).sort(), statuses: Array.from(options.statuses).sort() } };
    completed = true; observed({ rows, bytes: Buffer.byteLength(JSON.stringify(report)) });
    return { report, records: recordRows, members: allMembers, projects: allProjects, cashEvents: cashRows,
      dispose: async () => { await recordRows.dispose(); await cashRows.dispose(); } };
  } finally { if (!completed) { await records.dispose(); await events.dispose(); } }
}

export async function getUsageAnalyticsSnapshot(query: UsageQuery, signal?: AbortSignal): Promise<UsageAnalyticsSnapshot> {
  const spool = await usageRowSpool<CapturedUsageBatch>(() => 0);
  try {
    const captured = await tracePhase('snapshot', () => withUsageReadSnapshot((reader, dataAsOf) =>
      tracePhase('capture', () => captureUsageAnalytics(usageReaderDatabase(reader), query, dataAsOf, spool, signal)), { signal }));
    return await tracePhase('fold', () => foldUsageAnalytics(captured, spool, query, signal));
  } finally { await spool.dispose(); }
}

/** Current display photos are separate from the frozen financial snapshot and bounded to the returned page. */
async function currentUsageAvatars(ids: Array<string | null | undefined>) {
  const selected = Array.from(new Set(ids.filter((id): id is string => !!id)));
  if (!selected.length) return new Map<string, string | null>();
  try {
    const people = await prisma.user.findMany({ where: { id: { in: selected } }, select: { id: true, avatar_url: true } });
    return new Map(people.map(person => [person.id, person.avatar_url]));
  } catch (error) {
    // A failed optional photo read must not discard an already captured financial report.
    console.warn('[UsageAvatars] Current photos unavailable:', error instanceof Error ? error.message : String(error));
    return new Map<string, string | null>();
  }
}

export async function getUsageAnalytics(query: UsageQuery, signal?: AbortSignal): Promise<UsageReport> {
  const snapshot = await getUsageAnalyticsSnapshot(query, signal);
  try {
    const report = snapshot.report;
    const avatars = await currentUsageAvatars([...report.members.rows.map(row => row.id), ...report.memberDirectory.rows.map(row => row.id),
      report.selectedMember?.id, ...report.records.rows.map(row => row.ownerUserId)]);
    const member = (row: UsageDistribution) => ({ ...row, avatarUrl: row.id ? avatars.get(row.id) || null : null });
    return { ...report, members: { ...report.members, rows: report.members.rows.map(member) },
      memberDirectory: { ...report.memberDirectory, rows: report.memberDirectory.rows.map(member) },
      selectedMember: report.selectedMember ? { ...report.selectedMember, ...member(report.selectedMember) } : null,
      records: { ...report.records, rows: report.records.rows.map(row => ({ ...row, ownerAvatarUrl: row.ownerUserId ? avatars.get(row.ownerUserId) || null : null })) } };
  } finally { await snapshot.dispose?.(); }
}

async function exactUsageFact(db: UsageDbSource, kind: UsageSourceKind, id: string, asOf: string) {
  const ids = kind === 'cutout_receipt' ? (await db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "PlatformSetting"
    WHERE substr("key", 1, 21) = 'image_result_next_v1:' AND json_extract(CASE WHEN json_valid("value_json") THEN "value_json" ELSE '{}' END, '$.receiptId') = ${id}
    ORDER BY "id" ASC LIMIT 2`).map(row => row.id) : [id];
  const batch = await readUsageFacts(db, asOf, undefined, undefined, { kind, ids });
  return batch.facts.find(fact => fact.sourceKind === kind && fact.sourceId === id && fact.occurredAt <= asOf) || null;
}

export async function getUsageRecordPage(kind: UsageSourceKind, id: string, requestedPage: number) {
  const spool = await usageRowSpool<UsageFact>(() => 0);
  try {
    const captured = await tracePhase('snapshot', () => withUsageReadSnapshot((reader, asOf) => tracePhase('capture', async () => {
      const db = usageReaderDatabase(reader), record = await exactUsageFact(db, kind, id, asOf);
      if (!record) return null;
      const parent = record.parentSourceKind && record.parentSourceId ? await exactUsageFact(db, record.parentSourceKind, record.parentSourceId, asOf) : null;
      for await (const batch of iterateUsageFactBatches(db, asOf, undefined, { kind, id })) {
        await spool.add(batch.facts.filter(fact => fact.parentSourceKind === kind && fact.parentSourceId === id && fact.sourceId !== id && fact.occurredAt <= asOf));
      }
      return { asOf, record, parent };
    })));
    if (!captured) return null;
    return await tracePhase('fold', async () => {
      const sorted = await usageRowSpool<UsageFact>((a, b) => compareFact(a, b, 'newest'));
      try {
        const raw = await spool.finish(); let batch: UsageFact[] = [];
        for await (const fact of raw.values()) {
          batch.push(fact);
          if (batch.length === 500) { await sorted.add(batch); batch = []; }
        }
        await sorted.add(batch);
        const children = await sorted.finish(), page = Math.min(Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1, Math.max(1, Math.ceil(children.length / 30)));
        const items: UsageFact[] = []; for await (const child of children.values((page - 1) * 30, 30)) items.push(child);
        const avatars = await currentUsageAvatars([captured.record.ownerUserId]);
        return { asOf: captured.asOf, record: { ...captured.record, ownerAvatarUrl: captured.record.ownerUserId ? avatars.get(captured.record.ownerUserId) || null : null },
          parents: captured.parent ? [captured.parent] : [], children: items, total: children.length, page };
      } finally { await sorted.dispose(); }
    });
  } finally { await spool.dispose(); }
}

export async function getUsageUnlinkedPage(query: UsageQuery) {
  const spool = await usageRowSpool<UsageCashEvent>(() => 0);
  try {
    const asOf = await tracePhase('snapshot', () => withUsageReadSnapshot((reader, dataAsOf) => tracePhase('capture', async () => {
      for await (const batch of iterateUsageCashBatches(usageReaderDatabase(reader), query.startUtc || query.endUtc ? { startUtc: query.startUtc, endUtc: query.endUtc } : undefined)) {
        await spool.add(batch.filter(event => unlinkedMatches(event, query, dataAsOf)));
      }
      return dataAsOf;
    })));
    return await tracePhase('fold', async () => {
      const sorted = await usageRowSpool<UsageCashEvent>((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
      try {
        const raw = await spool.finish(), totals = new Map<string, bigint>(); let batch: UsageCashEvent[] = [];
        for await (const event of raw.values()) {
          if (event.cashEvidence && event.status === 'confirmed' && event.currency && event.amountMicros !== null) {
            totals.set(event.currency, (totals.get(event.currency) || ZERO) + usageInteger(event.amountMicros)!);
          }
          batch.push(event);
          if (batch.length === 500) { await sorted.add(batch); batch = []; }
        }
        await sorted.add(batch);
        const stored = await sorted.finish(), pages = Math.max(1, Math.ceil(stored.length / query.page_size)), page = Math.min(query.page, pages);
        const rows: UsageCashEvent[] = []; for await (const event of stored.values((page - 1) * query.page_size, query.page_size)) rows.push(event);
        return { asOf, rows, total: stored.length, page, pages, confirmedCost: usageMoneyTotals(Array.from(totals, ([currency, amount]) => ({ currency, amountMicros: amount.toString() }))) };
      } finally { await sorted.dispose(); }
    });
  } finally { await spool.dispose(); }
}
