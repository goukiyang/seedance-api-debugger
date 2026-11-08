export const STUDIO_RESULT_FEED = 'template-pins-v1' as const;
export type StudioOwnPin = { taskId: string; assetId: string; moduleId: string; pinnedAt: string;
  availability: 'available' | 'restricted' | 'unavailable'; reason: string | null; thumbnailUrl: string | null };
export type StudioPinState = { presetId: string | null; revision: number; assetIds: string[]; disabledReason?: string;
  ownAssetIds?: string[]; ownPins?: StudioOwnPin[] };
/** Deliberately not a StudioTask: no prompt, context, inputs, billing or private task id. */
export type SharedStudioPinnedImage = {
  id: string; assetId: string; pinnedAt: string; createdAt: string;
  owner: { name: string; avatar_url: string | null } | null;
  previewUrl: string; thumbnailUrl: string; width: number | null; height: number | null;
};
export type StudioResultFeedExtras = {
  protocol: typeof STUDIO_RESULT_FEED; viewerId: string; sharedPins: SharedStudioPinnedImage[];
  resultOrder: string[]; pinState: StudioPinState;
  eligiblePinAssetIds?: string[];
  pinTaskReasons?: Record<string, string | null>;
  directoryVersion?: string;
};
export type StudioPinMutation = {
  viewerId: string; moduleId: string; taskId: string; assetId: string; active: boolean;
  expectedRevision: number; requestId: string; presetId?: string;
};
