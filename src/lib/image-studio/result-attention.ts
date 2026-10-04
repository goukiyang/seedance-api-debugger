export type StudioAttentionSnapshot = { viewerId: string; receiptRevision: number; unreadModuleIds: string[] };

export function studioResultVersion(task: { id: string; status: string; finishedAt?: string | Date | null; asset: { id?: string } | null }) {
  if (task.status !== 'succeeded' || !task.asset?.id || !task.finishedAt) return null;
  const finished = new Date(task.finishedAt);
  return Number.isFinite(finished.getTime()) ? `${task.id}:${task.asset.id}:${finished.toISOString()}` : null;
}
