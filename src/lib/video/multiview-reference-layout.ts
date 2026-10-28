import { DEFAULT_MULTIVIEW_LAYOUT, type MultiviewInfo, type MultiviewSlot } from './multiview-contract';
import type { MultiviewReferenceRecipe } from './multiview-work-contract';

export type ReferenceLayout = 'horizontal' | 'vertical' | 'large-left' | 'large-top' | 'equal' | 'grid';
export type ReferenceRect = { x: number; y: number; width: number; height: number };
export type ReferencePanel = ReferenceRect & { slotId: string };
export type ReferencePlacement = ReferenceRect & { slotId: string; z: number };
export type ReferenceDivider = { enabled: boolean; color: string; widthPx: number };
export type ReferenceForeground = { slotId: string; jobId: string; sourceAssetId: string; sha256: string };
export type ReferenceOutput = { width: number; height: number; background: string };
export const REFERENCE_LAYOUTS: ReferenceLayout[] = ['horizontal', 'vertical', 'large-left', 'large-top', 'equal', 'grid'];
export const validReferenceColor = (value: unknown): value is string => typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value);
const epsilon = 0.000001;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export function validReferenceRect(rect: ReferenceRect) {
  return rect && [rect.x, rect.y, rect.width, rect.height].every(finite) && rect.x >= 0 && rect.y >= 0
    && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= 1 + epsilon && rect.y + rect.height <= 1 + epsilon;
}
export function referencePanels(slots: Array<Pick<MultiviewSlot, 'id'>>, layout: ReferenceLayout = slots.length === 2 ? 'horizontal' : slots.length === 3 ? 'large-left' : 'grid'): ReferencePanel[] {
  const count = slots.length;
  if (count < 2 || count > 4) return [];
  let boxes: ReferenceRect[];
  if (count === 4 || layout === 'grid') boxes = count === 4 ? [
    { x: 0, y: 0, width: .5, height: .5 }, { x: .5, y: 0, width: .5, height: .5 },
    { x: 0, y: .5, width: .5, height: .5 }, { x: .5, y: .5, width: .5, height: .5 },
  ] : [];
  else if (count === 3 && layout === 'large-left') boxes = [
    { x: 0, y: 0, width: .5, height: 1 }, { x: .5, y: 0, width: .5, height: .5 }, { x: .5, y: .5, width: .5, height: .5 },
  ];
  else if (count === 3 && layout === 'large-top') boxes = [
    { x: 0, y: 0, width: 1, height: .5 }, { x: 0, y: .5, width: .5, height: .5 }, { x: .5, y: .5, width: .5, height: .5 },
  ];
  else if (layout === 'vertical') boxes = slots.map((_, i) => ({ x: 0, y: i / count, width: 1, height: 1 / count }));
  else boxes = slots.map((_, i) => ({ x: i / count, y: 0, width: 1 / count, height: 1 }));
  if (!boxes.length) return referencePanels(slots, count === 2 ? 'horizontal' : 'large-left');
  return slots.map((slot, index) => ({ slotId: slot.id, ...boxes[index] }));
}
/** Rectangles use canvas coordinates. Keep the complete source inside its own shot. */
export function clampReferencePlacement(placement: ReferencePlacement, panel: ReferencePanel, info: Pick<MultiviewInfo, 'width' | 'height'>, output: ReferenceOutput): ReferencePlacement {
  const sourceRatio = info.width / info.height * output.height / output.width;
  const width = Math.max(.000001, Math.min(panel.width, panel.height * sourceRatio, finite(placement.width) ? placement.width : panel.width));
  const height = width / sourceRatio;
  const x = Math.max(panel.x, Math.min(panel.x + panel.width - width, finite(placement.x) ? placement.x : panel.x + (panel.width - width) / 2));
  const y = Math.max(panel.y, Math.min(panel.y + panel.height - height, finite(placement.y) ? placement.y : panel.y + (panel.height - height) / 2));
  return { slotId: panel.slotId, x, y, width, height, z: Number.isSafeInteger(placement.z) ? Math.max(0, Math.min(3, placement.z)) : 0 };
}
export function createMultiviewReferenceRecipe(info: MultiviewInfo, slots: MultiviewSlot[], options: ReferenceOutput & { layout?: ReferenceLayout }): MultiviewReferenceRecipe {
  const output = { width: options.width, height: options.height, background: options.background || '#d6dbdf' };
  const panels = referencePanels(slots, options.layout);
  return { schema: 3, kind: 'reference-collage', sourceVersion: info.sourceVersion,
    slots: slots.map(slot => ({ id: slot.id, frame: slot.frame, name: slot.name, manual: slot.manual, locked: slot.locked === true })), reserve: [], restoreOrder: [], layout: { ...DEFAULT_MULTIVIEW_LAYOUT }, output,
    panels, placements: panels.map((panel, z) => {
      const width = Math.min(panel.width * .94, panel.height * .94 * info.width / info.height * output.height / output.width);
      const height = width / (info.width / info.height * output.height / output.width);
      return { slotId: panel.slotId, x: panel.x + (panel.width - width) / 2, y: panel.y + (panel.height - height) / 2, width, height, z };
    }), divider: { enabled: true, color: '#646b70', widthPx: 2 }, foregrounds: [] };
}
export type ReferenceDividerSegment = { x1: number; y1: number; x2: number; y2: number };
/** Shared edges only: no outer border, no image outline and no duplicate T/cross strokes. */
export function referenceDividerSegments(recipe: Pick<MultiviewReferenceRecipe, 'panels'>): ReferenceDividerSegment[] {
  const edges: Array<{ axis: 'x' | 'y'; at: number; from: number; to: number }> = [];
  const panels = recipe.panels;
  for (let a = 0; a < panels.length; a++) for (let b = a + 1; b < panels.length; b++) {
    const left = panels[a], right = panels[b];
    if (Math.abs(left.x + left.width - right.x) < epsilon || Math.abs(right.x + right.width - left.x) < epsilon) {
      const from = Math.max(left.y, right.y), to = Math.min(left.y + left.height, right.y + right.height);
      if (to - from > epsilon) edges.push({ axis: 'x', at: Math.max(left.x, right.x), from, to });
    }
    if (Math.abs(left.y + left.height - right.y) < epsilon || Math.abs(right.y + right.height - left.y) < epsilon) {
      const from = Math.max(left.x, right.x), to = Math.min(left.x + left.width, right.x + right.width);
      if (to - from > epsilon) edges.push({ axis: 'y', at: Math.max(left.y, right.y), from, to });
    }
  }
  const merged: typeof edges = [];
  for (const edge of edges.sort((a, b) => a.axis.localeCompare(b.axis) || a.at - b.at || a.from - b.from)) {
    const previous = merged[merged.length - 1];
    if (previous && previous.axis === edge.axis && Math.abs(previous.at - edge.at) < epsilon && edge.from <= previous.to + epsilon) previous.to = Math.max(previous.to, edge.to);
    else merged.push({ ...edge });
  }
  return merged.map(edge => edge.axis === 'x' ? { x1: edge.at, y1: edge.from, x2: edge.at, y2: edge.to } : { x1: edge.from, y1: edge.at, x2: edge.to, y2: edge.at });
}
export function referencePixelGeometry(recipe: MultiviewReferenceRecipe, info: Pick<MultiviewInfo, 'width' | 'height'>) {
  const { width, height } = recipe.output;
  const pixels = (rect: ReferenceRect) => ({ x: Math.round(rect.x * width), y: Math.round(rect.y * height),
    width: Math.max(1, Math.round((rect.x + rect.width) * width) - Math.round(rect.x * width)),
    height: Math.max(1, Math.round((rect.y + rect.height) * height) - Math.round(rect.y * height)) });
  return { width, height, panels: recipe.panels.map(panel => ({ slotId: panel.slotId, ...pixels(panel) })),
    placements: recipe.placements.map(placement => {
      const panel = recipe.panels.find(item => item.slotId === placement.slotId)!;
      return { slotId: placement.slotId, z: placement.z, ...pixels(clampReferencePlacement(placement, panel, info, recipe.output)) };
    }).sort((a, b) => a.z - b.z),
    dividers: referenceDividerSegments(recipe).map(edge => ({ x1: Math.round(edge.x1 * width), y1: Math.round(edge.y1 * height), x2: Math.round(edge.x2 * width), y2: Math.round(edge.y2 * height) })) };
}
export function resizeMultiviewReference(recipe: MultiviewReferenceRecipe, info: MultiviewInfo, output: ReferenceOutput, layout?: ReferenceLayout): MultiviewReferenceRecipe {
  const panels = layout ? referencePanels(recipe.slots, layout) : recipe.panels;
  const placements = panels.map(panel => {
    const old = recipe.panels.find(item => item.slotId === panel.slotId)!, placement = recipe.placements.find(item => item.slotId === panel.slotId)!;
    const oldRatio = info.width / info.height * recipe.output.height / recipe.output.width;
    const newRatio = info.width / info.height * output.height / output.width;
    const oldMaximum = Math.min(old.width, old.height * oldRatio), newMaximum = Math.min(panel.width, panel.height * newRatio);
    const scale = Math.min(1, placement.width / oldMaximum), width = newMaximum * scale, height = width / newRatio;
    const relativeX = old.width - placement.width > epsilon ? (placement.x - old.x) / (old.width - placement.width) : .5;
    const relativeY = old.height - placement.height > epsilon ? (placement.y - old.y) / (old.height - placement.height) : .5;
    return clampReferencePlacement({ ...placement, x: panel.x + (panel.width - width) * relativeX,
      y: panel.y + (panel.height - height) * relativeY, width, height }, panel, info, output);
  });
  return { ...recipe, output, panels, placements };
}
