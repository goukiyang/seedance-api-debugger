export const CANVAS_REFERENCES_CAPABILITY = 'canvas.references.v1';
export type CanvasReference = { kind: 'image' | 'video' | 'audio'; role: 'reference' | 'first' | 'last';
  assetId?: string; referenceImageId?: string; taskId?: string; sourceNodeId?: string; sourceVersion?: string };
export type CanvasReferences = { version: 1; items: CanvasReference[] };
export class CanvasReferenceError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = 'canvas_references_invalid') { super(message); }
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
export function normalizeCanvasReferences(value: unknown): CanvasReferences | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || value.version !== 1 || !Array.isArray(value.items) || value.items.length > 80
    || Object.keys(value).some(key => !['version', 'items'].includes(key))) throw new CanvasReferenceError('参考素材格式无效，请保留输入重新选择');
  const items: CanvasReference[] = [], seen = new Map<string, string>();
  for (const raw of value.items) {
    if (!record(raw) || !['image', 'video', 'audio'].includes(String(raw.kind)) || !['reference', 'first', 'last'].includes(String(raw.role))
      || Object.keys(raw).some(key => !['kind', 'role', 'assetId', 'referenceImageId', 'taskId', 'sourceNodeId', 'sourceVersion'].includes(key))
      || raw.role !== 'reference' && raw.kind !== 'image') throw new CanvasReferenceError('参考素材类型或首尾角色无效');
    const item = { kind: raw.kind, role: raw.role } as CanvasReference;
    for (const key of ['assetId', 'referenceImageId', 'taskId', 'sourceNodeId'] as const) {
      if (raw[key] !== undefined) { if (!id(raw[key])) throw new CanvasReferenceError('参考素材编号无效'); item[key] = raw[key]; }
    }
    if (!item.assetId && !item.referenceImageId && !item.taskId) throw new CanvasReferenceError('参考素材缺少持久编号，未使用预览地址生成');
    if (raw.sourceVersion !== undefined) {
      if (typeof raw.sourceVersion !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sourceVersion)) throw new CanvasReferenceError('参考素材版本无效');
      item.sourceVersion = raw.sourceVersion;
    }
    const key = JSON.stringify([item.kind, item.role, item.assetId || null, item.referenceImageId || null, item.taskId || null]);
    const previous = seen.get(key);
    if (previous !== undefined) {
      if (previous !== JSON.stringify(item)) throw new CanvasReferenceError('重复素材来源或版本冲突，请重新核对', 409);
      continue;
    }
    seen.set(key, JSON.stringify(item)); items.push(item);
  }
  return { version: 1, items };
}
export function canvasReferencesRequired(snapshot: unknown): boolean {
  if (!record(snapshot)) return false;
  if (snapshot.canvasReferenceVersion === 1 || Array.isArray(snapshot.requiredCapabilities)
    && snapshot.requiredCapabilities.includes(CANVAS_REFERENCES_CAPABILITY)) return true;
  const graph = record(snapshot.canvas) ? snapshot.canvas : snapshot;
  return Array.isArray(graph.nodes) && graph.nodes.some(node => record(node) && record(node.data) && node.data.canvas_references !== undefined);
}
export function requireCanvasReferencesCapability(snapshot: unknown, capabilities: unknown) {
  if (canvasReferencesRequired(snapshot) && (!Array.isArray(capabilities) || !capabilities.includes(CANVAS_REFERENCES_CAPABILITY))) {
    throw new CanvasReferenceError('此画布包含新版参考素材，请刷新后继续；原输入保持不变', 426, 'canvas_references_capability_required');
  }
}
export function retainCanvasReferencesCapability<T extends Record<string, unknown>>(snapshot: T, previous?: unknown): T {
  if (canvasReferencesRequired(snapshot) || canvasReferencesRequired(previous)) {
    const mutable: Record<string, unknown> = snapshot;
    mutable.canvasReferenceVersion = 1;
    mutable.requiredCapabilities = Array.from(new Set([...(Array.isArray(snapshot.requiredCapabilities) ? snapshot.requiredCapabilities : []), CANVAS_REFERENCES_CAPABILITY]));
  }
  return snapshot;
}
