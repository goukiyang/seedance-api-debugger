export const MULTIVIEW_PREVIEW_SCHEMA = 1 as const;
export const MULTIVIEW_PREVIEW_CHUNK_SIZE = 24;
export const MULTIVIEW_PREVIEW_COLUMNS = 6;
export const MULTIVIEW_PREVIEW_ROWS = 4;
export const MULTIVIEW_PREVIEW_EAGER_LIMIT = 600;
export const MULTIVIEW_PREVIEW_MAX_BYTES = 32 * 1024 * 1024;

export type MultiviewPreviewChunk = {
  index: number;
  start: number;
  count: number;
  ready: boolean;
  mime: 'image/jpeg';
  bytes?: number;
  etag?: string;
};

export type MultiviewPreviewManifest = {
  schema: typeof MULTIVIEW_PREVIEW_SCHEMA;
  sourceVersion: string;
  totalFrames: number;
  timestamps: number[];
  cellWidth: number;
  cellHeight: number;
  columns: typeof MULTIVIEW_PREVIEW_COLUMNS;
  rows: typeof MULTIVIEW_PREVIEW_ROWS;
  chunkSize: typeof MULTIVIEW_PREVIEW_CHUNK_SIZE;
  eager: boolean;
  chunks: MultiviewPreviewChunk[];
};

export function multiviewPreviewCell(width: number, height: number) {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const scale = 320 / Math.max(safeWidth, safeHeight);
  const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
  return { width: even(safeWidth * scale), height: even(safeHeight * scale) };
}

export function multiviewPreviewChunkIndex(frame: number) {
  return Math.floor(frame / MULTIVIEW_PREVIEW_CHUNK_SIZE);
}

export function multiviewPreviewFrameRect(manifest: MultiviewPreviewManifest, frame: number) {
  if (!Number.isInteger(frame) || frame < 0 || frame >= manifest.totalFrames) return null;
  const local = frame % manifest.chunkSize;
  return { x: local % manifest.columns * manifest.cellWidth, y: Math.floor(local / manifest.columns) * manifest.cellHeight,
    width: manifest.cellWidth, height: manifest.cellHeight };
}

export function multiviewPreviewRetainedChunks(target: number, available: number[], limit = 2) {
  return Array.from(new Set(available)).sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b).slice(0, limit);
}

export function createMultiviewLatestTargetGate() {
  let sequence = 0;
  return {
    issue(frame: number) { return { frame, sequence: ++sequence }; },
    isCurrent(target: { frame: number; sequence: number }) { return target.sequence === sequence; },
    cancel() { sequence += 1; },
  };
}

export function createMultiviewPreviewManifest(input: {
  sourceVersion: string;
  width: number;
  height: number;
  timestamps: number[];
}, ready: Map<number, { bytes: number; etag: string }> = new Map()): MultiviewPreviewManifest {
  const cell = multiviewPreviewCell(input.width, input.height);
  const totalFrames = input.timestamps.length;
  const chunkCount = Math.ceil(totalFrames / MULTIVIEW_PREVIEW_CHUNK_SIZE);
  return {
    schema: MULTIVIEW_PREVIEW_SCHEMA,
    sourceVersion: input.sourceVersion,
    totalFrames,
    timestamps: input.timestamps,
    cellWidth: cell.width,
    cellHeight: cell.height,
    columns: MULTIVIEW_PREVIEW_COLUMNS,
    rows: MULTIVIEW_PREVIEW_ROWS,
    chunkSize: MULTIVIEW_PREVIEW_CHUNK_SIZE,
    eager: totalFrames <= MULTIVIEW_PREVIEW_EAGER_LIMIT,
    chunks: Array.from({ length: chunkCount }, (_, index) => {
      const cached = ready.get(index);
      return { index, start: index * MULTIVIEW_PREVIEW_CHUNK_SIZE,
        count: Math.min(MULTIVIEW_PREVIEW_CHUNK_SIZE, totalFrames - index * MULTIVIEW_PREVIEW_CHUNK_SIZE),
        ready: Boolean(cached), mime: 'image/jpeg', ...(cached || {}) };
    }),
  };
}
