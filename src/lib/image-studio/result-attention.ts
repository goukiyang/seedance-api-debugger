import { studioOutputMismatchDisposition } from './dimension-mismatch';

export type StudioAttentionSnapshot = { viewerId: string; receiptRevision: number; unreadModuleIds: string[] };

export function studioResultVersion(task: { id: string; status: string; resultDisposition?: string | null; finishedAt?: string | Date | null; asset: { id?: string } | null }) {
  if (task.status !== 'succeeded' && !studioOutputMismatchDisposition(task.resultDisposition) || !task.asset?.id || !task.finishedAt) return null;
  const finished = new Date(task.finishedAt);
  return Number.isFinite(finished.getTime()) ? `${task.id}:${task.asset.id}:${finished.toISOString()}` : null;
}
