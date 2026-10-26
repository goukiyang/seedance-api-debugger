import type { ReactionState, ContentKey } from '@/lib/content-reactions/types';
import type { ModuleCoverDTO } from './module-cover-types';
import type { StudioDeletionCapability } from './shared-types';

export type GalleryScope = 'all' | 'mine' | 'shared' | 'favorites';
export type GallerySort = 'created' | 'updated' | 'likes' | 'recent' | 'name' | 'directory';
export type GalleryAuthor = { known: boolean; key: string | null; displayName: string; avatarUrl: string | null };
export type GalleryNavigationItem = {
  key: string; id: string; title: string; name: string; groupName: string; mine: boolean; shared: boolean;
  navigationTarget: { moduleId?: string; presetId?: string }; presetId?: string;
  sourcePresetId?: string | null; sourcePresetShared?: boolean | null;
  objectKind?: 'publisher' | 'live' | 'legacy-copy' | 'local';
  author: GalleryAuthor; createdAt: string | null; updatedAt: string | null; available: boolean;
  reaction: ReactionState | null; coverEditable: boolean; deletion: StudioDeletionCapability;
};
export type GalleryItem = GalleryNavigationItem & {
  fixedCover: ModuleCoverDTO | null;
  cover?: { thumbnailUrl: string; resultUrl: string } | null;
  banner: { id: string; thumbnailUrl: string; originalUrl: string; width: number | null; height: number | null } | null;
  originalActions: { open: true; editCover: boolean; deletion: StudioDeletionCapability };
};
export type GalleryQuery = {
  query?: string; scope?: GalleryScope; authorKey?: string | null; sort?: GallerySort;
  page?: number; pageSize?: number; catalogRevision?: string;
  recentHints?: Record<string, number>; directoryOrder?: { groups?: string[]; entries?: string[] };
  navigationOnly?: boolean;
};
export type GalleryQueryResult = {
  items: GalleryItem[]; navigation: GalleryNavigationItem[]; matches: GalleryNavigationItem[];
  total: number; page: number; pageSize: number; catalogRevision: string;
  capabilities: { independentReactions: true };
  removedDefaultGroups: string[];
  deletedSourcePresetIds: string[];
};
export type GalleryReactionKey = Extract<ContentKey, `image_template:${string}` | `image_module:${string}`>;
