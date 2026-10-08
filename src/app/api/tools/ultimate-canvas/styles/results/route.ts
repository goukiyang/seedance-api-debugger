import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { validStudioModuleId } from '@/lib/image-studio/modules';
import { studioAssetUrl } from '@/lib/image-studio/media';
import { getOrCreateWorkspace } from '@/lib/assets/workspace';
import { attachAssetToSiteReferenceImage } from '@/lib/assets/reference-import';
import {
  assertCanvasStyleContext, canvasStyleBatchId, canvasStyleFailure, canvasStyleJson,
  parseCanvasStyleContext, readCanvasStyleJson, requireCanvasStyleUser,
} from '@/lib/canvas-style-bridge';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9-]{16,80}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireCanvasStyleUser();
    const body = await readCanvasStyleJson(request);
    const context = parseCanvasStyleContext(body);
    await assertCanvasStyleContext(user, context);

    const moduleId = typeof body.moduleId === 'string' ? body.moduleId : '';
    if (!validStudioModuleId(moduleId, user.id)) throw new AuthError('风格模板模块编号无效', 400);
    const studioModule = await prisma.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: user.id }, select: { id: true } });
    if (!studioModule) throw new AuthError('风格模板模块不存在或无权使用', 404);
    const requestId = typeof body.requestId === 'string' ? body.requestId : '';
    if (!REQUEST_ID_PATTERN.test(requestId)) throw new AuthError('生成请求编号无效', 400);
    const expectedBatchId = canvasStyleBatchId(user.id, requestId);
    if (body.batchId !== undefined && body.batchId !== null
      && (typeof body.batchId !== 'string' || body.batchId !== expectedBatchId)) {
      throw new AuthError('生成批次编号与请求不匹配', 400);
    }
    if (body.count !== undefined && (!Number.isInteger(body.count) || Number(body.count) < 1 || Number(body.count) > 8)) {
      throw new AuthError('生成张数无效', 400);
    }

    const tasks = await prisma.imageStudioTask.findMany({
      where: { owner_id: user.id, module_id: moduleId, batch_id: expectedBatchId, deleted_at: null },
      orderBy: { ordinal: 'asc' },
      select: { id: true, status: true, asset_id: true, error: true, ordinal: true },
    });
    if (!tasks.length) {
      return canvasStyleJson({ status: 'not_found', pending: false, assets: [], completedCount: 0, totalCount: 0 });
    }
    if (body.count !== undefined && Number(body.count) !== tasks.length) {
      throw new AuthError('生成批次数量与提交记录不匹配', 409);
    }

    const succeeded = tasks.filter(task => task.status === 'succeeded' && task.asset_id);
    const assetIds = succeeded.map(task => task.asset_id!).filter((id, index, list) => list.indexOf(id) === index);
    const assets = assetIds.length ? await prisma.asset.findMany({
      where: { id: { in: assetIds }, owner_id: user.id, status: 'active', type: 'image' },
      select: { id: true, width: true, height: true },
    }) : [];
    const assetById = new Map(assets.map(asset => [asset.id, asset]));
    const outputByAsset = new Map<string, {
      assetId: string; referenceImageId: string; workspaceAssetId: string;
      originalUrl: string; thumbnailUrl: string; width: number | null; height: number | null;
    }>();
    const outputErrors: string[] = [];

    if (assets.length) {
      const workspaceId = (await getOrCreateWorkspace(`ultimate-canvas:${context.projectId}:${context.cardId}`, user.id)).id;
      for (const task of succeeded) {
        const assetId = task.asset_id!;
        const asset = assetById.get(assetId);
        if (!asset) {
          outputErrors.push('有已完成图片当前不可用，请联系管理员。');
          continue;
        }
        try {
          const existingLink = await prisma.workspaceAsset.findUnique({
            where: { workspace_id_asset_id: { workspace_id: workspaceId, asset_id: assetId } },
            select: { id: true, reference_image_id: true },
          });
          let referenceImageId = '';
          let workspaceAssetId = '';
          if (existingLink?.reference_image_id) {
            const existingReference = await prisma.referenceImage.findFirst({
              where: { id: existingLink.reference_image_id, asset_id: assetId, status: 'active', album: { status: { not: 'deleted' } } },
              select: { id: true },
            });
            if (existingReference) {
              referenceImageId = existingReference.id;
              workspaceAssetId = existingLink.id;
            }
          }
          if (!referenceImageId) {
            const attached = await attachAssetToSiteReferenceImage({
              user,
              workspaceId,
              projectId: context.projectId,
              sourceRequestId: context.nodeId,
              sourceLabel: '无线画布风格库生成',
              role: 'reference_image',
              albumName: '无线画布上传素材',
              albumDescription: '无线画布上传并自动归档的参考素材',
              metadataSource: 'ultimate_canvas_style_gallery',
            }, assetId);
            referenceImageId = attached.referenceImageId;
            workspaceAssetId = attached.workspaceAssetId;
          }
          outputByAsset.set(assetId, {
            assetId,
            referenceImageId,
            workspaceAssetId,
            originalUrl: studioAssetUrl(assetId),
            thumbnailUrl: studioAssetUrl(assetId, true),
            width: asset.width,
            height: asset.height,
          });
        } catch {
          outputErrors.push('部分成功图片暂时未能加入当前素材区，查询时会继续尝试。');
        }
      }
    }

    const activeTasks = tasks.filter(task => task.status === 'queued' || task.status === 'running');
    const unconfirmedTasks = tasks.filter(task => !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(task.status));
    const attachmentPending = succeeded.some(task => !outputByAsset.has(task.asset_id!));
    const pending = activeTasks.length > 0 || unconfirmedTasks.length > 0 || attachmentPending;
    const completedCount = tasks.length - activeTasks.length - unconfirmedTasks.length;
    const succeededCount = tasks.filter(task => task.status === 'succeeded').length;
    const missingOutputCount = succeededCount - outputByAsset.size;
    if (missingOutputCount > 0) outputErrors.push('有已完成图片当前不可用或尚未加入素材区。');
    const taskErrors = tasks.filter(task => task.status !== 'succeeded' && task.error).map(task => task.error!.trim()).filter(Boolean);
    const errors = Array.from(new Set([...taskErrors, ...outputErrors])).join('\n').slice(0, 1200);
    const status = unconfirmedTasks.length > 0 ? 'unconfirmed' : pending
      ? (activeTasks.length > 0 && activeTasks.every(task => task.status === 'queued') ? 'queued' : 'running')
      : outputByAsset.size > 0 ? 'succeeded' : 'failed';
    const orderedAssets = succeeded.flatMap(task => {
      const result = task.asset_id ? outputByAsset.get(task.asset_id) : null;
      return result ? [result] : [];
    });

    return canvasStyleJson({
      status,
      pending,
      submission_unconfirmed: unconfirmedTasks.length > 0,
      assets: orderedAssets,
      ...(errors ? { error: errors } : {}),
      completedCount,
      totalCount: tasks.length,
    });
  } catch (error) {
    return canvasStyleFailure(error, '读取风格生成结果失败，请稍后重试');
  }
}
