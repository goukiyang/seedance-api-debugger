import type { AssetType } from '@/types';
import type { ContentKey } from '@/lib/content-reactions/types';

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
  originalUrl: string;
  thumbnailUrl: string | null;
  fileName: string;
  width: number | null;
  height: number | null;
  fileSize?: number | null;
  duration: number | null;
  createdAt: string;
  source: 'uploaded' | 'generated' | 'other';
  canRemoveFromLibrary?: boolean;
};
export type PickerAlbum = { id: string; name: string; scope: PickerScope; project: { id: string; name: string } | null; count: number };
export type PickerResponse = { items: PickerItem[]; albums: PickerAlbum[]; total: number; page: number; hasMore: boolean; notice?: string };
