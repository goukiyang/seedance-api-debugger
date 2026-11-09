export const WORK_RECOMMENDATION_RULE = 2;
export const WORK_COMMUNITY_RULE = 3;

const points = { revisit: 1, take: 6, input: 8, retained: 12, replaced: -6, superseded: -4 } as const;

type RecommendationFact = {
  purpose: string;
  chain: string;
  signal: keyof typeof points;
  actor?: string;
  ambiguous?: boolean;
  family?: string;
};

/** An atomic business transition. A null fact retracts the named evidence. */
export type RecommendationStep = {
  id: string;
  order: number; // Business order for this version and audience, independent of delivery order.
  at?: number;
  changes: Record<string, RecommendationFact | null>;
};

/** Community endorsement counts people, not the author's workflow or repeated takes. */
export function replayCommunityRecommendation(steps: readonly RecommendationStep[], authorId: string, now = Date.now()) {
  const facts = new Map<string, { fact: RecommendationFact; at: number }>();
  for (const step of [...steps].sort((a, b) => a.order - b.order)) {
    for (const [key, fact] of Object.entries(step.changes)) {
      if (fact) facts.set(key, { fact, at: step.at || 0 });
      else facts.delete(key);
    }
  }
  const uses = new Map<string, { actor: string; at: number; replaced: boolean }>();
  const since = now - 30 * 24 * 60 * 60 * 1000;
  for (const { fact, at } of Array.from(facts.values())) {
    if (!fact.actor || fact.actor === authorId) continue;
    if (!['input', 'retained', 'replaced', 'superseded'].includes(fact.signal)) continue;
    const key = JSON.stringify([fact.actor, fact.purpose]);
    const use = uses.get(key) || { actor: fact.actor, at: 0, replaced: false };
    if (fact.signal === 'replaced' || fact.signal === 'superseded') use.replaced = true;
    else if (at >= since && at <= now) use.at = Math.max(use.at, at);
    uses.set(key, use);
  }
  const supporters = new Set<string>();
  let lastUsedAt = 0;
  for (const use of Array.from(uses.values())) if (!use.replaced && use.at) {
    supporters.add(use.actor); lastUsedAt = Math.max(lastUsedAt, use.at);
  }
  return { rule: WORK_COMMUNITY_RULE, score: supporters.size, qualified: supporters.size > 0, lastUsedAt };
}

function total(facts: ReadonlyMap<string, RecommendationFact>) {
  const purposes = new Map<string, { actor?: string; ambiguous?: boolean; family?: string; gains: Map<string, number>; losses: Map<string, number> }>();
  const revisits = new Set<string>();
  for (const fact of Array.from(facts.values())) {
    if (fact.signal === 'revisit') {
      revisits.add(fact.chain);
      continue;
    }
    const purpose = purposes.get(fact.purpose) ?? { actor: fact.actor, ambiguous: fact.ambiguous, family: fact.family, gains: new Map<string, number>(), losses: new Map<string, number>() };
    purposes.set(fact.purpose, purpose);
    const value = points[fact.signal];
    const bucket = value > 0 ? purpose.gains : purpose.losses;
    bucket.set(fact.chain, Math.max(Math.abs(value), bucket.get(fact.chain) ?? 0));
  }
  let score = Math.min(3, revisits.size);
  const actors = new Map<string, { ambiguous: number; families: Map<string, { known: number; ambiguous: number }> }>();
  purposes.forEach(({ gains, losses, actor, ambiguous, family }) => {
    let balance = 0;
    gains.forEach(gain => { balance += gain; });
    losses.forEach(loss => { balance -= loss; });
    if (!actor) { score += Math.max(0, balance); return; }
    const settled = actors.get(actor) || { ambiguous: 0, families: new Map<string, { known: number; ambiguous: number }>() };
    if (ambiguous && !family) settled.ambiguous += Math.max(0, balance);
    else {
      const project = settled.families.get(family || '') || { known: 0, ambiguous: 0 };
      if (ambiguous) project.ambiguous += Math.max(0, balance);
      else project.known += Math.max(0, balance);
      settled.families.set(family || '', project);
    }
    actors.set(actor, settled);
  });
  // Unknown purpose can overlap a known goal. It cannot add another independent use.
  actors.forEach(actor => {
    let known = 0;
    actor.families.forEach(project => { known += Math.max(project.known, project.ambiguous); });
    score += Math.max(known, actor.ambiguous);
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
      .map(([id, fact]) => [id, fact?.purpose, fact?.chain, fact?.signal, fact?.actor, fact?.ambiguous, fact?.family])]);
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
