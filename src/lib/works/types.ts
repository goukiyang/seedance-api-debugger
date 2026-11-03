export const WORKS_PROTOCOL = 'works.v1' as const;
export type WorkMedium = 'image' | 'video';
export type WorkAudience = 'source' | 'team' | 'project' | 'private';
export type WorkSourceKind = 'image_task' | 'video_task' | 'multiview_work' | 'upload_asset';
export type WorkPersonal = { liked: boolean; favorited: boolean; hidden: boolean; version: number };
export type WorkProvenance = { tool: { label: string; href: string }; template: { label: string; href: string; version: string | null } | null };
export type WorkCard = {
  id: string; title: string; medium: WorkMedium; mediaVersion: string; revision: number;
  width: number | null; height: number | null; duration: number | null; completedAt: string;
  author: { id: string; name: string; avatarUrl: string | null };
  project: { id: string; name: string } | null;
  thumbnailUrl: string | null; previewUrl: string | null; detailPreviewUrl: string | null; downloadUrl: string | null;
  previewStatus: 'ready' | 'preparing' | 'unavailable';
  reuse: { assetId?: string; referenceImageId?: string } | null;
  sourceHref: string | null; audience: WorkAudience; canManage: boolean;
  discoverable: boolean; withdrawn: boolean; personal: WorkPersonal;
  likeCount: number; collectionIds: string[];
  provenance?: WorkProvenance;
};
export type WorkQuery = {
  q?: string; medium?: 'all' | WorkMedium; scope?: 'all' | 'mine' | 'favorites' | 'hidden' | 'managed';
  author?: string; project?: string; collection?: string;
};
export type WorkPage = {
  protocol: typeof WORKS_PROTOCOL; viewerId: string; items: WorkCard[];
  window: string; previousCursor: string | null; nextCursor: string | null;
  anchorId: string | null; anchorUnavailable: boolean;
};
export type WorkCollectionDTO = { id: string; name: string; revision: number; createdAt: string };
export type WorkCollectionPage = { viewerId: string; collections: WorkCollectionDTO[]; nextCursor: string | null };
export type WorkMutationIdentity = { viewerId: string; requestId: string };
export type WorkStateMutation = WorkMutationIdentity & {
  action: 'like' | 'favorite' | 'hide'; active: boolean;
  expectedVersion: number; expectedMediaVersion: string;
};
export type WorkLifecycleMutation = WorkMutationIdentity & {
  action: 'exclude' | 'restore-discovery' | 'withdraw' | 'restore-sharing';
  expectedRevision: number; expectedMediaVersion: string;
};
export type WorkOperationReceipt = { requestId: string; state: 'committed'; result: Record<string, unknown> };
export class WorkError extends Error {
  constructor(message: string, public status = 400, public code = 'WORKS_INVALID') { super(message); }
}
export const workAudienceLabels: Record<WorkAudience, string> = {
  source: '保留原有范围', team: '全体同事可看成品', project: '仅项目组', private: '仅本人',
};
