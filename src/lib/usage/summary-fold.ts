import type { UsageFact, UsageSummary } from '@/lib/admin/usage-types';
import { usageCnyMicros, usageDecimalUnits, usageInteger, usageMoneyTotals, usageUnitsText } from '@/lib/admin/usage-money';

const pointFields = ['chargedPoints', 'reservedPoints', 'releasedPoints', 'refundedPoints'] as const;
const failed = new Set(['failed', 'cancelled', 'canceled', 'rejected', 'not-submitted']);

/** Same integer sums as summarizeUsageFacts, without retaining the source facts. */
export class UsageSummaryFold {
  private counts = { usageCount: 0, outputCount: 0, flowCount: 0, pendingCount: 0, conflictCount: 0,
    unknownCostCount: 0, unassignedCount: 0, failedCount: 0, resultNotReadyCount: 0 };
  private members = new Set<string>();
  private projects = new Set<string>();
  private money = new Map<string, bigint>();
  private points = new Map<typeof pointFields[number], bigint>();
  add(fact: UsageFact) {
    if (fact.ownerUserId) this.members.add(fact.ownerUserId);
    if (fact.projectId) this.projects.add(fact.projectId);
    if (!fact.ownerUserId || !fact.projectId) this.counts.unassignedCount++;
    if (fact.attribution === 'conflict' || fact.leaf && fact.costStatus === 'conflict') this.counts.conflictCount++;
    if (!fact.leaf) { this.counts.flowCount++; return; }
    this.counts.usageCount++; this.counts.outputCount += fact.outputCount;
    if (fact.costStatus === 'pending') this.counts.pendingCount++;
    if (fact.costStatus !== 'confirmed') this.counts.unknownCostCount++;
    if (failed.has(fact.status)) this.counts.failedCount++;
    if (fact.resultReady === false) this.counts.resultNotReadyCount++;
    for (const amount of fact.confirmedCost) {
      const value = usageInteger(amount.amountMicros);
      if (value === null) throw new Error('Usage cash precision invalid');
      this.money.set(amount.currency, (this.money.get(amount.currency) || BigInt(0)) + value);
    }
    for (const field of pointFields) if (fact[field] !== null) {
      const value = usageDecimalUnits(fact[field], 2);
      if (value === null) throw new Error('Usage point precision invalid');
      this.points.set(field, (this.points.get(field) || BigInt(0)) + value);
    }
  }
  value(): UsageSummary {
    const confirmedCost = usageMoneyTotals(Array.from(this.money, ([currency, amount]) => ({ currency, amountMicros: amount.toString() })));
    const points = Object.fromEntries(pointFields.map(field => [field, this.points.has(field) ? usageUnitsText(this.points.get(field)!) : this.counts.usageCount ? null : '0'])) as Pick<UsageSummary, typeof pointFields[number]>;
    return { ...this.counts, ...points, confirmedCost,
      confirmedCostCnyMicros: this.counts.usageCount ? usageCnyMicros(confirmedCost) : '0',
      activeMemberCount: this.members.size, projectCount: this.projects.size };
  }
}
