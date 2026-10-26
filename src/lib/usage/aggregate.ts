import type { UsageFact } from '@/lib/admin/usage-types';
import type { UsageCashEvent } from './facts';
import { usageCnyMicros, usageDecimalUnits, usageInteger, usageMoneyTotals, usageUnitsText } from '@/lib/admin/usage-money';
import type { UsageCashDTO, UsageCategorySummary, UsagePointsDTO, UsagePointsPartDTO, UsageRecordDTO, UsageType } from './dto';

const ZERO = BigInt(0);
export const usagePublicType = (fact: UsageFact): UsageType => fact.kind === 'video' ? 'video' : fact.kind === 'image' ? 'image' : 'other';
export const usageSourceKey = (fact: UsageFact) => `${fact.sourceKind}:${fact.sourceId}`;

export function preferProvenCnyEvents(events: UsageCashEvent[]): UsageCashEvent[] {
  const groups = new Map<string, UsageCashEvent[]>();
  for (const event of events) {
    if (!event.proofId || !event.providerScopeFingerprint || !event.sourceKey || !event.providerReference) continue;
    const key = JSON.stringify([event.sourceKey, event.provider, event.providerScopeFingerprint, event.providerReference, event.proofId, event.eventType]);
    const group = groups.get(key) || [];
    group.push(event); groups.set(key, group);
  }
  const mirrors = new Set<UsageCashEvent>();
  for (const group of Array.from(groups.values())) {
    const cny = group.filter(event => event.currency === 'CNY' && event.status === 'confirmed');
    const usd = group.filter(event => event.currency === 'USD' && event.status === 'confirmed');
    if (group.length === 2 && cny.length === 1 && usd.length === 1) mirrors.add(usd[0]);
  }
  return events.filter(event => !mirrors.has(event));
}

export function publicUsageProject(fact: UsageFact, directory: Array<{ id: string; label: string }>): UsageRecordDTO['project'] {
  if (!fact.projectId) return { id: null, label: '未归属项目', available: true };
  const project = directory.find(item => item.id === fact.projectId);
  return project ? { id: project.id, label: project.label, available: true } : { id: null, label: '项目已不可访问', available: false };
}

export function publicUsageCash(facts: UsageFact[], events: UsageCashEvent[]): UsageCashDTO {
  const leaves = facts.filter(fact => fact.leaf);
  const keys = new Set(leaves.map(usageSourceKey));
  const conflicts = new Set(leaves.filter(fact => fact.costStatus === 'conflict').map(usageSourceKey));
  const selected = preferProvenCnyEvents(events.filter(event => event.sourceKey && keys.has(event.sourceKey) && event.cashEvidence));
  const confirmed = selected.filter(event => event.status === 'confirmed' && event.sourceKey && !conflicts.has(event.sourceKey)
    && event.currency && usageInteger(event.amountMicros) !== null);
  const charges = confirmed.filter(event => event.eventType === 'official_charge');
  const refunds = confirmed.filter(event => ['refund', 'reversal'].includes(event.eventType));
  const money = (values: UsageCashEvent[], refund = false) => usageMoneyTotals(values.map(event => {
    const amount = BigInt(event.amountMicros!);
    return { currency: event.currency!, amountMicros: (refund && amount < ZERO ? -amount : amount).toString() };
  }));
  const chargeOriginal = money(charges), refundOriginal = money(refunds, true);
  const netOriginal = usageMoneyTotals([...chargeOriginal, ...refundOriginal.map(value => ({ ...value, amountMicros: (-BigInt(value.amountMicros)).toString() }))]);
  const unknown = leaves.some(fact => fact.costStatus !== 'confirmed');
  const currencies = new Set(netOriginal.map(value => value.currency));
  const basis: UsageCashDTO['basis'] = !currencies.size || Array.from(currencies).some(currency => !['CNY', 'USD'].includes(currency)) ? 'UNAVAILABLE'
    : currencies.size === 2 ? 'MIXED_CNY_USD' : currencies.has('USD') ? 'USD_CNY_DISPLAY' : 'CNY';
  const known = confirmed.length > 0;
  const emptySide = (values: ReturnType<typeof money>) => values.length ? usageCnyMicros(values) : known && basis !== 'UNAVAILABLE' ? '0' : null;
  return { chargeOriginal, refundOriginal, netOriginal,
    chargeCnyMicros: emptySide(chargeOriginal), refundCnyMicros: emptySide(refundOriginal), netCnyMicros: usageCnyMicros(netOriginal), basis,
    state: conflicts.size || selected.some(event => event.status === 'conflict') ? 'conflict'
      : known ? unknown || selected.some(event => event.status !== 'confirmed') || basis === 'UNAVAILABLE' ? 'partial' : 'confirmed'
        : leaves.some(fact => fact.costStatus === 'pending') ? 'pending' : 'unavailable' };
}

function pointsPart(facts: UsageFact[]): UsagePointsPartDTO {
  const sum = (field: 'chargedPoints' | 'refundedPoints' | 'reservedPoints' | 'releasedPoints') => {
    const values = facts.filter(fact => fact.leaf).map(fact => usageDecimalUnits(fact[field], 2)).filter((value): value is bigint => value !== null);
    return values.length ? usageUnitsText(values.reduce((a, b) => a + b, ZERO)) : null;
  };
  const charged = sum('chargedPoints'), refunded = sum('refundedPoints');
  return { charged, refunded, net: charged !== null && refunded !== null ? usageUnitsText(usageDecimalUnits(charged, 2)! - usageDecimalUnits(refunded, 2)!) : null,
    reserved: sum('reservedPoints'), released: sum('releasedPoints') };
}

export function publicUsagePoints(facts: UsageFact[]): UsagePointsDTO {
  const personal = facts.filter(fact => fact.billingSubject?.startsWith('user:'));
  const project = facts.filter(fact => fact.billingSubject?.startsWith('project:'));
  return { ...pointsPart(facts), personal: pointsPart(personal), project: pointsPart(project),
    unclassified: pointsPart(facts.filter(fact => !personal.includes(fact) && !project.includes(fact))) };
}

export function summarizePublicUsage(records: UsageRecordDTO[], facts: UsageFact[], events: UsageCashEvent[]): UsageCategorySummary {
  const leafKeys = new Set(facts.filter(fact => fact.leaf).map(usageSourceKey));
  const leaves = records.filter(record => leafKeys.has(record.id));
  const sum = (field: 'taskCount' | 'requestCount' | 'successfulCount' | 'outputCount' | 'availableCount') =>
    leaves.some(record => record[field] === null) ? null : leaves.reduce((total, record) => total + record[field]!, 0);
  return { taskCount: sum('taskCount'), requestCount: leaves.length ? sum('requestCount') : null,
    successfulCount: sum('successfulCount'), outputCount: sum('outputCount'), availableCount: sum('availableCount'),
    cash: publicUsageCash(facts, events), points: publicUsagePoints(facts),
    pendingCount: facts.filter(fact => fact.leaf && ['pending', 'unconnected'].includes(fact.costStatus)).length,
    conflictCount: facts.filter(fact => fact.leaf && fact.costStatus === 'conflict').length };
}

/** The detail type is deliberately not an argument to the category summaries. */
export function publicUsageSummaries(facts: UsageFact[], records: Map<string, UsageRecordDTO>, events: UsageCashEvent[]) {
  const category = (type: UsageType) => {
    const selected = facts.filter(fact => usagePublicType(fact) === type);
    return summarizePublicUsage(selected.map(fact => records.get(usageSourceKey(fact))!), selected, events);
  };
  return { video: category('video'), image: category('image'), other: category('other') };
}
