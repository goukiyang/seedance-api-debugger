import type { ContentKey } from '@/lib/content-reactions/types';
import type { CutoutAsset, CutoutJob, CutoutSettings } from '@/lib/cutout/types';

export type ImageResultNextIntent = 'cutout' | 'video';
export type ImageResultNextSource = {
  label: string;
  originalUrl: string;
  fileName: string;
  width?: number;
  height?: number;
};
export type ImageResultNextReceipt = {
  receiptId: string;
  intent: ImageResultNextIntent;
  sourceKey: ContentKey;
  source: ImageResultNextSource;
  returnPath: string;
  destination: string;
  message: string;
  ready: boolean;
  workspaceTabId?: string;
};
export type CutoutImageHandoff = ImageResultNextReceipt & {
  stage: 'import-ready' | 'preparing' | 'awaiting-confirmation' | 'submitting' | 'accepted' | 'unknown' | 'not-submitted';
  asset: CutoutAsset | null;
  job: CutoutJob | null;
  settings?: CutoutSettings;
  autoStart: { allowed: boolean; message: string };
};
