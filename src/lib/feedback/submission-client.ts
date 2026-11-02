export type PendingFeedback = {
  operationId: string;
  expectedUserId: string | null;
  content: string;
  imageUrls: string[];
  uploadedAssetIds: string[];
  uploadIds: string[];
  pageUrl: string;
  pathname: string;
};
export const feedbackPendingKey = (draftKey: string) => `${draftKey}:submission:v1`;
export function readPendingFeedback(draftKey: string): PendingFeedback | null {
  const raw = localStorage.getItem(feedbackPendingKey(draftKey));
  if (!raw) return null;
  const value = JSON.parse(raw) as PendingFeedback;
  if (!value || typeof value.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.operationId)
    || value.expectedUserId !== null && typeof value.expectedUserId !== 'string'
    || typeof value.content !== 'string' || typeof value.pageUrl !== 'string' || typeof value.pathname !== 'string'
    || ![value.imageUrls, value.uploadedAssetIds, value.uploadIds].every(items => Array.isArray(items) && items.every(item => typeof item === 'string'))) throw new Error('原提交记录无法读取，请保留原稿后联系管理员核对。');
  return value;
}
