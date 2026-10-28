import { candidateFrames, DEFAULT_MULTIVIEW_LAYOUT, validMultiviewLayout, multiviewDimensions,
  type MultiviewInfo, type MultiviewLayout, type MultiviewSlot } from './multiview-contract';

import { clampReferencePlacement, validReferenceColor, validReferenceRect, type ReferencePanel, type ReferencePlacement, type ReferenceOutput, type ReferenceDivider, type ReferenceForeground } from './multiview-reference-layout';

export const MULTIVIEW_SAVE_PROTOCOL = 'explicit-v2';
export type MultiviewSourceAccess = { kind: 'work'; id: string } | { kind: 'share'; id: string };

export type MultiviewSelectionRecipe = {
  schema: 1 | 2; sourceVersion: string; slots: MultiviewSlot[]; reserve: MultiviewSlot[];
  restoreOrder: string[]; layout: MultiviewLayout;
};
export type MultiviewReferenceRecipe = Omit<MultiviewSelectionRecipe, 'schema'> & {
  schema: 3; kind: 'reference-collage'; output: ReferenceOutput; panels: ReferencePanel[]; placements: ReferencePlacement[];
  divider: ReferenceDivider; foregrounds: ReferenceForeground[];
};
export type MultiviewWorkRecipe = MultiviewSelectionRecipe | MultiviewReferenceRecipe;
export const isMultiviewReferenceRecipe = (recipe: MultiviewWorkRecipe | null | undefined): recipe is MultiviewReferenceRecipe => recipe?.schema === 3;
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
  sourceId?: string | null; saveState?: 'legacy' | 'intent' | 'saved';
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
export type MultiviewWorkList = { works: MultiviewWorkDto[]; total: number; nextCursor: string | null; projects: Array<{ id: string; title: string }>; preferredWorkId?: string | null };
export const isMultiviewWorkId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export const isMultiviewWorkFileRole = (value: unknown): value is MultiviewWorkFileRole => typeof value === 'string'
  && (/^(?:thumbnail|collage|zip)$/.test(value) || /^frame-[a-zA-Z0-9-]{1,80}$/.test(value));

