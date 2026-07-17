/**
 * POST /api/workspace/assets
 * 添加素材到工作区
 *
 * body: { assetId, role? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getOrCreateWorkspace, addAssetToWorkspace } from '@/lib/assets/workspace';
import { getSession } from '@/lib/auth/session';
import { assertCanUseReferenceImage, uniquePreserveOrder } from '@/lib/reference-albums/permissions';
import {
  attachAssetToSiteReferenceImage,
  ReferenceImportError,
} from '@/lib/assets/reference-import';
import { ensureSiteAssetPublicUrl } from '@/lib/assets/site-upload';

function referenceRoleForAssetType(type: string | null | undefined, requestedRole?: string | null) {
  if (type === 'video') return 'reference_video';
  if (type === 'audio') return 'reference_audio';
  if (requestedRole === 'first_frame' || requestedRole === 'last_frame' || requestedRole === 'reference_image') {
    return requestedRole;
  }
  return 'reference_image';
}

async function ensureNonImageAssetReadyForGeneration(assetId: string, type: string | null | undefined) {
  if (type !== 'video' && type !== 'audio') return;
  const result = await ensureSiteAssetPublicUrl(assetId);
  if (!result.isPubliclyReachable) {
    throw new ReferenceImportError(
      '参考视频/音频必须是公网可访问 URL，请重新上传素材或配置 R2/TOS 存储。',
      400,
      'reference_media_url_not_public',
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json();
    const { assetId, role } = body;
    const shouldReplace = body.replace === true;
    const assetIds = uniquePreserveOrder(
      Array.isArray(body.assetIds)
        ? body.assetIds
        : Array.isArray(body.asset_ids)
          ? body.asset_ids
          : (assetId ? [assetId] : []),
    );
    const referenceImageIds = uniquePreserveOrder(
      Array.isArray(body.referenceImageIds)
        ? body.referenceImageIds
        : Array.isArray(body.reference_image_ids)
          ? body.reference_image_ids
          : (body.referenceImageId || body.reference_image_id ? [body.referenceImageId || body.reference_image_id] : []),
    );

    const tabId = request.headers.get('x-tab-id') || 'default';
    const { id: workspaceId } = await getOrCreateWorkspace(tabId, user.id);

    if (shouldReplace && assetIds.length === 0 && referenceImageIds.length === 0) {
      await prisma.workspaceAsset.deleteMany({ where: { workspace_id: workspaceId } });
      return NextResponse.json({ success: true, workspaceAssetIds: [], workspaceId });
    }

    if (assetIds.length === 0 && referenceImageIds.length === 0) {
      return NextResponse.json({ error: 'assetId required' }, { status: 400 });
    }

    if (referenceImageIds.length > 0) {
      if (shouldReplace) {
        await prisma.workspaceAsset.deleteMany({ where: { workspace_id: workspaceId } });
      }
      const existingCount = await prisma.workspaceAsset.count({ where: { workspace_id: workspaceId } });
      if (existingCount + referenceImageIds.length > 9) {
        return NextResponse.json({ error: '单次生成最多选择 9 个参考素材' }, { status: 400 });
      }

      const workspaceAssetIds: string[] = [];
      for (const referenceImageId of referenceImageIds) {
        const image = await assertCanUseReferenceImage(user, referenceImageId);
        if (!image.asset_id) {
          return NextResponse.json({ error: `参考图缺少资产记录: ${referenceImageId}` }, { status: 400 });
        }
        await ensureNonImageAssetReadyForGeneration(image.asset_id, image.asset?.type);
        const waId = await addAssetToWorkspace(
          workspaceId,
          image.asset_id,
          referenceRoleForAssetType(image.asset?.type, role),
          user.id,
          { referenceImageId: image.id, allowSharedAsset: true },
        );
        workspaceAssetIds.push(waId);
      }

      return NextResponse.json({ success: true, workspaceAssetIds, workspaceId });
    }

    if (shouldReplace) {
      await prisma.workspaceAsset.deleteMany({ where: { workspace_id: workspaceId } });
    }

    const existingWorkspaceAssets = await prisma.workspaceAsset.findMany({
      where: { workspace_id: workspaceId, asset_id: { in: assetIds } },
      select: { asset_id: true },
    });
    const existingAssetIdSet = new Set(existingWorkspaceAssets.map((item) => item.asset_id));
    const existingCount = await prisma.workspaceAsset.count({ where: { workspace_id: workspaceId } });
    const newAssetCount = assetIds.filter((id) => !existingAssetIdSet.has(id)).length;
    if (existingCount + newAssetCount > 9) {
      return NextResponse.json({ error: '单次生成最多选择 9 个参考素材' }, { status: 400 });
    }

    const workspaceAssetIds: string[] = [];
    const referenceImageIdsFromAssets: string[] = [];

    for (const currentAssetId of assetIds) {
      const asset = await prisma.asset.findFirst({
        where: { id: currentAssetId, status: { not: 'deleted' } },
        select: { id: true, type: true },
      });
      if (!asset) {
        return NextResponse.json({ error: 'Asset not found or permission denied' }, { status: 404 });
      }

      if (asset.type === 'image') {
        const reference = await attachAssetToSiteReferenceImage(
          {
            user,
            workspaceId,
            sourceLabel: 'Web UI',
            role: referenceRoleForAssetType(asset.type, role),
            albumName: '生成工作台参考图',
            albumDescription: '生成工作台自动归档的参考图',
            metadataSource: 'workspace_upload',
          },
          asset.id,
        );
        workspaceAssetIds.push(reference.workspaceAssetId);
        referenceImageIdsFromAssets.push(reference.referenceImageId);
      } else {
        await ensureNonImageAssetReadyForGeneration(asset.id, asset.type);
        const waId = await addAssetToWorkspace(workspaceId, asset.id, referenceRoleForAssetType(asset.type, role), user.id);
        workspaceAssetIds.push(waId);
      }
    }

    return NextResponse.json({
      success: true,
      workspaceAssetId: workspaceAssetIds[0] || null,
      workspaceAssetIds,
      referenceImageId: referenceImageIdsFromAssets[0] || null,
      referenceImageIds: referenceImageIdsFromAssets,
      workspaceId,
    });
  } catch (error) {
    if (error instanceof ReferenceImportError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    }
    console.error('[AddAssetToWorkspace] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 }
    );
  }
}
