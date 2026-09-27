import type { AnimationEntry, AnimationFileInfo, AnimationPose, AnimationSequence } from '@/lib/animation/types';

export type EditableEntryPatch = Partial<Pick<AnimationEntry, 'action' | 'pose_id' | 'translate_x' | 'translate_y'>>;
export type PixelLogicalGeometry = { logical_width: number; logical_height: number; pixels_per_unit: number };
type PixelLogicalGeometryInput = Pick<AnimationPose, 'logical_width' | 'logical_height' | 'pixels_per_unit'>;
export type PendingMutation = { payload: string; mutationId: string };
export type DocumentRequestContext = { documentId: string; epoch: number };

export function advanceDocumentRequestContext(current: DocumentRequestContext, documentId: string): DocumentRequestContext {
  return { documentId, epoch: current.epoch + 1 };
}

export function runIfDocumentRequestCurrent<T>(
  request: DocumentRequestContext,
  current: DocumentRequestContext,
  effect: () => T,
): T | undefined {
  if (request.documentId !== current.documentId || request.epoch !== current.epoch) return undefined;
  return effect();
}

export function documentRequestStateValue<T>(
  request: DocumentRequestContext,
  current: DocumentRequestContext,
  previous: T,
  next: T | ((previous: T) => T),
): T {
  if (request.documentId !== current.documentId || request.epoch !== current.epoch) return previous;
  return typeof next === 'function' ? (next as (previous: T) => T)(previous) : next;
}

export function sanitizeAnimationWorkbenchReturnTo(value: string | null | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const target = new URL(value, 'https://animation-workbench.invalid');
    if (target.origin !== 'https://animation-workbench.invalid') return null;
    const isAssetsPage = target.pathname === '/assets';
    const isProjectPage = /^\/projects\/[A-Za-z0-9_-]+$/.test(target.pathname);
    if (!isAssetsPage && !isProjectPage) return null;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch { return null; }
}

export function animationWorkbenchHref({
  documentId,
  projectId,
  returnTo,
}: {
  documentId?: string | null;
  projectId?: string | null;
  returnTo?: string | null;
}) {
  const params = new URLSearchParams();
  if (documentId) params.set('document_id', documentId);
  if (projectId) params.set('project_id', projectId);
  const safeReturnTo = sanitizeAnimationWorkbenchReturnTo(returnTo);
  if (safeReturnTo) params.set('return_to', safeReturnTo);
  const query = params.toString();
  return `/tools/animation-workbench${query ? `?${query}` : ''}`;
}

export function stableMutationId(
  pending: Map<string, PendingMutation>,
  scope: string,
  payload: string,
  createId: () => string,
) {
  const existing = pending.get(scope);
  if (existing?.payload === payload) return existing.mutationId;
  const mutationId = createId();
  pending.set(scope, { payload, mutationId });
  return mutationId;
}

export function clearMutationIfCurrent(pending: Map<string, PendingMutation>, scope: string, mutationId: string) {
  if (pending.get(scope)?.mutationId === mutationId) pending.delete(scope);
}

