/**
 * Workspace 管理工作台服务
 */

import { prisma } from '@/lib/prisma';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';

// ============================================================================
// Workspace 管理
// ============================================================================

function localUploadExists(url: string | null): boolean {
  if (!url || !url.startsWith('/uploads/')) return true;
  return fs.existsSync(path.join(process.cwd(), 'public', url.replace(/^\/+/, '')));
}

/**
 * 获取或创建当前用户的活跃工作区
 * 每个浏览器 tab 有独立 workspace（通过 tabId 区分）
 */
export async function getOrCreateWorkspace(tabId: string, ownerId = 'default-user'): Promise<{ id: string }> {
  // 尝试查找现有 active workspace
  let workspace = await prisma.workspace.findFirst({
    where: {
      owner_id: ownerId,
      status: 'active',
    },
    orderBy: { updated_at: 'desc' },
  });

  if (!workspace) {
    workspace = await prisma.workspace.create({
      data: {
        id: uuidv4(),
        owner_id: ownerId,
        name: '默认工作台',
        status: 'active',
      },
    });
  }

  return { id: workspace.id };
}

/**
 * 获取 workspace 及其所有素材（按 sort_order 排序）
 */
export async function getWorkspaceWithAssets(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
  });

  if (!workspace) return null;

  const workspaceAssets = await prisma.workspaceAsset.findMany({
    where: { workspace_id: workspaceId },
    include: {
      asset: true,
      reference_image: {
        include: {
          album: {
            select: { id: true, name: true, status: true },
          },
        },
      },
    },
    orderBy: { sort_order: 'asc' },
  });

  return {
    ...workspace,
    assets: workspaceAssets.map((wa) => ({
      id: wa.id,
      assetId: wa.asset.id,
      referenceImageId: wa.reference_image_id,
      referenceAlbumId: wa.reference_image?.album.status === 'active' ? wa.reference_image.album.id : null,
      referenceAlbumName: wa.reference_image?.album.status === 'active' ? wa.reference_image.album.name : null,
      sortOrder: wa.sort_order,
      role: wa.role,
      type: wa.asset.type,
      originalUrl: wa.asset.original_url,
      thumbnailUrl: localUploadExists(wa.asset.thumbnail_url) ? wa.asset.thumbnail_url : null,
      fileName: wa.asset.file_name,
      width: wa.asset.width,
      height: wa.asset.height,
      fileSize: wa.asset.file_size,
      mimeType: wa.asset.mime_type,
      createdAt: wa.asset.created_at,
    })),
  };
}

// ============================================================================
// Workspace 素材操作
// ============================================================================

/**
 * 添加素材到工作区
 */
export async function addAssetToWorkspace(
  workspaceId: string,
  assetId: string,
  role?: string,
  ownerId = 'default-user',
  options?: { referenceImageId?: string; allowSharedAsset?: boolean },
): Promise<string> {
  const asset = await prisma.asset.findFirst({
    where: options?.allowSharedAsset || ownerId === 'default-user'
      ? { id: assetId }
      : { id: assetId, owner_id: ownerId },
  });
  if (!asset) throw new Error('Asset not found or permission denied');

  // 检查是否已在工作区
  const existing = await prisma.workspaceAsset.findUnique({
    where: {
      workspace_id_asset_id: { workspace_id: workspaceId, asset_id: assetId },
    },
  });

  if (existing) {
    // 更新角色和排序
    const maxOrder = await prisma.workspaceAsset.aggregate({
      where: { workspace_id: workspaceId },
      _max: { sort_order: true },
    });
    await prisma.workspaceAsset.update({
      where: { id: existing.id },
      data: {
        sort_order: (maxOrder._max.sort_order ?? 0) + 1,
        role: role ?? existing.role,
        reference_image_id: options?.referenceImageId ?? existing.reference_image_id,
      },
    });
    return existing.id;
  }

  const maxOrder = await prisma.workspaceAsset.aggregate({
    where: { workspace_id: workspaceId },
    _max: { sort_order: true },
  });

  return prisma.workspaceAsset.create({
    data: {
      id: uuidv4(),
      workspace_id: workspaceId,
      asset_id: assetId,
      reference_image_id: options?.referenceImageId ?? null,
      sort_order: (maxOrder._max.sort_order ?? 0) + 1,
      role: role,
    },
  }).then((r) => r.id);
}

/**
 * 移除素材从工作区
 */
export async function removeAssetFromWorkspace(workspaceId: string, assetId: string) {
  await prisma.workspaceAsset.deleteMany({
    where: { workspace_id: workspaceId, asset_id: assetId },
  });
}

/**
 * 更新工作区素材排序
 * newOrder: [{assetId, sortOrder}]
 */
export async function updateWorkspaceAssetOrder(
  workspaceId: string,
  newOrder: Array<{ assetId: string; sortOrder: number; role?: string }>
) {
  await Promise.all(
    newOrder.map(({ assetId, sortOrder, role }) =>
      prisma.workspaceAsset.updateMany({
        where: { workspace_id: workspaceId, asset_id: assetId },
        data: { sort_order: sortOrder, ...(role ? { role } : {}) },
      })
    )
  );
}

/**
 * 清空工作区（但不删除 Asset 记录）
 */
export async function clearWorkspace(workspaceId: string) {
  await prisma.workspaceAsset.deleteMany({
    where: { workspace_id: workspaceId },
  });
}
