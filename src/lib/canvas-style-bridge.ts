import { createHash } from 'node:crypto';
import { CanvasPromptReferenceError } from '@/lib/canvas-prompt-references';
import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession, type SessionUser } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { StudioModuleError } from '@/lib/image-studio/modules';
import { StudioError } from '@/lib/image-studio/tasks';
import { StudioStyleError } from '@/lib/image-studio/style-groups';
import { StudioReferencePolicyError } from '@/lib/image-studio/reference-policy';
import { ReferenceImportError } from '@/lib/assets/reference-import';
import { assertCanEditCanvasDocument } from '@/lib/canvas-documents';
import { getProjectForGeneration } from '@/lib/projects/permissions';
import { assertCanGenerateInVideoCard } from '@/lib/video-cards/permissions';
import { prisma } from '@/lib/prisma';

const RESPONSE_HEADERS = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const MAX_JSON_BYTES = 128 * 1024;

export type CanvasStyleContext = {
  projectId: string;
  cardId: string;
  documentId: string | null;
  nodeId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function contextId(value: unknown, label: string, optional: boolean) {
  if (optional && value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
    throw new AuthError(`${label}无效`, 400);
  }
  return value;
}

export const canvasStyleJson = (value: unknown, status = 200) =>
  NextResponse.json(value, { status, headers: RESPONSE_HEADERS });

export async function requireCanvasStyleUser(): Promise<SessionUser> {
  const user = await getSession();
  if (!user) throw new AuthError('未登录', 401);
  assertInternalOnly(user, '外部账号无权使用无限画布风格库。');
  if (!canUseCompanyTemplates(user)) throw new AuthError('仅限公司飞书账号使用画布风格库', 403);
  return user;
}

export async function readCanvasStyleJson(request: NextRequest): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new AuthError('请使用 JSON 请求参数', 415);
  }
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_JSON_BYTES) throw new AuthError('请求内容过大', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError('请求内容为空', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new AuthError('请求内容过大', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!isRecord(value)) throw new AuthError('请求内容必须是对象', 400);
  return value;
}

export function parseCanvasStyleContext(body: Record<string, unknown>): CanvasStyleContext {
  const value = body.context === undefined ? body : body.context;
  if (!isRecord(value)) throw new AuthError('画布上下文无效', 400);
  const keys = ['projectId', 'cardId', 'documentId', 'nodeId'] as const;
  if (keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new AuthError('画布上下文缺少必要字段，请刷新画布后重试', 400);
  }
  return {
    projectId: contextId(value.projectId, '项目编号', false)!,
    cardId: contextId(value.cardId, '视频卡编号', false)!,
    documentId: contextId(value.documentId, '画布编号', true),
    nodeId: contextId(value.nodeId, '节点编号', true),
  };
}

export async function assertCanvasStyleContext(user: SessionUser, context: CanvasStyleContext) {
  const card = await prisma.videoCard.findUnique({
    where: { id: context.cardId },
    select: { id: true, project_id: true },
  });
  if (!card) throw new AuthError('视频卡不存在', 404);
  if (card.project_id !== context.projectId) throw new AuthError('视频卡不属于当前项目', 400);
  const project = await getProjectForGeneration(user, card.project_id);
  await assertCanGenerateInVideoCard(user, project.id, card.id);

  if (context.nodeId && !context.documentId) {
    throw new AuthError('节点必须属于已选择的画布', 400);
  }
  if (!context.documentId) return;

  const document = await assertCanEditCanvasDocument(user, context.documentId, project.id);
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(document.document_json);
  } catch {
    throw new AuthError('画布状态无法核对，请先保存并刷新后重试', 409);
  }
  if (!isRecord(snapshot)) throw new AuthError('画布状态无法核对，请先保存并刷新后重试', 409);
  const savedContext = isRecord(snapshot.context) ? snapshot.context : {};
  const savedCardId = typeof savedContext.video_card_id === 'string'
    ? savedContext.video_card_id
    : typeof savedContext.videoCardId === 'string' ? savedContext.videoCardId : '';
  if (savedCardId && savedCardId !== card.id) throw new AuthError('画布不属于当前视频卡', 400);
  if (context.nodeId) {
    const canvas = isRecord(snapshot.canvas) ? snapshot.canvas : {};
    const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
    if (!nodes.some(node => isRecord(node) && node.id === context.nodeId)) {
      throw new AuthError('节点已不在当前画布中，请先保存画布后重试', 409);
    }
  }
}

export function canvasStyleBatchId(ownerId: string, requestId: string) {
  return createHash('sha256').update(`${ownerId}:${requestId}`).digest('hex');
}

export function canvasStyleFailure(error: unknown, fallback: string) {
  if (error instanceof CanvasPromptReferenceError) return canvasStyleJson({ error: error.code, message: error.message }, 400);
  if (error instanceof SyntaxError) return canvasStyleJson({ error: '请求内容不是有效 JSON' }, 400);
  if (error instanceof AuthError) return canvasStyleJson({ error: error.message }, error.status);
  if (error instanceof StudioModuleError || error instanceof StudioError || error instanceof StudioStyleError
    || error instanceof StudioReferencePolicyError || error instanceof ReferenceImportError) {
    return canvasStyleJson({ error: error.message }, error.status);
  }
  if (error instanceof Error && error.message.startsWith('点数不足')) return canvasStyleJson({ error: error.message }, 409);
  console.error('[CanvasStyleBridge] request failed', error instanceof Error ? error.name : 'UnknownError');
  return canvasStyleJson({ error: fallback }, 503);
}
