import type { SharedStudioSharingCurrent } from './shared-types';

type ModuleProjection = {
  id: string; revision: number; sourcePresetId?: string | null; sourcePresetShared?: boolean | null;
  definitionSyncPending?: boolean;
  sharedLive?: { mode?: string; sourceRevision?: string | null } | null;
};

// A confirmed workspace/source revision is a floor for later full reads.
// Dependency tokens are opaque; their ordering belongs to the reader's scope.
export function receiveStudioModuleProjection<T extends ModuleProjection>(current: T, next: T): T {
  if (current.id !== next.id || next.revision < current.revision) return current;
  const before = current.sharedLive?.sourceRevision, after = next.sharedLive?.sourceRevision;
  if (current.sourcePresetId && current.sourcePresetId === next.sourcePresetId && before && after
    && Date.parse(after) < Date.parse(before)) return current;
  return next;
}

export function receiveStudioSharingCurrent<T extends ModuleProjection>(current: T, presetId: string,
  confirmed: SharedStudioSharingCurrent): T {
  if (current.sourcePresetId !== presetId) return current;
  const publisher = current.sharedLive?.mode === 'publisher';
  const revision = publisher && confirmed.moduleRevision !== null ? Math.max(current.revision, confirmed.moduleRevision) : current.revision;
  return { ...current, revision, sourcePresetShared: confirmed.isShared, definitionSyncPending: Boolean(current.sharedLive),
    ...(current.sharedLive ? { sharedLive: { ...current.sharedLive, sourceRevision: confirmed.sourceRevision,
      ...(publisher ? { moduleRevision: revision } : {}) } } : {}) };
}
