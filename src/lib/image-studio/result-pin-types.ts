export const STUDIO_RESULT_FEED = 'template-pins-v1' as const;
export type StudioPinState = { presetId: string | null; revision: number; assetIds: string[]; disabledReason?: string };
/** Deliberately not a StudioTask: no prompt, context, inputs, billing or private task id. */
export type SharedStudioPinnedImage = {
  id: string; assetId: string; pinnedAt: string; createdAt: string;
  owner: { name: string; avatar_url: string | null } | null;
  previewUrl: string; thumbnailUrl: string; width: number | null; height: number | null;
};
export type StudioResultFeedExtras = {
  protocol: typeof STUDIO_RESULT_FEED; viewerId: string; sharedPins: SharedStudioPinnedImage[];
  resultOrder: string[]; pinState: StudioPinState;
};
export type StudioPinMutation = {
  viewerId: string; moduleId: string; taskId: string; assetId: string; active: boolean;
  expectedRevision: number; requestId: string;
};
