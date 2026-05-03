/**
 * Workspace 管理工作台服务
 */

import { prisma } from '@/lib/prisma';
import { v4 as uuidv4 } from 'uuid';
import { guessFileNameFromUrl } from '@/lib/resources';

// ============================================================================
// Workspace 管理
// ============================================================================

/**
 * 获取或创建当前用户的活跃工作区
 * 每个浏览器 tab 有独立 workspace（通过 tabId 区分）
 */
export async function getOrCreateWorkspace(tabId: string): Promise<{ id: string }> {
  // 尝试查找现有 active workspace
  let workspace = await prisma.workspace.findFirst({
    where: {
      owner_id: 'default-user',
      status: 'active',
    },
    orderBy: { updated_at: 'desc' },
  });

  if (!workspace) {
    workspace = await prisma.workspace.create({
      data: {
        id: uuidv4(),
        owner_id: 'default-user',
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
    include: { asset: true },
    orderBy: { sort_order: 'asc' },
  });

  return {
    ...workspace,
    assets: workspaceAssets.map((wa) => ({
      id: wa.id,
      assetId: wa.asset.id,
      sortOrder: wa.sort_order,
      role: wa.role,
      type: wa.asset.type,
      originalUrl: wa.asset.original_url,
      thumbnailUrl: wa.asset.thumbnail_url,
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
  role?: string
): Promise<string> {
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

function guessMimeTypeFromUrl(url: string): string {
  const normalized = url.toLowerCase();
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.webp')) return 'image/webp';
  if (normalized.endsWith('.gif')) return 'image/gif';
  if (normalized.endsWith('.bmp')) return 'image/bmp';
  return 'image/jpeg';
}

export async function findOrCreateExternalImageAsset(params: {
  url: string;
  name: string;
  thumbnailUrl?: string | null;
}): Promise<string> {
  const existing = await prisma.asset.findFirst({
    where: {
      owner_id: 'default-user',
      type: 'image',
      original_url: params.url,
    },
    orderBy: { created_at: 'desc' },
  });

  if (existing) {
    return existing.id;
  }

  const asset = await prisma.asset.create({
    data: {
      id: uuidv4(),
      owner_id: 'default-user',
      type: 'image',
      original_url: params.url,
      thumbnail_url: params.thumbnailUrl ?? params.url,
      file_name: guessFileNameFromUrl(params.url, params.name),
      mime_type: guessMimeTypeFromUrl(params.url),
      width: null,
      height: null,
      file_size: 0,
      hash: null,
    },
  });

  return asset.id;
}
