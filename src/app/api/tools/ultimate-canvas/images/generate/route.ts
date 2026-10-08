import { NextRequest } from 'next/server';
import { assertCanvasPromptCompatibility } from '@/lib/canvas-prompt-compatibility';
import { AuthError } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { resolveCanvasStudioReferenceUse } from '@/lib/canvas-studio-reference-use';
import { getCanvasImageQuote } from '@/lib/canvas-quote';
import { saveStudioModule, validStudioModuleId } from '@/lib/image-studio/modules';
import { submitStudioBatch } from '@/lib/image-studio/tasks';
import { canvasImageReferencePolicy } from '@/lib/canvas-image-references';
import { validateStudioReferenceCounts } from '@/lib/image-studio/reference-policy';
import { assertCanvasStyleContext, canvasStyleFailure, canvasStyleJson, parseCanvasStyleContext, readCanvasStyleJson, requireCanvasStyleUser } from '@/lib/canvas-style-bridge';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const user = await requireCanvasStyleUser();
    const params = request.nextUrl.searchParams;
    const context = parseCanvasStyleContext(Object.fromEntries(['projectId', 'cardId', 'documentId', 'nodeId'].map(key => [key, params.get(key)])));
    await assertCanvasStyleContext(user, context);
    const ids = params.getAll('referenceImageId');
    if (ids.length > 9) throw new AuthError('参考图数量无效', 400);
    await resolveCanvasStudioReferenceUse(user, ids);
    return canvasStyleJson({ durable: true });
  } catch (error) { return canvasStyleFailure(error, '参考图状态未确认，未生成'); }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireCanvasStyleUser();
    const body = await readCanvasStyleJson(request);
    const context = parseCanvasStyleContext(body);
    await assertCanvasStyleContext(user, context);
    await assertCanvasPromptCompatibility(user, context.documentId, context.nodeId, String(body.prompt || ''), body.promptMentions, true);
    if (!context.documentId || !context.nodeId || !validStudioModuleId(body.moduleId, user.id)
      || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)) throw new AuthError('图片任务归属或编号无效', 400);
    const doc = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: context.documentId } });
    const graph = JSON.parse(doc.document_json);
    const node = graph.canvas.nodes.find((item: { id: string }) => item.id === context.nodeId);
    const job = node?.data?.styleJob;
    if (node?.type !== 'image' || job?.kind !== 'ordinary' || job.requestId !== body.requestId
      || job.moduleId !== body.moduleId || JSON.stringify(job.input) !== JSON.stringify(body)) throw new AuthError('请先保存本次图片请求，再确认提交', 409);
    const settings = body.settings as Record<string, unknown>;
    if (!settings || typeof settings.model !== 'string' || typeof settings.quality !== 'string'
      || typeof settings.resolution !== 'string' || typeof settings.ratio !== 'string') throw new AuthError('图片设置无效', 400);
    const quote = await getCanvasImageQuote(user, { kind: 'image', project_id: context.projectId,
      model: settings.model, count: Number(settings.count), quality: settings.quality, resolution: settings.resolution, ratio: settings.ratio });
    if (quote.status !== 'estimate' || quote.revision !== body.settingsRevision
      || quote.estimatedCredits !== body.maxEstimatedCost) throw new AuthError('价格或设置已变化，请重新核对；未派发新任务', 409);
    if (!Array.isArray(body.referenceImageIds) || body.referenceImageIds.length > 9) throw new AuthError('参考图数量无效', 400);
    const referenceImageIds = body.referenceImageIds as string[];
    const uniqueReferences = Array.from((await resolveCanvasStudioReferenceUse(user, referenceImageIds)).keys());
    const referencePolicy = canvasImageReferencePolicy(uniqueReferences);
    validateStudioReferenceCounts(referencePolicy, uniqueReferences, 0, 0, true);
    const existing = await prisma.imageStudioModule.findFirst({ where: { id: body.moduleId, owner_id: user.id } });
    if (!existing) await saveStudioModule(user.id, { id: body.moduleId, revision: 0, name: '画布图片',
      prompt: '', count: Number(settings.count), referenceIds: [], model: settings.model, quality: settings.quality,
      resolution: settings.resolution, aspectRatio: settings.ratio, groupName: '画布图片' }, false, user.role === 'admin', undefined, user);
    const batchId = await submitStudioBatch(user.id, { requestId: body.requestId, moduleId: body.moduleId,
      revision: body.settingsRevision, prompt: body.prompt, count: Number(settings.count), referenceIds: uniqueReferences,
      draft: { referencePolicy }, maxEstimatedCost: body.maxEstimatedCost,
      model: settings.model, quality: settings.quality, resolution: settings.resolution, aspectRatio: settings.ratio }, undefined, undefined, { user, referenceImageIds });
    return canvasStyleJson({ batchId, moduleId: body.moduleId, count: Number(settings.count) }, 202);
  } catch (error) { return canvasStyleFailure(error, '提交结果未确认，请查询原图片请求，不要重新生成'); }
}
