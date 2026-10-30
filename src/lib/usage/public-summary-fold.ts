import type { UsageFact } from '@/lib/admin/usage-types';
import { usageCnyMicros, usageDecimalUnits, usageInteger, usageMoneyTotals, usageUnitsText } from '@/lib/admin/usage-money';
import { preferProvenCnyEvents, usageSourceKey } from './aggregate';
import type { UsageCashEvent } from './facts';
import type { UsageCategorySummary, UsagePointsPartDTO, UsageRecordDTO } from './dto';

const fields = ['taskCount', 'requestCount', 'successfulCount', 'outputCount', 'availableCount'] as const;
const pointFields = ['chargedPoints', 'refundedPoints', 'reservedPoints', 'releasedPoints'] as const;

/** Aggregate the original evidence, converting currencies only after integer summation. */
export class PublicUsageSummaryFold {
  private counts = new Map<typeof fields[number], number | null>(fields.map(field => [field, 0]));
  private leaves = 0;
  private pending = 0;
  private conflicts = 0;
  private unknown = false;
  private selectedConflict = false;
  private selectedUnknown = false;
  private confirmed = false;
  private charges = new Map<string, bigint>();
  private refunds = new Map<string, bigint>();
  private points = new Map<string, bigint>();
  add(fact: UsageFact, record: UsageRecordDTO, events: UsageCashEvent[]) {
    if (!fact.leaf) return;
    this.leaves++;
    for (const field of fields) this.counts.set(field, this.counts.get(field) === null || record[field] === null ? null : this.counts.get(field)! + record[field]!);
    this.pending += Number(['pending', 'unconnected'].includes(fact.costStatus));
    this.pendingCost ||= fact.costStatus === 'pending';
    this.conflicts += Number(fact.costStatus === 'conflict');
    this.unknown ||= fact.costStatus !== 'confirmed';
    const subject = fact.billingSubject?.startsWith('user:') ? 'personal' : fact.billingSubject?.startsWith('project:') ? 'project' : 'unclassified';
    for (const field of pointFields) {
      const value = usageDecimalUnits(fact[field], 2);
      if (value !== null) for (const scope of ['all', subject]) {
        const key = `${scope}:${field}`; this.points.set(key, (this.points.get(key) || BigInt(0)) + value);
      }
    }
    for (const event of preferProvenCnyEvents(events.filter(event => event.sourceKey === usageSourceKey(fact) && event.cashEvidence))) {
      this.selectedConflict ||= event.status === 'conflict';
      this.selectedUnknown ||= event.status !== 'confirmed';
      const value = usageInteger(event.amountMicros);
      if (event.status !== 'confirmed' || fact.costStatus === 'conflict' || !event.currency || value === null) continue;
      this.confirmed = true;
      const target = event.eventType === 'official_charge' ? this.charges : ['refund', 'reversal'].includes(event.eventType) ? this.refunds : null;
      if (target) target.set(event.currency, (target.get(event.currency) || BigInt(0)) + (target === this.refunds && value < BigInt(0) ? -value : value));
    }
  }
  value(): UsageCategorySummary {
    const money = (map: Map<string, bigint>) => usageMoneyTotals(Array.from(map, ([currency, value]) => ({ currency, amountMicros: value.toString() })));
    const chargeOriginal = money(this.charges), refundOriginal = money(this.refunds);
    const netOriginal = usageMoneyTotals([...chargeOriginal, ...refundOriginal.map(value => ({ ...value, amountMicros: (-BigInt(value.amountMicros)).toString() }))]);
    const currencies = new Set(netOriginal.map(value => value.currency));
    const basis = !currencies.size || Array.from(currencies).some(value => !['CNY', 'USD'].includes(value)) ? 'UNAVAILABLE'
      : currencies.size === 2 ? 'MIXED_CNY_USD' : currencies.has('USD') ? 'USD_CNY_DISPLAY' : 'CNY';
    const part = (scope: string): UsagePointsPartDTO => {
      const amount = (field: typeof pointFields[number]) => this.points.has(`${scope}:${field}`) ? usageUnitsText(this.points.get(`${scope}:${field}`)!) : null;
      const charged = amount('chargedPoints'), refunded = amount('refundedPoints');
      return { charged, refunded, net: charged !== null && refunded !== null ? usageUnitsText(usageDecimalUnits(charged, 2)! - usageDecimalUnits(refunded, 2)!) : null,
        reserved: amount('reservedPoints'), released: amount('releasedPoints') };
    };
    const side = (values: typeof chargeOriginal) => values.length ? usageCnyMicros(values) : this.confirmed && basis !== 'UNAVAILABLE' ? '0' : null;
    return { taskCount: this.counts.get('taskCount')!, requestCount: this.leaves ? this.counts.get('requestCount')! : null,
      successfulCount: this.counts.get('successfulCount')!, outputCount: this.counts.get('outputCount')!, availableCount: this.counts.get('availableCount')!,
      cash: { chargeOriginal, refundOriginal, netOriginal, chargeCnyMicros: side(chargeOriginal), refundCnyMicros: side(refundOriginal), netCnyMicros: usageCnyMicros(netOriginal), basis,
        state: this.conflicts || this.selectedConflict ? 'conflict' : this.confirmed ? this.unknown || this.selectedUnknown || basis === 'UNAVAILABLE' ? 'partial' : 'confirmed'
          : this.pendingCost ? 'pending' : 'unavailable' },
      points: { ...part('all'), personal: part('personal'), project: part('project'), unclassified: part('unclassified') },
      pendingCount: this.pending, conflictCount: this.conflicts };
  }
  private pendingCost = false;
}
