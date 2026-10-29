type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// The executor freezes style references in group order. Never consult today's catalog here.
export function historicalStudioStyles(snapshot: RecordValue, taskId: string, viewer: { id: string; role: string }) {
  const groups = Array.isArray(snapshot.styleGroups) ? snapshot.styleGroups.filter(record) : [];
  const references = Array.isArray(snapshot.referenceImages) ? snapshot.referenceImages.filter(record).filter(item => item.referenceRole === 'style-fixed') : [];
  const countsValid = groups.every(group => Number.isSafeInteger(group.referenceCount) && Number(group.referenceCount) >= 0)
    && groups.reduce((sum, group) => sum + Number(group.referenceCount), 0) === references.length;
  let offset = 0;
  return groups.flatMap(group => {
    if (typeof group.id !== 'string' || typeof group.name !== 'string') return [];
    const count = Number.isSafeInteger(group.referenceCount) ? Number(group.referenceCount) : 0;
    const frozen = countsValid ? references.slice(offset, offset + count) : [];
    offset += count;
    const canReadContent = viewer.role === 'admin' || group.ownerId === viewer.id;
    const complete = canReadContent && countsValid && count > 0 && frozen.length === count
      && frozen.every(item => typeof item.id === 'string') && typeof group.note === 'string' && Number.isSafeInteger(group.revision);
    const refs = canReadContent ? frozen.flatMap(item => {
      if (typeof item.id !== 'string') return [];
      const url = `/api/image-studio/tasks/${encodeURIComponent(taskId)}/styles/${encodeURIComponent(group.id as string)}/assets/${encodeURIComponent(item.id)}`;
      return [{ id: item.id, note: typeof item.note === 'string' ? item.note : '', available: true,
        width: typeof item.width === 'number' ? item.width : null, height: typeof item.height === 'number' ? item.height : null,
        originalUrl: url, thumbnailUrl: `${url}?thumbnail=1`, ...(typeof item.hash === 'string' ? { hash: item.hash } : {}) }];
    }) : [];
    return [{ id: group.id, name: group.name, referenceCount: count, canManage: false as const, historical: true as const,
      sourceTaskId: taskId, canReadContent, canCopy: complete, contentState: !canReadContent ? 'restricted' as const : complete ? 'complete' as const : 'partial' as const,
      ...(Number.isSafeInteger(group.revision) ? { revision: Number(group.revision) } : {}),
      ...(canReadContent && typeof group.note === 'string' ? { note: group.note } : {}),
      ...(canReadContent ? { references: refs, coverAssetId: refs[0]?.id } : {}), coverUrl: refs[0]?.thumbnailUrl || null }];
  });
}