export function parseMultiviewWorkRecipe(value: unknown, info: MultiviewInfo): MultiviewWorkRecipe | null {
  if (typeof value === 'string') { if (value.length > 20000) return null; try { value = JSON.parse(value); } catch { return null; } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as MultiviewWorkRecipe;
  if (data.schema === 3) return parseMultiviewReferenceRecipe(data, info);
  const valid = (slots: MultiviewSlot[]) => Array.isArray(slots) && slots.length <= 16 && slots.every(slot => slot
    && /^[a-zA-Z0-9-]{1,80}$/.test(slot.id) && Number.isInteger(slot.frame) && slot.frame >= 0 && slot.frame < info.timestamps.length
    && typeof slot.name === 'string' && slot.name.length <= 40 && typeof slot.manual === 'boolean'
    && (slot.locked === undefined || typeof slot.locked === 'boolean'));
  if (![1, 2].includes(data.schema) || data.sourceVersion !== info.sourceVersion || !/^[a-f0-9]{64}$/.test(data.sourceVersion)
    || ![3, 4, 8].includes(data.slots?.length) || !valid(data.slots) || !valid(data.reserve)
    || !validMultiviewLayout(data.layout)) return null;
  const all = [...data.slots, ...data.reserve];
  if (new Set(all.map(slot => slot.id)).size !== all.length) return null;
  const order = data.restoreOrder ?? [];
  if (!Array.isArray(order) || order.length > 32 || order.some(id => typeof id !== 'string' || !all.some(slot => slot.id === id))
    || new Set(order).size !== order.length) return null;
  const clean = (slot: MultiviewSlot): MultiviewSlot => ({ id: slot.id, frame: slot.frame, name: slot.name, manual: slot.manual,
    ...(data.schema === 2 || slot.locked !== undefined ? { locked: slot.locked === true } : {}) });
  return { schema: data.schema, sourceVersion: data.sourceVersion, slots: data.slots.map(clean), reserve: data.reserve.map(clean),
    restoreOrder: [...order], layout: { columns: data.layout.columns, margin: data.layout.margin, gap: data.layout.gap, background: data.layout.background } };
}
export function defaultMultiviewWorkRecipe(info: MultiviewInfo): MultiviewWorkRecipe {
  return { schema: 1, sourceVersion: info.sourceVersion, slots: candidateFrames(info.timestamps.length, 8)
    .map((frame, index) => ({ id: `view-${index + 1}`, frame, name: '', manual: false })),
    reserve: [], restoreOrder: [], layout: { ...DEFAULT_MULTIVIEW_LAYOUT } };
}

/** Slot IDs identify controls/files, not different authored content. */
export function multiviewWorkRecipesEqual(left: MultiviewWorkRecipe, right: MultiviewWorkRecipe) {
  return multiviewWorkContentSignature(left) === multiviewWorkContentSignature(right);
}
export function multiviewWorkContentSignature(recipe: MultiviewWorkRecipe | null, title = '') {
  const content = (recipe: MultiviewWorkRecipe) => {
    const all = [...recipe.slots, ...recipe.reserve];
    return { sourceVersion: recipe.sourceVersion, slots: recipe.slots.map(({ frame, name, manual, locked }) => ({ frame, name, manual, locked: locked === true })),
      reserve: recipe.reserve.map(({ frame, name, manual, locked }) => ({ frame, name, manual, locked: locked === true })),
      restoreOrder: recipe.restoreOrder.map(id => all.findIndex(slot => slot.id === id)), layout: recipe.layout };
  };
  return JSON.stringify([recipe ? recipe.schema === 3 ? { ...content(recipe), kind: recipe.kind, output: recipe.output, panels: recipe.panels, placements: recipe.placements, divider: recipe.divider, foregrounds: recipe.foregrounds } : content(recipe) : null, title]);
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

/** Strict schema split; a reference recipe is never coerced into the old eight-frame editor. */
export function parseMultiviewReferenceRecipe(data: MultiviewReferenceRecipe, info: MultiviewInfo): MultiviewReferenceRecipe | null {
  if (data.kind !== 'reference-collage' || data.sourceVersion !== info.sourceVersion || !/^[a-f0-9]{64}$/.test(data.sourceVersion)
    || !Array.isArray(data.slots) || ![2, 3, 4].includes(data.slots.length) || !Array.isArray(data.reserve) || data.reserve.length
    || !Array.isArray(data.restoreOrder) || data.restoreOrder.length || !validMultiviewLayout(data.layout)
    || data.slots.some(slot => !slot || !/^[a-zA-Z0-9-]{1,80}$/.test(slot.id) || !Number.isInteger(slot.frame)
      || slot.frame < 0 || slot.frame >= info.timestamps.length || typeof slot.name !== 'string' || slot.name.length > 40
      || typeof slot.manual !== 'boolean' || slot.locked !== undefined && typeof slot.locked !== 'boolean')
    || new Set(data.slots.map(slot => slot.id)).size !== data.slots.length) return null;
  const output = data.output;
  if (!output || !Number.isSafeInteger(output.width) || !Number.isSafeInteger(output.height) || output.width < 64 || output.height < 64
    || output.width > 16384 || output.height > 16384 || output.width * output.height > 64000000 || !validReferenceColor(output.background)) return null;
  if (!Array.isArray(data.panels) || !Array.isArray(data.placements) || data.panels.length !== data.slots.length || data.placements.length !== data.slots.length
    || data.panels.some(panel => !panel || typeof panel !== 'object') || data.placements.some(placement => !placement || typeof placement !== 'object')
    || new Set(data.panels.map(panel => panel.slotId)).size !== data.slots.length || new Set(data.placements.map(placement => placement.slotId)).size !== data.slots.length) return null;
  const panels = data.panels.map(panel => ({ slotId: panel.slotId, x: panel.x, y: panel.y, width: panel.width, height: panel.height }));
  if (panels.some(panel => !data.slots.some(slot => slot.id === panel.slotId) || !validReferenceRect(panel) || Math.round((panel.x + panel.width) * output.width) <= Math.round(panel.x * output.width)
    || Math.round((panel.y + panel.height) * output.height) <= Math.round(panel.y * output.height))) return null;
  // Panels cover one canvas exactly, without overlaps. Closing the divider does not merge shots.
  if (Math.abs(panels.reduce((sum, panel) => sum + panel.width * panel.height, 0) - 1) > .000001) return null;
  for (let i = 0; i < panels.length; i++) for (let j = i + 1; j < panels.length; j++) {
    if (Math.min(panels[i].x + panels[i].width, panels[j].x + panels[j].width) - Math.max(panels[i].x, panels[j].x) > .000001
      && Math.min(panels[i].y + panels[i].height, panels[j].y + panels[j].height) - Math.max(panels[i].y, panels[j].y) > .000001) return null;
  }
  const placements: ReferencePlacement[] = [];
  for (const placement of data.placements) {
    const panel = panels.find(item => item.slotId === placement.slotId);
    if (!panel || !validReferenceRect(placement) || !Number.isSafeInteger(placement.z) || placement.z < 0 || placement.z > 3
      || Math.round((placement.x + placement.width) * output.width) <= Math.round(placement.x * output.width)
      || Math.round((placement.y + placement.height) * output.height) <= Math.round(placement.y * output.height)) return null;
    const clean = clampReferencePlacement(placement, panel, info, output);
    if (['x', 'y', 'width', 'height'].some(key => Math.abs(clean[key as keyof ReferenceRectLike] - placement[key as keyof ReferenceRectLike]) > .00001)) return null;
    placements.push(clean);
  }
  const divider = data.divider ?? { enabled: true, color: '#646b70', widthPx: 2 };
  if (typeof divider.enabled !== 'boolean' || !validReferenceColor(divider.color) || !Number.isFinite(divider.widthPx) || divider.widthPx < 1 || divider.widthPx > 20) return null;
  const foregrounds = data.foregrounds ?? [];
  if (!Array.isArray(foregrounds) || foregrounds.length > data.slots.length || foregrounds.some(item => !item || typeof item !== 'object') || new Set(foregrounds.map(item => item.slotId)).size !== foregrounds.length
    || foregrounds.some(item => !item || !data.slots.some(slot => slot.id === item.slotId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.jobId)
      || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.sourceAssetId) || !/^[a-f0-9]{64}$/.test(item.sha256))) return null;
  return { schema: 3, kind: 'reference-collage', sourceVersion: data.sourceVersion, slots: data.slots.map(slot => ({ id: slot.id, frame: slot.frame, name: slot.name, manual: slot.manual, locked: slot.locked === true })), reserve: [], restoreOrder: [],
    layout: { columns: data.layout.columns, margin: data.layout.margin, gap: data.layout.gap, background: data.layout.background },
    output: { width: output.width, height: output.height, background: output.background }, panels, placements,
    divider: { enabled: divider.enabled, color: divider.color, widthPx: divider.widthPx },
    foregrounds: foregrounds.map(item => ({ slotId: item.slotId, jobId: item.jobId, sourceAssetId: item.sourceAssetId, sha256: item.sha256 })) };
}
type ReferenceRectLike = { x: number; y: number; width: number; height: number };

export const multiviewWorkDimensions = (info: MultiviewInfo, recipe: MultiviewWorkRecipe) => recipe.schema === 3 ? { width: recipe.output.width, height: recipe.output.height } : multiviewDimensions(info, recipe.slots.length, recipe.layout);
