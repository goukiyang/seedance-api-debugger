import type { Prisma } from '@prisma/client';
import { AuthError } from '@/lib/auth/session';

const capability = 'canvas.references.v1';
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export function canvasReferencesRequired(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.canvasReferenceVersion === 1 || Array.isArray(value.requiredCapabilities) && value.requiredCapabilities.includes(capability)) return true;
  const graph = record(value.canvas) ? value.canvas : value;
  return Array.isArray(graph.nodes) && graph.nodes.some(node => record(node) && record(node.data) && node.data.canvas_references !== undefined);
}
export function assertCanvasReferenceRollbackSafe(...values: unknown[]): void {
  for (const raw of values) {
    const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (canvasReferencesRequired(value) || record(value) && Object.hasOwn(value, 'canvas_references')) {
      throw new CanvasReferenceRollbackError();
    }
  }
}
export class CanvasReferenceRollbackError extends AuthError {
  readonly code = 'canvas_reference_rollback_paused';
  constructor() { super('兼容回退期间，此画布的新版参考输入暂不支持改写或新生成；原画布、原任务和请求回执仍可查看', 426); }
}

// Denial only: callers retain their original identity/project/receipt checks. Never resolves or rewrites inputs.
export async function assertCanvasGenerationRollbackSafe(ownerId: string, body: Record<string, unknown>, db: Prisma.TransactionClient) {
  assertCanvasReferenceRollbackSafe(body);
  const context = record(body.context) ? body.context : {};
  const metadata = record(body.source_metadata) ? body.source_metadata : {};
  const ids = new Set([body.canvas_document_id, body.canvasDocumentId, body.documentId, body.document_id,
    context.documentId, metadata.canvas_document_id].filter((value): value is string => typeof value === 'string' && Boolean(value)));
  for (const id of ids) {
    const document = await db.canvasDocument.findUnique({ where: { id }, select: { owner_user_id: true, document_json: true } });
    if (!document || !canvasReferencesRequired(JSON.parse(document.document_json))) continue;
    if (document.owner_user_id !== ownerId) throw new AuthError('无权访问此画布', 403);
    throw new CanvasReferenceRollbackError();
  }
}
