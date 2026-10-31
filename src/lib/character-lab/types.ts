import type { ImageBillingView } from '@/lib/image-studio/billing-contract';

export type CharacterLabStage = 'faces' | 'selection' | 'result';
export type CharacterLabFace = { planId: string; cell: number };
export type CharacterLabDraft = {
  stage: CharacterLabStage;
  sourceAssetId: string | null;
  count: 4 | 9;
  diversity: number;
  context: string;
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
};
export type CharacterLabWorkspace = {
  id: string; name: string; revision: number; createdAt: string; updatedAt: string;
  draft: CharacterLabDraft;
  savedResults: Array<{ planId: string; name: string; savedAt: string }>;
};
export type CharacterLabPromptFields = {
  basePrompt: string; characterContext: string; faceVariables: string; styleConstraints: string; resultPrompt: string;
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
};
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
