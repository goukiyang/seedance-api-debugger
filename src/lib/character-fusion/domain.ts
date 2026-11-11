/** Shared UX20 JSON contracts. Allocation records execution facts, never persistent constraints. */
export type FusionFieldChange = { path: string[]; value: unknown; expected?: unknown };
export type FusionIntent = { requirements: Array<{ text: string; en?: string; sourceOpId?: string }> };
export type FusionSummaryMeta = { formatVersion: 1; stateVersion: number; throughOpId?: string; legacy?: boolean };
export type FusionIdentity = { nextDisplayNo: number; nextBatchNo: number };
export type FusionGenerationPlan = {
  formatVersion: 1; scope: 'document' | 'batch'; count?: number; overlay?: FusionFieldChange[];
  onceMust?: Record<string, string[]>; diversity?: 'prefer' | 'strict'; targetRowIds?: string[];
};
export type FusionAllocation = {
  formatVersion: 1; rows: Array<{ selections: Record<string, string[]> }>;
  diversity?: { availableSourceCount: number; repeatedSourceCount: number; relaxed: boolean };
};
export type FusionBatchReceipt = {
  formatVersion: 1; id: string; number: number; operationId: string; label: string; rowIds: string[];
  createdAt: string; plan?: FusionGenerationPlan; allocation?: FusionAllocation;
};
export type FusionEffects = {
  formatVersion: 1; addedIds: string[]; modifiedIds: string[]; removedIds: string[]; retainedIds: string[];
  settingsChanged: boolean; intentChanged: boolean; batches: FusionBatchReceipt[]; undoneOperationId?: string;
};
