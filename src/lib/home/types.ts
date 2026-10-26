import type { ContentKey, ReactionState } from '@/lib/content-reactions/types';

export type HomeProject = { id: string; name: string; updated_at: string; thumbnailUrl: string | null };
export type HomeTemplate = { key: ContentKey; title: string; href: string; kind: 'definition' | 'workpage'; thumbnailUrl: string | null; state: ReactionState };
export type HomeTemplates = { items: HomeTemplate[]; nextCursor: string | null };
