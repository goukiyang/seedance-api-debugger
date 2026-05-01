/**
 * 图片集（Collection）管理服务
 */

import { prisma } from '@/lib/prisma';
import { v4 as uuidv4 } from 'uuid';
import type { GenerationMode } from '@/types';

// ============================================================================
// Collection CRUD
// ============================================================================

export async function createCollection(
  name: string,
  workspaceId: string,
  options?: { description?: string; visibility?: string }
) {
  const collection = await prisma.assetCollection.create({
    data: {
      id: uuidv4(),
      owner_id: 'default-user',
      name,
      description: options?.description,
      visibility: options?.visibility ?? 'private',
    },
  });

  // 从 workspace 复制所有素材
  const workspaceAssets = await prisma.workspaceAsset.findMany({
    where: { workspace_id: workspaceId },
    include: { asset: true },
    orderBy: { sort_order: 'asc' },
  });

  if (workspaceAssets.length > 0) {
    await prisma.assetCollectionItem.createMany({
      data: workspaceAssets.map((wa) => ({
        id: uuidv4(),
        collection_id: collection.id,
        asset_id: wa.asset_id,
        sort_order: wa.sort_order,
        role: wa.role,
      })),
    });
  }

  return collection;
}

export async function getCollections() {
  return prisma.assetCollection.findMany({
    where: { owner_id: 'default-user' },
    include: {
      cover_asset: true,
      _count: { select: { items: true } },
    },
    orderBy: { updated_at: 'desc' },
  });
}

export async function getCollectionById(id: string) {
  return prisma.assetCollection.findUnique({
    where: { id },
    include: {
      items: {
        include: { asset: true },
        orderBy: { sort_order: 'asc' },
      },
      cover_asset: true,
    },
  });
}

export async function loadCollectionIntoWorkspace(
  collectionId: string,
  workspaceId: string
) {
  const collection = await prisma.assetCollection.findUnique({
    where: { id: collectionId },
    include: {
      items: {
        include: { asset: true },
        orderBy: { sort_order: 'asc' },
      },
    },
  });

  if (!collection) throw new Error('Collection not found');

  // 清空现有工作区
  await prisma.workspaceAsset.deleteMany({
    where: { workspace_id: workspaceId },
  });

  // 导入素材到工作区
  const items = collection.items.map((item, idx) => ({
    id: uuidv4(),
    workspace_id: workspaceId,
    asset_id: item.asset_id,
    sort_order: idx,
    role: item.role,
  }));

  if (items.length > 0) {
    await prisma.workspaceAsset.createMany({ data: items });
  }

  return { count: items.length };
}

export async function deleteCollection(id: string) {
  await prisma.assetCollection.delete({ where: { id } });
}

export async function updateCollection(
  id: string,
  data: { name?: string; description?: string; visibility?: string; cover_asset_id?: string }
) {
  return prisma.assetCollection.update({
    where: { id },
    data,
  });
}

// ============================================================================
// Prompt 渲染
// ============================================================================

export type AssetMapping = Record<string, string>; // { "图1": assetId, ... }

/**
 * 将用户输入的 prompt（含 图1 图2 图3）中的图号替换为说明文字
 * 本地相对路径无法被外部 provider 访问，因此 prompt 中不再放 URL
 * 参考图实际数据通过 content array 的 base64 data URL 传给 provider
 *
 * @param promptRaw 原始 prompt
 * @param workspaceId 工作区 ID
 * @param mode 生成模式
 * @returns { promptRendered, assetMapping }
 */
export async function renderPromptWithAssets(
  promptRaw: string,
  workspaceId: string,
  mode: GenerationMode
): Promise<{ promptRendered: string; assetMapping: AssetMapping }> {
  const workspaceAssets = await prisma.workspaceAsset.findMany({
    where: { workspace_id: workspaceId },
    include: { asset: true },
    orderBy: { sort_order: 'asc' },
  });

  if (workspaceAssets.length === 0) {
    return { promptRendered: promptRaw, assetMapping: {} };
  }

  const assetMapping: AssetMapping = {};

  // 按 sort_order 建立 图N -> assetId 映射
  workspaceAssets.forEach((wa, idx) => {
    const tuhao = `图${idx + 1}`;
    assetMapping[tuhao] = wa.asset_id;
    assetMapping[`(${tuhao})`] = wa.asset_id;
  });

  // 生成参考图说明（代替将图号替换为 URL）
  const roleDescriptions: Record<string, string> = {
    reference_image: '参考图',
    first_frame: '首帧图',
    last_frame: '尾帧图',
    reference_video: '参考视频',
    reference_audio: '参考音频',
  };
  const refDescParts = workspaceAssets.map((wa, idx) => {
    const roleLabel = roleDescriptions[wa.role ?? 'reference_image'] ?? '参考素材';
    return `图${idx + 1}（${roleLabel}）`;
  });
  const refDescription = `【参考素材说明】${refDescParts.join('、')}。`;

  // 替换 prompt 中的图号（改为保留文字说明，不放 URL）
  const tuhaoRegex = /图(\d+)/g;
  let promptRendered = promptRaw.replace(tuhaoRegex, (match, num) => {
    const idx = parseInt(num, 10) - 1;
    if (idx >= 0 && idx < workspaceAssets.length) {
      // 保留图号，但不放 URL（URL 在 content array 中）
      return match;
    }
    return `[图${num}❌不存在]`;
  });

  // 将参考图说明前置到 prompt
  promptRendered = `${refDescription}\n${promptRendered}`;

  return { promptRendered, assetMapping };
}

/**
 * 检测 prompt 中引用的图号是否存在
 * @returns { valid, missing } missing 为不存在的图号数组
 */
export async function validatePromptReferences(
  prompt: string,
  workspaceId: string
): Promise<{ valid: boolean; missing: string[] }> {
  const tuhaoRegex = /图(\d+)/g;
  const workspaceAssets = await prisma.workspaceAsset.findMany({
    where: { workspace_id: workspaceId },
    orderBy: { sort_order: 'asc' },
  });

  const missing: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = tuhaoRegex.exec(prompt)) !== null) {
    const idx = parseInt(match[1], 10) - 1;
    if (idx < 0 || idx >= workspaceAssets.length) {
      missing.push(`图${match[1]}`);
    }
  }

  return { valid: missing.length === 0, missing };
}
