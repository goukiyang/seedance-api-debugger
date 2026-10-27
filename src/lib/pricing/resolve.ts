import type { PricingAdminIdentity } from './admin-contract';
import { PublicApiError } from '@/lib/http/public-error';

type Rule = { id: string; identity: PricingAdminIdentity };
export class PricingRuleConflict extends PublicApiError {
  readonly status = 409;
  readonly code = 'pricing_rule_ambiguous';
  constructor(public readonly ruleIds: string[]) { super(`收费规则存在同级冲突：${ruleIds.join('、')}`, 409, 'pricing_rule_ambiguous'); }
}

function sameScope(left: PricingAdminIdentity, right: PricingAdminIdentity) {
  return left.kind === right.kind && left.channelId === right.channelId && left.modelId === right.modelId
    && left.billingMode === right.billingMode && left.unit === right.unit;
}

export function selectPricingRule<T extends Rule>(rules: readonly T[], identity: PricingAdminIdentity): T | null {
  const candidates = rules.filter(rule => sameScope(rule.identity, identity)
    && Object.entries(rule.identity.specifications).every(([key, value]) => identity.specifications[key] === value));
  if (!candidates.length) return null;
  const priority = Math.max(...candidates.map(rule => Object.keys(rule.identity.specifications).length));
  const selected = candidates.filter(rule => Object.keys(rule.identity.specifications).length === priority);
  if (selected.length !== 1) throw new PricingRuleConflict(selected.map(rule => rule.id));
  return selected[0];
}

export function assertNoRuleAmbiguity(rules: readonly Rule[]) {
  if (rules.length > 2000 || new Set(rules.map(rule => rule.id)).size !== rules.length) throw new PricingRuleConflict(rules.map(rule => rule.id));
  for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
    const a = rules[i], b = rules[j];
    if (!sameScope(a.identity, b.identity)
      || Object.keys(a.identity.specifications).length !== Object.keys(b.identity.specifications).length) continue;
    const overlaps = Object.entries(a.identity.specifications)
      .every(([key, value]) => b.identity.specifications[key] === undefined || b.identity.specifications[key] === value);
    if (overlaps) throw new PricingRuleConflict([a.id, b.id]);
  }
}
