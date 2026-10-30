export const STUDIO_TASK_SUMMARY = 'studio-task-summary-v1';
export type StudioTaskSummary = {
  sourceAvailable: boolean; contextAvailable: boolean; resolution: string | null;
  resolvedAspectRatio: string | null; imageSupplierName: string | null; imageChannelLabel: string | null;
  moduleContextVersion: string | null; moduleContextVersionState: string;
  primaryReference: { id: string; originalUrl: string | null; thumbnailUrl: string | null; width: number | null; height: number | null } | null;
};
type Detail = { snapshot?: Record<string, unknown>; prompt?: unknown; referenceIds?: unknown };

/** Only an already-authorized owner DTO may enter this projection. Shared pins stay output-only. */
export function projectStudioTaskSummary<T extends Detail>(task: T) {
  const { snapshot, prompt: _prompt, referenceIds: _references, ...rest } = task;
  const text = (value: unknown) => typeof value === 'string' ? value : null;
  const primary = Array.isArray(snapshot?.primaryReferenceImages) ? snapshot.primaryReferenceImages[0] : null;
  const summary: StudioTaskSummary = {
    sourceAvailable: snapshot?.sourceAvailable === true, contextAvailable: snapshot?.contextAvailable === true,
    resolution: text(snapshot?.resolution), resolvedAspectRatio: text(snapshot?.resolvedAspectRatio),
    imageSupplierName: text(snapshot?.imageSupplierName), imageChannelLabel: text(snapshot?.imageChannelLabel),
    moduleContextVersion: text(snapshot?.moduleContextVersion), moduleContextVersionState: text(snapshot?.moduleContextVersionState) || 'missing',
    primaryReference: primary && typeof primary.id === 'string' ? { id: primary.id,
      originalUrl: text(primary.originalUrl), thumbnailUrl: text(primary.thumbnailUrl),
      width: typeof primary.width === 'number' ? primary.width : null, height: typeof primary.height === 'number' ? primary.height : null } : null,
  };
  return { ...rest, prompt: '', referenceIds: [], summary, detailState: 'unloaded' as const };
}
