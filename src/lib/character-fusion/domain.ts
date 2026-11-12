/** Shared UX20 JSON contracts. Allocation records execution facts, never persistent constraints. */
export type FusionFieldChange = { path: string[]; value: unknown; expected?: unknown };
export type FusionIntent = { requirements: Array<{ text: string; en?: string; sourceOpId?: string }> };
export type FusionSummaryMeta = { formatVersion: 1; stateVersion: number; throughOpId?: string; legacy?: boolean };
export type FusionIdentity = { nextDisplayNo: number; nextBatchNo: number };
/** Private terminal diagnostics, omitted from public workspace/operation DTOs. */
export type FusionProposalDiagnostic = { formatVersion: 1; step: number; code: string; reason: string; commands?: unknown[]; commandsOmitted?: true };
export type FusionGenerationPlan = {
  formatVersion: 1; scope: 'document' | 'batch'; count?: number; overlay?: FusionFieldChange[];
  onceMust?: Record<string, string[]>; diversity?: 'prefer' | 'strict'; targetRowIds?: string[];
};
/** Pending execution metadata in the same workspace; effective settings always reuse the engine overlay. */
export type FusionPreparation = { formatVersion: 1; batch?: FusionGenerationPlan;
  row?: { rowId: string; version: number; changes: FusionFieldChange[] } };
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
  settingsChanged: boolean; intentChanged: boolean; batches: FusionBatchReceipt[]; undoneOperationId?: string; preparationChanged?: boolean;
};
