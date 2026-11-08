import type { CharacterLabDraft, CharacterLabPlan } from './types';

export function labPersonalFields(plan: CharacterLabPlan): Partial<CharacterLabDraft> {
  if (plan.operation?.startsWith('body-')) return { bodyDescription: plan.adjustment };
  if (plan.operation === 'refine-face') return { faceDescription: plan.adjustment };
  if (plan.operation === 'side' || plan.operation === 'refine-side') return { sideDescription: plan.adjustment };
  if (plan.operation) return {};
  return plan.kind === 'faces' ? { faceDescription: plan.context } : { context: plan.context, adjustment: plan.adjustment };
}

// Fill missing stage fields from their own frozen records, never from the old shared text.
export function labIndependentDraft(draft: CharacterLabDraft, plans: CharacterLabPlan[], views = draft.views): CharacterLabDraft {
  const own = plans.filter(plan => plan.sourceAssetId === draft.sourceAssetId);
  const faces = own.filter(plan => !plan.operation && plan.kind === 'faces');
  const bodies = own.filter(plan => plan.operation?.startsWith('body-'));
  const sides = own.filter(plan => plan.operation === 'side' && plan.mainFace?.planId === draft.mainFace?.planId && plan.mainFace?.cell === draft.mainFace?.cell);
  const face = faces.find(plan => plan.id === draft.facePlanId) || faces[0];
  const body = bodies.find(plan => plan.id === views?.['body-front']?.planId) || bodies[0];
  const side = sides.find(plan => plan.id === views?.side?.planId) || sides[0];
  return { ...draft, faceDescription: draft.faceDescription ?? face?.context ?? '',
    sideDescription: draft.sideDescription ?? side?.adjustment ?? '', bodyDescription: draft.bodyDescription ?? body?.adjustment ?? '' };
}
