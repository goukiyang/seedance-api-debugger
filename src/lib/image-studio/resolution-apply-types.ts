import type { ImageResolution } from '@/lib/image-generation/resolution';

export type ResolutionBucket = 'change' | 'unchanged' | 'reproduction' | 'dirty' | 'unsupported';
export type ResolutionPhase = 'preview' | 'defaultConfirmed' | 'applying' | 'partial' | 'complete' | 'paused' | 'cancelled' | 'restoring' | 'restored';
export type ResolutionEntry = {
  id: string; name: string; model: string | null; effectiveModel: string; resolution: string; revision: number;
  sourcePresetId: string | null; reproduceTaskId: string | null; bucket: ResolutionBucket;
  result?: 'applied' | 'conflict'; reason?: string; afterRevision?: number;
  restoreResult?: 'restored' | 'conflict'; restoreReason?: string; restoredRevision?: number;
};
export type ResolutionDelta = { id: string; beforeRevision: number; revision: number; resolution: string };
export type ResolutionOperation = {
  schemaVersion: 1; ownerId: string; requestId: string; resolution: ImageResolution; expectedRevision: number;
  settingsDigest: string; previewDigest: string; phase: ResolutionPhase; operationRevision: number;
  createdAt: number; expiresAt: number; updatedAt: number; globalRevision?: number;
  counts: Record<ResolutionBucket, number> & { total: number; applied: number; conflicts: number; restored: number; restoreConflicts: number };
  chunks: number; cursor: number; restoreCursor: number; nextBatch: number; nextRestoreBatch: number;
};
export type ResolutionReceipt = {
  operation: ResolutionOperation; entries: ResolutionEntry[]; nextCursor: number | null;
  deltas?: ResolutionDelta[]; settings?: unknown;
};
