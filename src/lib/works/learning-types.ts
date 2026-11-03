import type { WorkCard } from './types';
export type WorkLearningKind = 'experience' | 'question' | 'answer';
export type WorkLearningEntry = {
  id: string; workId: string; mediaVersion: string; kind: WorkLearningKind; parentId: string | null;
  body: string; timeSeconds: number | null; revision: number; createdAt: string; updatedAt: string;
  author: { id: string; name: string; avatarUrl?: string | null }; canEdit: boolean;
  replyCount?: number;
};
export type WorkLearningPage = {
  viewerId: string; workId: string; mediaVersion: string;
  experience: WorkLearningEntry | null; items: WorkLearningEntry[]; nextCursor: string | null;
};
export type WorkDerivation = {
  id: string; sourceWorkId: string; derivedWorkId: string; sourceMediaVersion: string; derivedMediaVersion: string;
  revision: number; createdAt: string; canEdit: boolean;
};
export type WorkDerivationPage = {
  viewerId: string; workId: string; mediaVersion: string;
  items: Array<{ link: WorkDerivation; work: WorkCard }>; nextCursor: string | null;
  ownRevision?: number;
};
