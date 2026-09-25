import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import {
  CanvasDocumentError, MAX_CANVAS_BYTES, canvasDetail, canvasHistory,
  latestCanvasDocument, listCanvasDocuments, mutateCanvasDocument, readCanvasDocument,
} from '@/lib/canvas-documents';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function json(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

function failure(error: unknown) {
  if (error instanceof CanvasDocumentError) return json({ error: error.message, code: error.code, ...error.details }, error.status);
  if (error instanceof AuthError) return json({ error: error.message }, error.status);
  if (error instanceof SyntaxError) return json({ error: '画布内容不是有效 JSON', code: 'invalid_document' }, 400);
  // Prisma errors may contain snapshots; do not log their messages or request bodies.
  console.error('[UltimateCanvasDocument] Request failed', error instanceof Error ? error.name : 'UnknownError');
  return json({ error: '画布操作失败，请保留当前内容后重试' }, 500);
}

async function session() {
  const user = await getSession();
  if (!user) throw new AuthError('未登录', 401);
  assertInternalOnly(user, '外部账号无权使用无线画布。');
  return user;
}

export async function GET(request: NextRequest) {
  try {
    const user = await session();
    const params = request.nextUrl.searchParams;
    if (params.get('list') === '1') return json(await listCanvasDocuments(user, params));
    const documentId = params.get('document_id')?.trim();
    if (params.get('history') === '1') {
      if (!documentId) throw new AuthError('缺少 document_id', 400);
      return json(await canvasHistory(user, documentId));
    }
    const document = documentId
      ? await readCanvasDocument(user, documentId)
      : await latestCanvasDocument(user, params.get('project_id')?.trim() || null);
    const requestedProject = params.get('project_id')?.trim();
    if (document && requestedProject && document.project_id !== requestedProject) throw new AuthError('画布不属于当前项目', 400);
    return json({ document: document ? canvasDetail(document) : null });
  } catch (error) { return failure(error); }
}

async function mutate(request: NextRequest, method: 'POST' | 'PATCH') {
  try {
    const user = await session();
    // JSON-in-JSON escaping may increase the wire size beyond the snapshot size.
    const maxBodyBytes = MAX_CANVAS_BYTES * 3 + 64 * 1024;
    if (Number(request.headers.get('content-length')) > maxBodyBytes) {
      throw new CanvasDocumentError('请求过大，请拆分画布后保存', 413, 'document_too_large');
    }
    const reader = request.body?.getReader();
    if (!reader) throw new AuthError('缺少请求内容', 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBodyBytes) {
          await reader.cancel();
          throw new CanvasDocumentError('请求过大，请拆分画布后保存', 413, 'document_too_large');
        }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AuthError('请求内容必须是对象', 400);
    return json(await mutateCanvasDocument(user, body as Record<string, unknown>, method));
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) { return mutate(request, 'POST'); }
export async function PATCH(request: NextRequest) { return mutate(request, 'PATCH'); }
