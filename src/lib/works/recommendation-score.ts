export const WORK_RECOMMENDATION_RULE = 1;

const points = { revisit: 1, take: 6, input: 8, retained: 12, replaced: -6, superseded: -4 } as const;

type RecommendationFact = {
  purpose: string;
  chain: string;
  signal: keyof typeof points;
};

/** An atomic business transition. A null fact retracts the named evidence. */
export type RecommendationStep = {
  id: string;
  order: number; // Business order for this version and audience, independent of delivery order.
  changes: Record<string, RecommendationFact | null>;
};

function total(facts: ReadonlyMap<string, RecommendationFact>) {
  const purposes = new Map<string, { gains: Map<string, number>; losses: Map<string, number> }>();
  const revisits = new Set<string>();
  for (const fact of Array.from(facts.values())) {
    if (fact.signal === 'revisit') {
      revisits.add(fact.chain);
      continue;
    }
    const purpose = purposes.get(fact.purpose) ?? { gains: new Map<string, number>(), losses: new Map<string, number>() };
    purposes.set(fact.purpose, purpose);
    const value = points[fact.signal];
    const bucket = value > 0 ? purpose.gains : purpose.losses;
    bucket.set(fact.chain, Math.max(Math.abs(value), bucket.get(fact.chain) ?? 0));
  }
  let score = Math.min(3, revisits.size);
  purposes.forEach(({ gains, losses }) => {
    let balance = 0;
    gains.forEach(gain => { balance += gain; });
    losses.forEach(loss => { balance -= loss; });
    score += Math.max(0, balance);
  });
  return score;
}

/**
 * Replay a single media version in a single audience from validated facts.
 * Without a trusted rule epoch only current facts can qualify, at the entry threshold.
 * Remove invalid evidence from the input history before calling this function.
 */
export function replayWorkRecommendation(steps: readonly RecommendationStep[], trustedRuleStartOrder?: number) {
  const seen = new Map<string, string>();
  const facts = new Map<string, RecommendationFact>();
  let score = 0;
  let qualified = false;
  let replaying = false;
  let lastOrder: number | undefined;
  const ordered = [...steps].sort((a, b) => a.order - b.order);
  for (const step of ordered) {
    const entries = Object.entries(step.changes);
    const signature = JSON.stringify([step.order, entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([id, fact]) => [id, fact?.purpose, fact?.chain, fact?.signal])]);
    const previous = seen.get(step.id);
    if (previous === signature) continue;
    if (previous !== undefined) throw new Error('Conflicting work recommendation evidence');
    if (step.order === lastOrder) throw new Error('Ambiguous work recommendation order');
    lastOrder = step.order;
    seen.set(step.id, signature);
    if (trustedRuleStartOrder !== undefined && step.order >= trustedRuleStartOrder && !replaying) {
      qualified = total(facts) >= 12;
      replaying = true;
    }
    for (const [id, fact] of entries) {
      if (fact) facts.set(id, fact);
      else facts.delete(id);
    }
    if (replaying) {
      score = total(facts);
      qualified = score >= (qualified ? 8 : 12);
    }
  }
  if (!replaying) {
    score = total(facts);
    qualified = score >= 12;
  }
  return { rule: WORK_RECOMMENDATION_RULE, score, qualified };
}
