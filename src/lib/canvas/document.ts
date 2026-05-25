export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasNodeDocument {
  id: string;
  type: string;
  data: Record<string, unknown>;
  position?: { x: number; y: number };
  [key: string]: unknown;
}

export interface CanvasEdgeDocument {
  id: string;
  source: string;
  target: string;
  [key: string]: unknown;
}

export interface CanvasDocumentData {
  version: 1;
  title: string;
  activeGenerationId?: string;
  nodes: CanvasNodeDocument[];
  edges: CanvasEdgeDocument[];
  viewport?: CanvasViewport | null;
}

const DEFAULT_CANVAS_TITLE = '未命名画布';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeTitle(value: unknown, fallback: string) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizePosition(value: unknown) {
  if (!isRecord(value)) return undefined;
  const x = asNumber(value.x);
  const y = asNumber(value.y);
  if (x === null || y === null) return undefined;
  return { x, y };
}

function normalizeViewport(value: unknown): CanvasViewport | null {
  if (!isRecord(value)) return null;
  const x = asNumber(value.x);
  const y = asNumber(value.y);
  const zoom = asNumber(value.zoom);
  if (x === null || y === null || zoom === null) return null;
  return { x, y, zoom };
}

function normalizeNode(value: unknown): CanvasNodeDocument | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.type !== 'string') return null;
  return {
    ...value,
    id: value.id,
    type: value.type,
    data: isRecord(value.data) ? value.data : {},
    ...(normalizePosition(value.position) ? { position: normalizePosition(value.position) } : {}),
  };
}

function normalizeEdge(value: unknown): CanvasEdgeDocument | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.source !== 'string' ||
    typeof value.target !== 'string'
  ) {
    return null;
  }
  return {
    ...value,
    id: value.id,
    source: value.source,
    target: value.target,
  };
}

export function createBlankCanvasDocument(title = DEFAULT_CANVAS_TITLE): CanvasDocumentData {
  return {
    version: 1,
    title: normalizeTitle(title, DEFAULT_CANVAS_TITLE),
    activeGenerationId: '',
    nodes: [],
    edges: [],
    viewport: null,
  };
}

export function normalizeCanvasDocumentInput(input: unknown, fallbackTitle = DEFAULT_CANVAS_TITLE): CanvasDocumentData {
  if (!isRecord(input)) {
    return createBlankCanvasDocument(fallbackTitle);
  }

  const nodes = Array.isArray(input.nodes)
    ? input.nodes.map(normalizeNode).filter((node): node is CanvasNodeDocument => Boolean(node))
    : [];
  const edges = Array.isArray(input.edges)
    ? input.edges.map(normalizeEdge).filter((edge): edge is CanvasEdgeDocument => Boolean(edge))
    : [];

  return {
    version: 1,
    title: normalizeTitle(input.title, fallbackTitle),
    activeGenerationId: typeof input.activeGenerationId === 'string' ? input.activeGenerationId : '',
    nodes,
    edges,
    viewport: normalizeViewport(input.viewport),
  };
}

export function parseCanvasDocumentJson(raw: string, fallbackTitle = DEFAULT_CANVAS_TITLE) {
  try {
    return normalizeCanvasDocumentInput(JSON.parse(raw), fallbackTitle);
  } catch {
    return createBlankCanvasDocument(fallbackTitle);
  }
}

export function summarizeCanvasDocument(document: CanvasDocumentData) {
  return {
    nodeCount: document.nodes.length,
    edgeCount: document.edges.length,
    generationCount: document.nodes.filter((node) => node.type === 'generationCard' || node.type === 'agentGenerationCard').length,
    activeGenerationId: document.activeGenerationId || '',
  };
}
