import type { StudioCapabilitiesResponse, StudioRunStatus } from '@/lib/template-studio/types';

export const MULTIVIEW_ACTION_PURPOSE = 'multiview-action' as const;
export type MultiviewActionBinding = { runId: string; workId: string; revision: number; recipeHash: string; inputHash: string };
export type MultiviewActionParameters = {
  provider: 'seedance'; model: string; duration: number; resolution: '480p' | '720p' | '1080p'; ratio: '16:9' | '9:16' | '1:1';
  project_id: string; video_card_id: string | null; seed?: number; generate_audio?: boolean; return_last_frame?: boolean; watermark?: boolean;
};
export type MultiviewActionDraft = {
  id: string; workId: string; workRevision: number; revision: number; text: string;
  parameters: MultiviewActionParameters; updatedAt: string;
};
export type MultiviewActionTask = { taskId: string; status: string; error?: string | null; deliveryStatus: string | null; playUrl: string | null; downloadUrl: string | null; createdAt: string };
export type MultiviewActionRun = {
  id: string; draftId: string; draftRevision: number; requestId: string; inputText: string; mode: 'direct' | 'llm'; status: StudioRunStatus;
  text: string | null; error: string | null; llmModel: string | null; parameters: MultiviewActionParameters;
  binding: MultiviewActionBinding | null; attemptId?: string; createdAt: string; tasks: MultiviewActionTask[];
};
export type MultiviewActionCapabilities = StudioCapabilitiesResponse & {
  actionReady: boolean; actionReason: string | null;
  rules: { format: { configured: boolean; revision: number; canEdit: boolean }; sync: { configured: boolean; revision: number; canEdit: boolean } };
};
export type MultiviewActionState = { capabilities: MultiviewActionCapabilities; draft: MultiviewActionDraft | null; runs: MultiviewActionRun[]; nextCursor: string | null };
export type MultiviewActionContextKind = 'format' | 'sync';
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
export function parseMultiviewActionBinding(value: unknown): MultiviewActionBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as MultiviewActionBinding;
  if (Object.keys(data).sort().join(',') !== 'inputHash,recipeHash,revision,runId,workId' || !identifier(data.runId) || !identifier(data.workId)
    || !Number.isSafeInteger(data.revision) || data.revision < 1 || !/^[a-f0-9]{64}$/.test(data.recipeHash) || !/^[a-f0-9]{64}$/.test(data.inputHash)) return null;
  return { runId: data.runId, workId: data.workId, revision: data.revision, recipeHash: data.recipeHash, inputHash: data.inputHash };
}
