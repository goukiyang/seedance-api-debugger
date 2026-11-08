import type { ImageBillingView } from '@/lib/image-studio/billing-contract';

export type CharacterLabStage = 'faces' | 'selection' | 'result';
export type CharacterLabFace = { planId: string; cell: number };
export const characterLabOperations = ['refine-face', 'side', 'refine-side', 'body-front', 'body-back', 'body-pair'] as const;
export type CharacterLabOperation = typeof characterLabOperations[number];
export type CharacterLabView = 'side' | 'body-front' | 'body-back';
export type CharacterLabReference = { planId: string; cell?: number };
export type CharacterLabViews = Partial<Record<CharacterLabView, CharacterLabReference>>;
export type CharacterLabComposition = { id: string; name: string; savedAt: string; layout?: string;
  sources?: { sourceAssetId: string; mainFace: CharacterLabFace; side: CharacterLabReference; front: CharacterLabReference; back: CharacterLabReference } };
export type CharacterLabPromptTarget = 'faces' | 'result' | CharacterLabOperation;

export function characterLabSlot(plan: Pick<CharacterLabPlan, 'operation' | 'kind'>) {
  if (plan.operation === 'body-pair') return 'body-pair';
  if (plan.operation === 'side' || plan.operation === 'refine-side') return 'side';
  if (plan.operation === 'body-front' || plan.operation === 'body-back') return plan.operation;
  return plan.kind === 'faces' ? 'faces' : 'legacy';
}

export function characterLabSlotsOverlap(first: Pick<CharacterLabPlan, 'operation' | 'kind'>, second: Pick<CharacterLabPlan, 'operation' | 'kind'>) {
  const a = characterLabSlot(first), b = characterLabSlot(second);
  return a === b || a === 'body-pair' && (b === 'body-front' || b === 'body-back')
    || b === 'body-pair' && (a === 'body-front' || a === 'body-back');
}
export function characterLabReferenceSlot(plan: Pick<CharacterLabPlan, 'operation' | 'kind'>, reference: CharacterLabReference) {
  if (plan.operation === 'body-pair') return reference.cell === 0 ? 'body-front' : reference.cell === 1 ? 'body-back' : 'invalid';
  return characterLabSlot(plan);
}

export function characterLabStrength(value: number) {
  return value <= 25 ? '小幅' : value <= 60 ? '中等' : '明显';
}

export function sameLabReference(first: CharacterLabReference | null | undefined, second: CharacterLabReference | null | undefined) {
  return Boolean(first && second && first.planId === second.planId && first.cell === second.cell);
}

export type CharacterLabDraft = {
  stage: CharacterLabStage;
  sourceAssetId: string | null;
  count: 4 | 9;
  diversity: number;
  context: string;
  faceDescription?: string;
  sideDescription?: string;
  bodyDescription?: string;
  model: string;
  channelId: string;
  quality: string;
  resolution: string;
  projectId: string | null;
  facePlanId: string | null;
  mainFace: CharacterLabFace | null;
  auxiliaryFaces: CharacterLabFace[];
  auxiliaryFeatures: string;
  resultPlanId: string | null;
  resultName: string;
  adjustment: string;
  adjustmentCell: number | null;
  views?: CharacterLabViews;
  settingsSource?: { planId: string; target: CharacterLabPromptTarget };
};
export type CharacterLabWorkspace = {
  id: string; name: string; revision: number; createdAt: string; updatedAt: string;
  draft: CharacterLabDraft;
  savedResults: Array<{ planId: string; name: string; savedAt: string }>;
  views?: CharacterLabViews;
  compositions?: CharacterLabComposition[];
};
export type CharacterLabPromptFields = {
  basePrompt: string; characterContext: string; faceVariables: string; styleConstraints: string; resultPrompt: string;
  sideStyleConstraints?: string;
  bodyStyleConstraints?: string;
  resultStyleConstraints?: string;
  refineFacePrompt?: string;
  sidePrompt?: string;
  refineSidePrompt?: string;
  bodyFrontPrompt?: string;
  bodyBackPrompt?: string;
  bodyPairPrompt?: string;
};
export type CharacterLabConfig = CharacterLabPromptFields & { revision: number; updatedAt: string | null };
export type CharacterLabPlan = {
  id: string; workspaceId: string; kind: 'faces' | 'result'; createdAt: string;
  sourceAssetId: string; count: 4 | 9; diversity: number; context: string;
  mainFace: CharacterLabFace | null; auxiliaryFaces: CharacterLabFace[]; auxiliaryFeatures: string;
  adjustment: string; adjustmentCell: number | null; previousResultPlanId: string | null;
  configRevision: number; prompt: string; model: string; channelId: string; quality: string;
  resolution: string; aspectRatio: '1:1' | '2:3'; settingsRevision: number;
  referenceIds: string[]; projectId: string | null;
  imageChannel?: { channelId: string; configRevision: string };
  operation?: CharacterLabOperation;
  // Historical single sides also carried count metadata; only explicit grids use it.
  outputLayout?: 'grid';
  input?: CharacterLabReference;
  slotScoped?: true;
  origin?: { planId: string; mode: 'current' | 'historical' };
  recipeProtocol?: 1;
  contextProtocol?: 1;
  frozenReferenceContext?: string;
};
export type CharacterLabRecipe = {
  plan: CharacterLabPlan;
  taskId: string | null;
  hasImage: boolean;
  state: string;
  instruction: string | null;
  completePrompt: string | null;
  personalText: string;
  references: Array<{ id: string; label: string; available: boolean; source?: CharacterLabReference }>;
};
export type CharacterLabRestoredSettings = { patch: Partial<CharacterLabDraft>; operation?: CharacterLabOperation; input?: CharacterLabReference; description: string };
export type CharacterLabTask = {
  id: string; status: string; error: string | null; billing: ImageBillingView | null;
  asset: { id: string; url: string; thumbnailUrl: string; width: number | null; height: number | null } | null;
  resultDisposition?: string | null;
};
export type CharacterLabBootstrap = {
  settings: { model: string; revision: number; imageChannels: unknown };
  config: CharacterLabConfig; configVersions: CharacterLabConfig[];
  workspaces: CharacterLabWorkspace[];
};
export type CharacterLabWorkspacePayload = {
  workspace: CharacterLabWorkspace; plans: CharacterLabPlan[];
  taskByRequestId: Record<string, CharacterLabTask | null>;
  submissionByRequestId: Record<string, 'prepared' | 'submitting' | 'accepted' | 'rejected'>;
  sourceAsset: { id: string; url: string; thumbnailUrl: string; fileName: string } | null;
};
export type CharacterLabQuote = {
  billingMode: 'fixed' | 'actual'; billingQuoteId: string | null; unitCredits: number;
  estimatedCredits: number; expiresAt: string; revision: unknown; pricingRevision?: string;
  imageChannel?: { channelId: string; configRevision: string };
};

export function characterLabMediaUrl(planId: string, cell?: number) {
  return `/api/character-lab/media?plan=${encodeURIComponent(planId)}${cell === undefined ? '' : `&cell=${cell}`}`;
}

export function characterLabIsGrid(plan: Pick<CharacterLabPlan, 'kind' | 'operation' | 'outputLayout'>) {
  return plan.outputLayout === 'grid' || plan.kind === 'faces';
}
export function characterLabCellCount(plan: Pick<CharacterLabPlan, 'kind' | 'operation' | 'outputLayout' | 'count'>) {
  return plan.operation === 'body-pair' ? 2 : characterLabIsGrid(plan) ? plan.count : plan.operation ? 1 : 4;
}
