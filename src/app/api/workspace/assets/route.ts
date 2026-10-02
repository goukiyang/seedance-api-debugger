/**
 * POST /api/workspace/assets
 * 添加素材到工作区
 *
 * body: { assetId, role? }
 */

import { NextRequest, NextResponse } from 'next/server';
import type { Asset } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getOrCreateWorkspace, addAssetToWorkspace } from '@/lib/assets/workspace';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertCanUseReferenceImage, uniquePreserveOrder } from '@/lib/reference-albums/permissions';
import {
  attachAssetToSiteReferenceImage,
  ReferenceImportError,
} from '@/lib/assets/reference-import';
import { ensureSiteAssetPublicUrl } from '@/lib/assets/site-upload';
import { recordAssetUploadLog } from '@/lib/assets/upload-log';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';

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
  const startedAt = Date.now();
  let userId: string | null = null;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    userId = user.id;

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

    // Validate the complete selection and prepare external URLs before taking
    // the write lock. No workspace changes happen until every input is ready.
    const references: Array<Awaited<ReturnType<typeof assertCanUseReferenceImage>>> = [];
    for (const referenceImageId of referenceImageIds) {
      const image = await assertCanUseReferenceImage(user, referenceImageId);
      if (!image.asset_id || !image.asset || image.asset.status === 'deleted') {
        throw new ReferenceImportError(`参考素材不可用: ${referenceImageId}`, 400, 'reference_asset_unavailable');
      }
      await ensureNonImageAssetReadyForGeneration(image.asset_id, image.asset.type);
      references.push(image);
    }
    const assets: Asset[] = [];
    for (const currentAssetId of assetIds) {
      const asset = await prisma.asset.findFirst({
        where: { id: currentAssetId, status: { not: 'deleted' } },
      });
      if (!asset) {
        throw new ReferenceImportError('素材不存在或已删除', 404, 'reference_asset_not_found');
      }
      const canUseOwnedAsset = asset.owner_id === user.id || (asset.type === 'image' && user.role === 'admin');
      if (!canUseOwnedAsset || !await canReadStudioAsset(user, asset)) {
        throw new ReferenceImportError('无权使用此素材', 403, 'reference_asset_forbidden');
      }
      await ensureNonImageAssetReadyForGeneration(asset.id, asset.type);
      assets.push(asset);
    }

    const { workspaceAssetIds, referenceImageIdsFromAssets } = await prisma.$transaction(async (tx) => {
      if (shouldReplace) await tx.workspaceAsset.deleteMany({ where: { workspace_id: workspaceId } });
      const workspaceAssetIds: string[] = [];
      const referenceImageIdsFromAssets: string[] = [];
      const mountedAssetIds = new Set<string>();
      for (const image of references) {
        const currentAssetId = image.asset_id!;
        if (mountedAssetIds.has(currentAssetId)) continue;
        workspaceAssetIds.push(await addAssetToWorkspace(
          workspaceId, currentAssetId, referenceRoleForAssetType(image.asset?.type, role), user.id,
          { referenceImageId: image.id, allowSharedAsset: true, db: tx },
        ));
        mountedAssetIds.add(currentAssetId);
      }
      for (const asset of assets) {
        if (mountedAssetIds.has(asset.id)) continue;
        if (asset.type === 'image') {
          const reference = await attachAssetToSiteReferenceImage({
            user, workspaceId, sourceLabel: 'Web UI',
            role: referenceRoleForAssetType(asset.type, role),
            albumName: '生成工作台参考图', albumDescription: '生成工作台自动归档的参考图',
            metadataSource: 'workspace_upload', db: tx,
          }, asset.id);
          workspaceAssetIds.push(reference.workspaceAssetId);
          referenceImageIdsFromAssets.push(reference.referenceImageId);
        } else {
          workspaceAssetIds.push(await addAssetToWorkspace(
            workspaceId, asset.id, referenceRoleForAssetType(asset.type, role), user.id, { db: tx },
          ));
        }
        mountedAssetIds.add(asset.id);
      }
      return { workspaceAssetIds, referenceImageIdsFromAssets };
    });

    await recordAssetUploadLog({
      operatorId: user.id,
      stage: 'mount',
      status: 'succeeded',
      assetId: assetIds[0] || referenceImageIds[0] || null,
      durationMs: Date.now() - startedAt,
      uploadMode: 'single',
      totalParts: workspaceAssetIds.length,
    });
    return NextResponse.json({
      success: true,
      workspaceAssetId: workspaceAssetIds[0] || null,
      workspaceAssetIds,
      referenceImageId: referenceImageIdsFromAssets[0] || null,
      referenceImageIds: referenceImageIdsFromAssets,
      workspaceId,
      count: workspaceAssetIds.length,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ReferenceImportError) {
      if (userId) {
        await recordAssetUploadLog({
          operatorId: userId,
          stage: 'mount',
          status: 'failed',
          durationMs: Date.now() - startedAt,
          errorCode: error.code,
          errorMessage: error.message,
        });
      }
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    }
    console.error('[AddAssetToWorkspace] Error:', error);
    if (userId) {
      await recordAssetUploadLog({
        operatorId: userId,
        stage: 'mount',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        errorCode: 'workspace_mount_failed',
        errorMessage: error instanceof Error ? error.message : 'Failed',
      });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 }
    );
  }
}