function positiveInteger(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function totalTicks(entries: AnimationEntry[], source: 'current' | 'original' = 'current') {
  return entries.reduce((sum, entry) => sum + positiveInteger(
    source === 'original' ? entry.original_hold_ticks : entry.hold_ticks,
  ), 0);
}

export function previewDelayMs(holdTicks: number, previewFps: number) {
  if (!Number.isFinite(previewFps) || previewFps <= 0) return 100;
  return Math.max(1, positiveInteger(holdTicks) * 1000 / previewFps);
}

export function entryIndexAtTick(entries: AnimationEntry[], tick: number, source: 'current' | 'original' = 'current') {
  if (entries.length === 0) return -1;
  const total = totalTicks(entries, source);
  const target = Math.max(0, Math.min(Math.floor(tick), Math.max(0, total - 1)));
  let cursor = 0;
  for (let index = 0; index < entries.length; index += 1) {
    cursor += positiveInteger(source === 'original' ? entries[index].original_hold_ticks : entries[index].hold_ticks);
    if (target < cursor) return index;
  }
  return entries.length - 1;
}

export function timingSummary(sequence: AnimationSequence) {
  const ticks = totalTicks(sequence.entries);
  const fps = Number.isFinite(sequence.preview_fps) && sequence.preview_fps > 0 ? sequence.preview_fps : null;
  const tickRate = sequence.tick_rate;
  const verified = sequence.tick_rate_verified && Number.isFinite(tickRate) && Number(tickRate) > 0;
  const gameDuration = verified
    ? `按已登记 tick 率计算 ${(ticks / Number(tickRate)).toFixed(2)} 秒，游戏仍未验证`
    : '游戏 tick 未验证，不显示真实秒数';
  return `${ticks} ticks · 预览 ${fps ?? '未知'} fps · ${gameDuration}`;
}

export function isPoseAdapted(pose: AnimationPose) {
  return resolvePixelLogicalGeometry(pose.width, pose.height, pose) !== null;
}

export function resolvePixelLogicalGeometry(
  pixelWidth: number | null | undefined,
  pixelHeight: number | null | undefined,
  geometry: PixelLogicalGeometryInput | null | undefined,
): PixelLogicalGeometry | null {
  if (!geometry || !Number.isFinite(pixelWidth) || !Number.isFinite(pixelHeight)
    || !Number.isFinite(geometry.logical_width) || !Number.isFinite(geometry.logical_height)
    || !Number.isFinite(geometry.pixels_per_unit)) return null;
  const logicalWidth = Number(geometry.logical_width);
  const logicalHeight = Number(geometry.logical_height);
  const pixelsPerUnit = Number(geometry.pixels_per_unit);
  if (pixelWidth! <= 0 || pixelHeight! <= 0 || logicalWidth <= 0 || logicalHeight <= 0 || pixelsPerUnit <= 0) return null;
  const tolerance = Math.max(1e-6, pixelsPerUnit * 1e-6);
  if (Math.abs(pixelWidth! / logicalWidth - pixelsPerUnit) > tolerance
    || Math.abs(pixelHeight! / logicalHeight - pixelsPerUnit) > tolerance) return null;
  return { logical_width: logicalWidth, logical_height: logicalHeight, pixels_per_unit: pixelsPerUnit };
}

export function resolveReferenceGeometry(
  entry: Pick<AnimationEntry, 'reference_file_id' | 'reference_geometry'>,
  file: Pick<AnimationFileInfo, 'id' | 'width' | 'height'> | undefined,
): { geometry: PixelLogicalGeometry; source: string } | null {
  const reference = entry.reference_geometry;
  if (!entry.reference_file_id || !file || file.id !== entry.reference_file_id
    || !reference || typeof reference.source !== 'string' || !reference.source.trim()) return null;
  const geometry = resolvePixelLogicalGeometry(file.width, file.height, reference);
  return geometry ? { geometry, source: reference.source.trim() } : null;
}

export function updateSequenceEntry(sequence: AnimationSequence, entryId: string, patch: EditableEntryPatch): AnimationSequence {
  const entry = sequence.entries.find(candidate => candidate.id === entryId);
  if (!entry) throw new Error('找不到要修改的动画条目');
  if (entry.locked) throw new Error('该条目已锁定，请先解锁再修改');

  const requestedHold = (patch as EditableEntryPatch & { hold_ticks?: unknown }).hold_ticks;
  if (requestedHold !== undefined && requestedHold !== entry.original_hold_ticks) {
    throw new Error('导入的 hold 只读，不能偏离原始 ticks');
  }
  const rawPatch = patch as Record<string, unknown>;
  if ('reference_file_id' in rawPatch && rawPatch.reference_file_id !== entry.reference_file_id) {
    throw new Error('原作文件属于导入基线，不能修改');
  }
  if ('reference_geometry' in rawPatch) {
    const requested = rawPatch.reference_geometry as AnimationEntry['reference_geometry'];
    const baseline = entry.reference_geometry;
    if (!requested || !baseline || requested.logical_width !== baseline.logical_width
      || requested.logical_height !== baseline.logical_height || requested.pixels_per_unit !== baseline.pixels_per_unit
      || requested.source !== baseline.source) {
      throw new Error('原作映射属于导入基线，不能修改');
    }
  }
  if (patch.translate_x !== undefined && !Number.isFinite(patch.translate_x)) throw new Error('横向平移值无效');
  if (patch.translate_y !== undefined && !Number.isFinite(patch.translate_y)) throw new Error('纵向平移值无效');

  return {
    ...sequence,
    entries: sequence.entries.map(candidate => candidate.id === entryId
      ? { ...candidate, ...patch, original_hold_ticks: candidate.original_hold_ticks }
      : candidate),
  };
}

export function setEntryLocked(sequence: AnimationSequence, entryId: string, locked: boolean): AnimationSequence {
  if (!sequence.entries.some(entry => entry.id === entryId)) throw new Error('找不到要锁定的动画条目');
  return { ...sequence, entries: sequence.entries.map(entry => entry.id === entryId ? { ...entry, locked } : entry) };
}

export function assignPoseToEntry(
  sequence: AnimationSequence,
  entryId: string,
  pose: AnimationPose,
  options: { deriveId?: boolean; createId?: () => string } = {},
): AnimationSequence {
  if (!isPoseAdapted(pose)) throw new Error('请先填写 pose 的逻辑画布尺寸和像素倍率');
  const existing = sequence.poses.find(item => item.id === pose.id);
  const changedSharedPose = Boolean(existing && JSON.stringify(existing) !== JSON.stringify(pose));
  const deriveId = options.deriveId || changedSharedPose;
  let assignedPose = pose;
  if (deriveId) {
    let nextId = options.createId?.();
    if (!nextId) {
      let suffix = 1;
      do { nextId = `${pose.id}:derived:${suffix}`; suffix += 1; }
      while (sequence.poses.some(item => item.id === nextId));
    }
    if (sequence.poses.some(item => item.id === nextId)) throw new Error('新 pose 编号已存在，请重试');
    assignedPose = { ...pose, id: nextId };
  }
  const next = updateSequenceEntry(sequence, entryId, { pose_id: assignedPose.id });
  const poses = next.poses.some(item => item.id === assignedPose.id)
    ? next.poses
    : [...next.poses, assignedPose];
  return { ...next, poses };
}

export function canChangeGlobalScale(sequence: AnimationSequence) {
  return !sequence.entries.some(entry => entry.locked);
}

export function updateGlobalScale(sequence: AnimationSequence, globalScale: number): AnimationSequence {
  if (!Number.isFinite(globalScale) || globalScale <= 0) throw new Error('全段缩放必须大于 0');
  if (!canChangeGlobalScale(sequence)) throw new Error('全段缩放会影响锁帧条目，请先解锁所有条目');
  return { ...sequence, global_scale: globalScale };
}

export function canExportValidated(sequence: AnimationSequence) {
  return sequence.tick_rate_verified
    && Number.isFinite(sequence.tick_rate)
    && Number(sequence.tick_rate) > 0;
}

export function reviewCapabilities(canEdit: boolean, canManage: boolean) {
  return {
    canSubmitPending: canEdit,
    canRecordOutcome: canManage,
    canRecordGameStatus: canManage,
    canSubmit: canEdit || canManage,
  };
}

export function canSaveAtRevision(baseRevision: number, currentRevision: number) {
  return Number.isInteger(baseRevision) && baseRevision === currentRevision;
}
