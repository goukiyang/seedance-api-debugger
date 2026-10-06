export const CONTENT_TYPES = ['asset', 'video_task', 'reference_image', 'image_template', 'image_module', 'video_template', 'video_draft', 'legacy_template', 'prompt', 'seedance_asset'] as const;
export type ContentType = typeof CONTENT_TYPES[number];
export type ContentKey = `${ContentType}:${string}`;
export type ContentCategory = 'image' | 'video' | 'audio' | 'template' | 'prompt';
export type ReactionAction = 'like' | 'favorite';

export type ReactionState = {
  key: ContentKey;
  // Keep legacy flags distinct for private undo and cached clients; UI active = either flag.
  liked: boolean;
  favorited: boolean;
  // Existing public likes only; private favorites must never be added here.
  likeCount: number | null;
  version: number;
  available: boolean;
};

export type ContentSummary = {
  key: ContentKey;
  category: ContentCategory;
  title: string;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  downloadUrl: string | null;
  href: string;
  actionLabel: string;
  versionLabel: string | null;
  owner: { name: string; avatar_url: string | null } | null;
  reuse?: { assetId?: string; referenceImageId?: string };
};

export type ReactionListItem = {
  key: ContentKey;
  category: ContentCategory;
  markedAt: string;
  state: ReactionState;
  content: ContentSummary | null;
};

export type ReactionListResponse = {
  items: ReactionListItem[];
  total: number;
  counts: Record<ContentCategory | 'all', number>;
  nextCursor: string | null;
};

export type ReactionMutation = {
  key: ContentKey;
  action: ReactionAction;
  active: boolean;
  expectedVersion: number;
  requestId: string;
};
