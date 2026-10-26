import type { AssetType } from '@/types';
import type { ContentKey } from '@/lib/content-reactions/types';
import type { GenerationOrigin } from './generation-origin';
import type { ComparisonImageDescriptor } from '@/lib/media/image-comparison-contract';

export function templateFilterId(input: unknown): string {
  return typeof input === 'string' && input.length <= 160 && /^(?:module-source:)?[a-zA-Z0-9_-]{1,100}$/.test(input) ? input : '';
}

export type PickerScope = 'mine' | 'project' | 'shared' | 'public';
export type PickerItem = {
  key: ContentKey;
  identity: string;
  id: string;
  referenceImageId?: string;
  assetId?: string;
  importUrl?: string;
  unavailableReason?: string;
  type: AssetType;
  // Display URLs must never be used as upload or processing inputs.
  previewUrl?: string;
  originalUrl: string;
  thumbnailUrl: string | null;
  fileName: string;
  width: number | null;
  height: number | null;
  fileSize?: number | null;
  duration: number | null;
  createdAt: string;
  source: 'uploaded' | 'generated' | 'other';
  generationOrigin?: GenerationOrigin;
  comparison?: ComparisonImageDescriptor;
  canRemoveFromLibrary?: boolean;
};
export type PickerAlbum = { id: string; name: string; scope: PickerScope; project: { id: string; name: string } | null; count: number };
export type PickerTemplate = { id: string; name: string; aliases?: string[] };
export type PickerResponse = { items: PickerItem[]; albums: PickerAlbum[]; templates?: PickerTemplate[]; total: number; page: number; hasMore: boolean; nextCursor?: string | null; notice?: string };
