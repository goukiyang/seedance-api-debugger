export const STUDIO_CURRENT_INPUT_PROTOCOL = 'studio-current-input-v1' as const;

export type StudioPrivateDraftReference = { revision: number; sourceRevision: string; requestId?: string };
export type StudioCurrentInputs = {
  protocol: typeof STUDIO_CURRENT_INPUT_PROTOCOL;
  privateDraft?: StudioPrivateDraftReference;
  restoredDefinition?: true;
};

// This marker opts new requests into per-use edits. Its absence preserves the
// accepted identity and interpretation of old requests and batch parents.
export function parseStudioCurrentInputs(value: unknown): StudioCurrentInputs | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本次生成设置无效，请刷新页面；输入保留');
  const input = value as Record<string, unknown>;
  if (input.protocol !== STUDIO_CURRENT_INPUT_PROTOCOL
    || Object.keys(input).some(key => !['protocol', 'privateDraft', 'restoredDefinition'].includes(key))
    || input.restoredDefinition !== undefined && input.restoredDefinition !== true) {
    throw new Error('本次生成设置版本无效，请刷新页面；输入保留');
  }
  let privateDraft: StudioPrivateDraftReference | undefined;
  if (input.privateDraft !== undefined) {
    const draft = input.privateDraft as Record<string, unknown>;
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)
      || Object.keys(draft).some(key => !['revision', 'sourceRevision', 'requestId'].includes(key))
      || !Number.isSafeInteger(draft.revision) || Number(draft.revision) < 1
      || typeof draft.sourceRevision !== 'string' || !draft.sourceRevision || draft.sourceRevision.length > 256
      || draft.requestId !== undefined && (typeof draft.requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(draft.requestId))) {
      throw new Error('本次上下文草稿尚未确认，请重新打开核对；输入保留');
    }
    privateDraft = { revision: Number(draft.revision), sourceRevision: draft.sourceRevision,
      ...(typeof draft.requestId === 'string' ? { requestId: draft.requestId } : {}) };
  }
  return { protocol: STUDIO_CURRENT_INPUT_PROTOCOL, ...(privateDraft ? { privateDraft } : {}),
    ...(input.restoredDefinition ? { restoredDefinition: true } : {}) };
}
