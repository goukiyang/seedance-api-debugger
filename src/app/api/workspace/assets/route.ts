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

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json();
    const { assetId, role } = body;
    const shouldReplace = body.replace === true;
    const referenceImageIds = uniquePreserveOrder(
      Array.isArray(body.referenceImageIds)
        ? body.referenceImageIds
        : Array.isArray(body.reference_image_ids)
          ? body.reference_image_ids
          : (body.referenceImageId || body.reference_image_id ? [body.referenceImageId || body.reference_image_id] : []),
    );

    const tabId = request.headers.get('x-tab-id') || 'default';
    const { id: workspaceId } = await getOrCreateWorkspace(tabId, user.id);

    if (shouldReplace && !assetId && referenceImageIds.length === 0) {
      await prisma.workspaceAsset.deleteMany({ where: { workspace_id: workspaceId } });
      return NextResponse.json({ success: true, workspaceAssetIds: [], workspaceId });
    }

    if (!assetId && referenceImageIds.length === 0) {
      return NextResponse.json({ error: 'assetId required' }, { status: 400 });
    }

    if (referenceImageIds.length > 0) {
      if (shouldReplace) {
        await prisma.workspaceAsset.deleteMany({ where: { workspace_id: workspaceId } });
      }
      const existingCount = await prisma.workspaceAsset.count({ where: { workspace_id: workspaceId } });
      if (existingCount + referenceImageIds.length > 9) {
        return NextResponse.json({ error: '单次生成最多选择 9 张参考图' }, { status: 400 });
      }

      const workspaceAssetIds: string[] = [];
      for (const referenceImageId of referenceImageIds) {
        const image = await assertCanUseReferenceImage(user, referenceImageId);
        if (!image.asset_id) {
          return NextResponse.json({ error: `参考图缺少资产记录: ${referenceImageId}` }, { status: 400 });
        }
        const waId = await addAssetToWorkspace(
          workspaceId,
          image.asset_id,
          role || 'reference_image',
          user.id,
          { referenceImageId: image.id, allowSharedAsset: true },
        );
        workspaceAssetIds.push(waId);
      }

      return NextResponse.json({ success: true, workspaceAssetIds, workspaceId });
    }

    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
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
          role: role || 'reference_image',
          albumName: '生成工作台参考图',
          albumDescription: '生成工作台自动归档的参考图',
          metadataSource: 'workspace_upload',
        },
        asset.id,
      );
      return NextResponse.json({
        success: true,
        workspaceAssetId: reference.workspaceAssetId,
        referenceImageId: reference.referenceImageId,
        workspaceId,
      });
    }

    const waId = await addAssetToWorkspace(workspaceId, assetId, role, user.id);

    return NextResponse.json({ success: true, workspaceAssetId: waId, workspaceId });
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
