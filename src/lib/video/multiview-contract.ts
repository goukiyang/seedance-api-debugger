export type MultiviewInfo = {
  taskId: string;
  sourceVersion: string;
  width: number;
  height: number;
  duration: number;
  timestamps: number[];
};
export type MultiviewSlot = { id: string; frame: number; name: string; manual: boolean };
export type MultiviewLayout = { columns: number; margin: number; gap: number; background: string };
export type MultiviewDraft = {
  schema: 1;
  sourceVersion: string;
  slots: MultiviewSlot[];
  reserve: MultiviewSlot[];
  layout: MultiviewLayout;
  editing: string | null;
  editorFrame?: number;
};
export const DEFAULT_MULTIVIEW_LAYOUT: MultiviewLayout = { columns: 4, margin: 12, gap: 12, background: '#ffffff' };
export function candidateFrames(frameCount: number, count: number) {
  return Array.from({ length: count }, (_, i) => Math.min(frameCount - 1, Math.floor((i + 0.3) * frameCount / count)));
}
export function multiviewDimensions(info: Pick<MultiviewInfo, 'width' | 'height'>, count: number, layout: MultiviewLayout) {
  const columns = Math.min(count, layout.columns);
  const rows = Math.ceil(count / columns);
  return { width: columns * info.width + Math.max(0, columns - 1) * layout.gap + layout.margin * 2,
    height: rows * info.height + Math.max(0, rows - 1) * layout.gap + layout.margin * 2 };
}
export function validMultiviewLayout(input: unknown): input is MultiviewLayout {
  if (!input || typeof input !== 'object') return false;
  const value = input as MultiviewLayout;
  return [1, 2, 3, 4, 8].includes(value.columns)
    && [value.margin, value.gap].every(n => Number.isInteger(n) && n >= 0 && n <= 128)
    && /^#[a-f0-9]{6}$/i.test(value.background);
}
export function parseMultiviewDraft(raw: string | null, info: MultiviewInfo): MultiviewDraft | null {
  if (!raw || raw.length > 20000) return null;
  try {
    const data = JSON.parse(raw) as MultiviewDraft;
    const valid = (slots: MultiviewSlot[]) => Array.isArray(slots) && slots.length <= 16 && slots.every(slot => slot
      && /^[a-z0-9-]{1,80}$/i.test(slot.id) && Number.isInteger(slot.frame) && slot.frame >= 0 && slot.frame < info.timestamps.length
      && typeof slot.name === 'string' && slot.name.length <= 40 && typeof slot.manual === 'boolean');
    if (data.schema !== 1 || data.sourceVersion !== info.sourceVersion || !valid(data.slots) || !valid(data.reserve)
      || ![3, 4, 8].includes(data.slots.length) || !validMultiviewLayout(data.layout)) return null;
    if (new Set([...data.slots, ...data.reserve].map(slot => slot.id)).size !== data.slots.length + data.reserve.length) return null;
    return { ...data, editing: data.slots.some(slot => slot.id === data.editing) ? data.editing : null,
      editorFrame: Number.isInteger(data.editorFrame) && data.editorFrame! >= 0 && data.editorFrame! < info.timestamps.length ? data.editorFrame : undefined };
  } catch { return null; }
}
