import { candidateFrames, DEFAULT_MULTIVIEW_LAYOUT, validMultiviewLayout,
  type MultiviewInfo, type MultiviewLayout, type MultiviewSlot } from './multiview-contract';

export type MultiviewWorkRecipe = {
  schema: 1; sourceVersion: string; slots: MultiviewSlot[]; reserve: MultiviewSlot[];
  restoreOrder: string[]; layout: MultiviewLayout;
};
export type MultiviewWorkFileRole = 'thumbnail' | 'collage' | 'zip' | `frame-${string}`;
export type MultiviewWorkManifest = {
  schema: 1; sourceVersion: string; revision: number; recipeHash: string;
  width: number; height: number; frameCount: number;
  files: Array<{ role: MultiviewWorkFileRole; file: string; mime: 'image/png' | 'image/jpeg' | 'application/zip';
    bytes: number; sha256: string; width?: number; height?: number }>;
};
export type MultiviewWorkStatus = 'waiting_source' | 'queued' | 'rendering' | 'ready' | 'failed' | 'source_changed';
export type MultiviewWorkDto = {
  id: string; title: string; sourceTaskId: string; sourceVersion: string | null; projectId: string | null;
  projectTitle: string | null; videoCardId: string | null; parentWorkId: string | null;
  revision: number; draftRevision: number; recipe: MultiviewWorkRecipe | null; info: MultiviewInfo | null;
  status: MultiviewWorkStatus; removed: boolean; sourceState: 'current' | 'changed' | 'unavailable';
  ready: null | { revision: number; recipe: MultiviewWorkRecipe; width: number; height: number; frameCount: number;
    files: Array<{ role: MultiviewWorkFileRole; url: string; mime: string; bytes: number; width?: number; height?: number }> };
  lastError: string | null; createdAt: string; updatedAt: string;
};
export type MultiviewWorkReceipt = {
  state: 'committed'; mutationId: string; action: 'create' | 'save' | 'branch' | 'remove' | 'restore';
  workId: string; revision: number; draftRevision: number;
};
export type MultiviewWorkMutationResult = { receipt: MultiviewWorkReceipt; work: MultiviewWorkDto };
export type MultiviewWorkList = { works: MultiviewWorkDto[]; total: number; nextCursor: string | null; projects: Array<{ id: string; title: string }> };
export const isMultiviewWorkId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export const isMultiviewWorkFileRole = (value: unknown): value is MultiviewWorkFileRole => typeof value === 'string'
  && (/^(?:thumbnail|collage|zip)$/.test(value) || /^frame-[a-zA-Z0-9-]{1,80}$/.test(value));

export function parseMultiviewWorkRecipe(value: unknown, info: MultiviewInfo): MultiviewWorkRecipe | null {
  if (typeof value === 'string') { if (value.length > 20000) return null; try { value = JSON.parse(value); } catch { return null; } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as MultiviewWorkRecipe;
  const valid = (slots: MultiviewSlot[]) => Array.isArray(slots) && slots.length <= 16 && slots.every(slot => slot
    && /^[a-zA-Z0-9-]{1,80}$/.test(slot.id) && Number.isInteger(slot.frame) && slot.frame >= 0 && slot.frame < info.timestamps.length
    && typeof slot.name === 'string' && slot.name.length <= 40 && typeof slot.manual === 'boolean');
  if (data.schema !== 1 || data.sourceVersion !== info.sourceVersion || !/^[a-f0-9]{64}$/.test(data.sourceVersion)
    || ![3, 4, 8].includes(data.slots?.length) || !valid(data.slots) || !valid(data.reserve)
    || !validMultiviewLayout(data.layout)) return null;
  const all = [...data.slots, ...data.reserve];
  if (new Set(all.map(slot => slot.id)).size !== all.length) return null;
  const order = data.restoreOrder ?? [];
  if (!Array.isArray(order) || order.length > 32 || order.some(id => typeof id !== 'string' || !all.some(slot => slot.id === id))
    || new Set(order).size !== order.length) return null;
  const clean = (slot: MultiviewSlot): MultiviewSlot => ({ id: slot.id, frame: slot.frame, name: slot.name, manual: slot.manual });
  return { schema: 1, sourceVersion: data.sourceVersion, slots: data.slots.map(clean), reserve: data.reserve.map(clean),
    restoreOrder: [...order], layout: { columns: data.layout.columns, margin: data.layout.margin, gap: data.layout.gap, background: data.layout.background } };
}
export function defaultMultiviewWorkRecipe(info: MultiviewInfo): MultiviewWorkRecipe {
  return { schema: 1, sourceVersion: info.sourceVersion, slots: candidateFrames(info.timestamps.length, 8)
    .map((frame, index) => ({ id: `view-${index + 1}`, frame, name: '', manual: false })),
    reserve: [], restoreOrder: [], layout: { ...DEFAULT_MULTIVIEW_LAYOUT } };
}

/** Slot IDs identify controls/files, not different authored content. */
export function multiviewWorkRecipesEqual(left: MultiviewWorkRecipe, right: MultiviewWorkRecipe) {
  const content = (recipe: MultiviewWorkRecipe) => {
    const all = [...recipe.slots, ...recipe.reserve];
    return { sourceVersion: recipe.sourceVersion, slots: recipe.slots.map(({ frame, name, manual }) => ({ frame, name, manual })),
      reserve: recipe.reserve.map(({ frame, name, manual }) => ({ frame, name, manual })),
      restoreOrder: recipe.restoreOrder.map(id => all.findIndex(slot => slot.id === id)), layout: recipe.layout };
  };
  return JSON.stringify(content(left)) === JSON.stringify(content(right));
}

export function parseMultiviewWorkManifest(value: unknown, recipe: MultiviewWorkRecipe, revision: number, recipeHash: string): MultiviewWorkManifest | null {
  if (typeof value === 'string') { if (value.length > 30000) return null; try { value = JSON.parse(value); } catch { return null; } }
  if (!value || typeof value !== 'object') return null;
  const data = value as MultiviewWorkManifest;
  const roles = ['thumbnail', 'collage', 'zip', ...recipe.slots.map(slot => `frame-${slot.id}`)];
  if (data.schema !== 1 || data.sourceVersion !== recipe.sourceVersion || data.revision !== revision || data.recipeHash !== recipeHash
    || data.frameCount !== recipe.slots.length || !Number.isSafeInteger(data.width) || !Number.isSafeInteger(data.height)
    || data.width < 1 || data.height < 1 || data.width * data.height > 64000000 || !Array.isArray(data.files)
    || data.files.length !== roles.length || new Set(data.files.map(file => file.role)).size !== roles.length
    || new Set(data.files.map(file => file.file)).size !== roles.length
    || data.files.some(file => !roles.includes(file.role) || !isMultiviewWorkFileRole(file.role)
      || !/^[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|zip)$/.test(file.file) || !Number.isSafeInteger(file.bytes) || file.bytes < 1
      || !/^[a-f0-9]{64}$/.test(file.sha256) || (file.role === 'zip' ? file.mime !== 'application/zip'
        : file.role === 'thumbnail' ? !['image/png', 'image/jpeg'].includes(file.mime) : file.mime !== 'image/png')
      || file.role !== 'zip' && (!Number.isSafeInteger(file.width) || !Number.isSafeInteger(file.height) || file.width! < 1 || file.height! < 1))) return null;
  return { ...data, files: data.files.map(file => ({ ...file })) };
}
