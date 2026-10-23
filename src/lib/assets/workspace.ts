/**
 * Workspace 管理工作台服务
 */

import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { sameOriginPublicUrlForSiteUpload, siteUploadPathFromUrl } from '@/lib/assets/site-url';

// ============================================================================
// Workspace 管理
// ============================================================================

function localUploadExists(url: string | null): boolean {
  const uploadPath = siteUploadPathFromUrl(url);
  if (!url || !uploadPath) return true;
  return fs.existsSync(path.join(process.cwd(), 'public', uploadPath.replace(/^\/+/, '')));
}

function publicAssetUrl(url: string | null) {
  return url ? (sameOriginPublicUrlForSiteUpload(url) || url) : null;
}

function workspaceNameForTab(tabId: string) {
  const normalized = typeof tabId === 'string' && tabId.trim()
    ? tabId.trim().slice(0, 96)
    : 'default';
  return `默认工作台:${normalized}`;
}

export function normalizeWorkspaceTabId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'default';
  if (value.length > 96 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('工作区标签标识无效');
  return value;
}
function workspaceBindingKey(tabId: string, ownerId: string) {
  return 'workspace_tab_binding_v1:' + createHash('sha256').update(JSON.stringify([ownerId, tabId])).digest('hex');
}
export async function readWorkspaceForTab(tabId: string, ownerId: string) {
  const normalized = normalizeWorkspaceTabId(tabId), key = workspaceBindingKey(normalized, ownerId);
  const binding = await prisma.platformSetting.findUnique({ where: { key } });
  if (binding) {
    const value = JSON.parse(binding.value_json);
    if (value.version !== 1 || value.ownerId !== ownerId || value.tabId !== normalized || typeof value.workspaceId !== 'string')
      throw new Error('工作区绑定无法确认，请保留当前输入');
    const workspace = await prisma.workspace.findFirst({ where: { id: value.workspaceId, owner_id: ownerId, status: 'active', name: workspaceNameForTab(normalized) } });
    if (!workspace) throw new Error('原工作区已失效，未切换到其它工作区');
    return { id: workspace.id };
  }
  return prisma.workspace.findFirst({ where: { owner_id: ownerId, status: 'active', name: workspaceNameForTab(normalized) },
    orderBy: [{ updated_at: 'desc' }, { id: 'asc' }], select: { id: true } });
}

/**
 * 获取或创建当前用户的活跃工作区
 * 每个浏览器 tab 有独立 workspace（通过 tabId 区分）
 */
export async function getOrCreateWorkspace(tabId: string, ownerId = 'default-user'): Promise<{ id: string }> {
  const normalized = normalizeWorkspaceTabId(tabId), key = workspaceBindingKey(normalized, ownerId);
  const existing = await readWorkspaceForTab(normalized, ownerId);
  if (existing && await prisma.platformSetting.findUnique({ where: { key }, select: { id: true } })) return existing;
  try {
    if (existing) {
      await prisma.platformSetting.create({ data: { key, updated_by: ownerId,
        value_json: JSON.stringify({ version: 1, ownerId, tabId: normalized, workspaceId: existing.id }) } });
      return existing;
    }
    return await prisma.$transaction(async db => {
      const prior = await db.workspace.findFirst({ where: { owner_id: ownerId, status: 'active', name: workspaceNameForTab(normalized) },
        orderBy: [{ updated_at: 'desc' }, { id: 'asc' }], select: { id: true } });
      const workspace = prior || await db.workspace.create({ data: { id: uuidv4(), owner_id: ownerId,
        name: workspaceNameForTab(normalized), status: 'active' }, select: { id: true } });
      await db.platformSetting.create({ data: { key, updated_by: ownerId,
        value_json: JSON.stringify({ version: 1, ownerId, tabId: normalized, workspaceId: workspace.id }) } });
      return workspace;
    });
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
    const winner = await readWorkspaceForTab(normalized, ownerId);
    if (!winner) throw error;
    return winner;
  }
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
    assets: workspaceAssets.map((wa) => {
      const originalUrl = publicAssetUrl(wa.asset.original_url) || wa.asset.original_url;
      const thumbnailUrl = localUploadExists(wa.asset.thumbnail_url)
        ? publicAssetUrl(wa.asset.thumbnail_url)
        : null;
      return {
        id: wa.id,
        assetId: wa.asset.id,
        referenceImageId: wa.reference_image_id,
        referenceAlbumId: wa.reference_image?.album.status === 'active' ? wa.reference_image.album.id : null,
        referenceAlbumName: wa.reference_image?.album.status === 'active' ? wa.reference_image.album.name : null,
        sortOrder: wa.sort_order,
        role: wa.role,
        type: wa.asset.type,
        originalUrl,
        thumbnailUrl,
        fileName: wa.asset.file_name,
        width: wa.asset.width,
        height: wa.asset.height,
        fileSize: wa.asset.file_size,
        mimeType: wa.asset.mime_type,
        createdAt: wa.asset.created_at,
      };
    }),
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
  options?: { referenceImageId?: string; allowSharedAsset?: boolean; db?: Prisma.TransactionClient },
): Promise<string> {
  const db = options?.db || prisma;
  const asset = await db.asset.findFirst({
    where: options?.allowSharedAsset || ownerId === 'default-user'
      ? { id: assetId, status: { not: 'deleted' } }
      : { id: assetId, owner_id: ownerId, status: { not: 'deleted' } },
  });
  if (!asset) throw new Error('Asset not found or permission denied');

  // 检查是否已在工作区
  const existing = await db.workspaceAsset.findUnique({
    where: {
      workspace_id_asset_id: { workspace_id: workspaceId, asset_id: assetId },
    },
  });

  if (existing) {
    // 更新角色和排序
    const maxOrder = await db.workspaceAsset.aggregate({
      where: { workspace_id: workspaceId },
      _max: { sort_order: true },
    });
    await db.workspaceAsset.update({
      where: { id: existing.id },
      data: {
        sort_order: (maxOrder._max.sort_order ?? 0) + 1,
        role: role ?? existing.role,
        reference_image_id: options?.referenceImageId ?? existing.reference_image_id,
      },
    });
    return existing.id;
  }

  const maxOrder = await db.workspaceAsset.aggregate({
    where: { workspace_id: workspaceId },
    _max: { sort_order: true },
  });

  return db.workspaceAsset.upsert({
    where: { workspace_id_asset_id: { workspace_id: workspaceId, asset_id: assetId } },
    create: {
      id: uuidv4(),
      workspace_id: workspaceId,
      asset_id: assetId,
      reference_image_id: options?.referenceImageId ?? null,
      sort_order: (maxOrder._max.sort_order ?? 0) + 1,
      role: role,
    },
    // Only the caller's explicit target intent may change the concurrent winner.
    update: { ...(role !== undefined ? { role } : {}), ...(options?.referenceImageId ? { reference_image_id: options.referenceImageId } : {}) },
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
