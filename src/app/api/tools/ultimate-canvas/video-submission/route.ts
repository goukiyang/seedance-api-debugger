import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertCanEditCanvasDocument } from '@/lib/canvas-documents';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const json = (value: unknown, status = 200) => NextResponse.json(value, {
  status, headers: { 'Cache-Control': 'private, no-store' },
});

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) throw new AuthError('未登录', 401);
    const params = request.nextUrl.searchParams;
    const documentId = params.get('document_id') || '';
    const nodeId = params.get('node_id') || '';
    const requestId = params.get('request_id') || '';
    if (![documentId, nodeId, requestId].every(value => /^[a-zA-Z0-9_-]{1,160}$/.test(value))) {
      throw new AuthError('请求编号无效', 400);
    }
    const document = await assertCanEditCanvasDocument(user, documentId);
    const snapshot = JSON.parse(document.document_json);
    const node = snapshot.canvas?.nodes?.find((item: { id?: string }) => item.id === nodeId);
    const submission = node?.data?.videoSubmission;
    if (submission?.requestId !== requestId || submission.userId !== user.id
      || submission.documentId !== document.id || submission.projectId !== document.project_id) {
      throw new AuthError('请求不属于当前画布', 403);
    }
    const task = await prisma.videoTask.findUnique({
      where: { user_id_idempotency_key: { user_id: user.id, idempotency_key: `${nodeId}:${requestId}` } },
    });
    // Absence is not evidence that a delayed POST was never accepted.
    if (!task) return json({ state: 'unconfirmed', task: null });
    const metadata = JSON.parse(task.source_metadata_json || '{}');
    if (task.user_id !== user.id || task.project_id !== document.project_id
      || task.video_card_id !== submission.cardId
      || task.source_request_id !== `ultimate_canvas:${nodeId}:${requestId}`
      || metadata.canvas_document_id !== document.id || metadata.canvas_node_id !== nodeId) {
      throw new AuthError('任务与当前请求不匹配', 403);
    }
    await assertCanViewTask(user, task);
    return json({ state: 'accepted', task: { id: task.id, local_status: task.local_status } });
  } catch (error) {
    if (error instanceof AuthError) return json({ error: error.message }, error.status);
    return json({ error: '请求状态暂时无法读取，请保留原请求后重试' }, 500);
  }
}
