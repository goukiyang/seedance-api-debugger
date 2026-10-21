import 'server-only';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import type { UsageCoverage, UsageDistribution, UsageFact, UsagePage, UsageQuery, UsageReport, UsageSummary } from './usage-types';
import { readUsageFacts, type UsageCashEvent, type UsageFactSnapshot } from './usage-facts';
import { usageCnyMicros, usageDecimalUnits, usageExchangeRate, usageInteger, usageMoneyTotals, usageUnitsText } from './usage-money';
import { shiftUsageDate, usageLocalDate, usageQuerySearchParams } from './usage-query';

const ZERO = BigInt(0);
const failedStates = new Set(['failed', 'cancelled', 'canceled', 'rejected', 'not-submitted']);

function pointSum(facts: UsageFact[], field: 'chargedPoints' | 'reservedPoints' | 'releasedPoints' | 'refundedPoints') {
  let total = ZERO, known = false;
  for (const fact of facts) {
    if (!fact.leaf || fact[field] === null) continue;
    const units = usageDecimalUnits(fact[field], 2);
    if (units === null) throw new Error('Usage point precision invalid');
    total += units; known = true;
  }
  return known ? usageUnitsText(total) : facts.some(fact => fact.leaf) ? null : '0';
}

export function summarizeUsageFacts(facts: UsageFact[]): UsageSummary {
  const leaf = facts.filter(fact => fact.leaf);
  const confirmedCost = usageMoneyTotals(leaf.flatMap(fact => fact.confirmedCost));
  return {
    usageCount: leaf.length, outputCount: leaf.reduce((sum, fact) => sum + fact.outputCount, 0),
    flowCount: facts.filter(fact => !fact.leaf).length,
    activeMemberCount: new Set(facts.map(fact => fact.ownerUserId).filter(Boolean)).size,
    projectCount: new Set(facts.map(fact => fact.projectId).filter(Boolean)).size,
    confirmedCost, confirmedCostCnyMicros: leaf.length ? usageCnyMicros(confirmedCost) : '0',
    chargedPoints: pointSum(facts, 'chargedPoints'), reservedPoints: pointSum(facts, 'reservedPoints'),
    releasedPoints: pointSum(facts, 'releasedPoints'), refundedPoints: pointSum(facts, 'refundedPoints'),
    pendingCount: leaf.filter(fact => fact.costStatus === 'pending').length,
    conflictCount: facts.filter(fact => fact.attribution === 'conflict' || fact.leaf && fact.costStatus === 'conflict').length,
    unknownCostCount: leaf.filter(fact => fact.costStatus !== 'confirmed').length,
    unassignedCount: facts.filter(fact => !fact.projectId || !fact.ownerUserId).length,
    failedCount: leaf.filter(fact => failedStates.has(fact.status)).length,
    resultNotReadyCount: leaf.filter(fact => fact.resultReady === false).length,
  };
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
  if (sort === 'cost') comparison = cmpBig(usageInteger(a.confirmedCostCnyMicros), usageInteger(b.confirmedCostCnyMicros));
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
    if (sort === 'cost') comparison = cmpBig(usageInteger(a.summary.confirmedCostCnyMicros), usageInteger(b.summary.confirmedCostCnyMicros));
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
  records: UsageFact[];
  members: UsageDistribution[];
  projects: UsageDistribution[];
  cashEvents: UsageCashEvent[];
}

/** Auth must be checked by the caller BEFORE this function is invoked. No writer,
 * finalizer, provider sync, pricing lookup, or historical backfill is called here.
 */
export async function getUsageAnalyticsSnapshot(query: UsageQuery): Promise<UsageAnalyticsSnapshot> {
  return prisma.$transaction(async db => {
    const dataAsOf = new Date().toISOString();
    const source = await readUsageFacts(db, dataAsOf);
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
      { key: 'unconnected-cost', label: '费用未接入', count: facts.filter(fact => fact.leaf && fact.costStatus === 'unconnected').length, href: drillHref(query, { cost_status: 'unconnected' }) },
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

export async function getUsageAnalytics(query: UsageQuery): Promise<UsageReport> {
  return (await getUsageAnalyticsSnapshot(query)).report;
}
