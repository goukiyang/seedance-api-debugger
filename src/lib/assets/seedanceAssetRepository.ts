/**
 * SeedanceAssetRepository — 数据库持久化层
 * 替换 seedance-store.ts 的内存 Map
 * 重启后资产记录不丢失
 */

import { prisma } from '@/lib/prisma';
import { LocalAssetRecord } from '@/lib/provider/seedance-assets-types';
import { createdPageOrder, type CreatedPageRequest } from '@/lib/pagination/created-page';

function visibleSeedanceWhere(includeDeleted: boolean, ownerId: string, adminQuarantine: boolean) {
  return { ...(adminQuarantine ? {} : { owner_id: ownerId, ownership_status: 'owned' }),
    ...(includeDeleted ? {} : { local_status: { notIn: ['Deleted', 'ProviderDeleted'] } }) };
}

// DB record → API response 格式转换
function toApiRecord(r: {
  id: string;
  owner_id: string | null;
  ownership_status: string;
  provider: string;
  provider_asset_id: string;
  asset_type: string;
  name: string;
  original_url: string;
  provider_preview_url: string | null;
  provider_status: string | null;
  local_status: string;
  raw_provider_response: string | null;
  last_synced_at: Date | null;
  deleted_at: Date | null;
  provider_deleted_at: Date | null;
  delete_error: string | null;
  group_id: string | null;
  project_name: string | null;
  file_hash: string | null;
  storage_provider: string | null;
  storage_key: string | null;
  created_at: Date;
  updated_at: Date;
}): LocalAssetRecord {
  return {
    localId: r.id,
    ownerId: r.owner_id,
    ownershipStatus: r.ownership_status,
    provider: r.provider as 'seedance',
    providerAssetId: r.provider_asset_id,
    assetType: r.asset_type as 'Image' | 'Video' | 'Audio',
    name: r.name,
    originalUrl: r.original_url,
    providerPreviewUrl: r.provider_preview_url ?? '',
    providerStatus: r.provider_status ?? '',
    status: r.local_status as LocalAssetRecord['status'],
    rawProviderResponse: r.raw_provider_response ?? '',
    deletedAt: r.deleted_at?.toISOString() ?? '',
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export const seedanceAssetRepository = {
  /** 创建记录 */
  async create(data: {
    ownerId: string;
    providerAssetId: string;
    assetType: string;
    name: string;
    originalUrl: string;
    providerPreviewUrl?: string;
    providerStatus?: string;
    rawProviderResponse?: string;
  }): Promise<LocalAssetRecord> {
    const record = await prisma.seedanceAsset.create({
      data: {
        owner_id: data.ownerId,
        ownership_status: 'owned',
        provider: 'seedance',
        provider_asset_id: data.providerAssetId,
        asset_type: data.assetType,
        name: data.name,
        original_url: data.originalUrl,
        provider_preview_url: data.providerPreviewUrl ?? null,
        provider_status: data.providerStatus ?? null,
        local_status: 'Active',
        raw_provider_response: data.rawProviderResponse ?? null,
        last_synced_at: null,
        deleted_at: null,
        provider_deleted_at: null,
        delete_error: null,
        group_id: null,
        project_name: null,
      },
    });
    return toApiRecord(record);
  },

  /** 按本地 id 获取 */
  async get(localId: string): Promise<LocalAssetRecord | null> {
    const record = await prisma.seedanceAsset.findUnique({ where: { id: localId } });
    return record ? toApiRecord(record) : null;
  },

  /** 按 providerAssetId 获取 */
  async getByProviderId(providerAssetId: string): Promise<LocalAssetRecord | null> {
    const record = await prisma.seedanceAsset.findFirst({
      where: { provider_asset_id: providerAssetId },
    });
    return record ? toApiRecord(record) : null;
  },

  /** 列出记录（默认过滤已删除） */
  async list(includeDeleted = false, ownerId?: string, adminQuarantine = false): Promise<LocalAssetRecord[]> {
    if (!ownerId) return [];
    const records = await prisma.seedanceAsset.findMany({
      where: visibleSeedanceWhere(includeDeleted, ownerId, adminQuarantine),
      orderBy: createdPageOrder,
      take: 100,
    });
    return records.map(toApiRecord);
  },

  async listPage(paging: CreatedPageRequest, includeDeleted: boolean, ownerId: string, adminQuarantine = false) {
    if (!ownerId) { paging.assertAnchor(null); return { records: [], pagination: paging.finish([], 0).pagination }; }
    const where = visibleSeedanceWhere(includeDeleted, ownerId, adminQuarantine);
    if (paging.anchor) paging.assertAnchor(await prisma.seedanceAsset.findFirst({ where: { AND: [where, paging.anchor] }, select: { id: true } }));
    const total = await prisma.seedanceAsset.count({ where });
    const records = await prisma.seedanceAsset.findMany({ where: paging.anchor ? { AND: [where, paging.seek] } : where,
      orderBy: createdPageOrder, skip: paging.skip, take: paging.take });
    const result = paging.finish(records, total);
    return { records: result.items.map(toApiRecord), pagination: result.pagination };
  },

  /** 按 localId 更新（同步官方详情用） */
  async update(
    localId: string,
    patch: {
      name?: string;
      providerPreviewUrl?: string;
      providerStatus?: string;
      rawProviderResponse?: string;
      lastSyncedAt?: Date;
      groupId?: string;
      projectName?: string;
    }
  ): Promise<LocalAssetRecord | null> {
    const record = await prisma.seedanceAsset.update({
      where: { id: localId },
      data: {
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.providerPreviewUrl !== undefined && { provider_preview_url: patch.providerPreviewUrl }),
        ...(patch.providerStatus !== undefined && { provider_status: patch.providerStatus }),
        ...(patch.rawProviderResponse !== undefined && { raw_provider_response: patch.rawProviderResponse }),
        ...(patch.lastSyncedAt !== undefined && { last_synced_at: patch.lastSyncedAt }),
        ...(patch.groupId !== undefined && { group_id: patch.groupId }),
        ...(patch.projectName !== undefined && { project_name: patch.projectName }),
      },
    });
    return toApiRecord(record);
  },

  /** 按 providerAssetId 更新 */
  async updateByProviderId(
    providerAssetId: string,
    patch: Parameters<typeof this.update>[1]
  ): Promise<LocalAssetRecord | null> {
    const existing = await this.getByProviderId(providerAssetId);
    if (!existing) return null;
    return this.update(existing.localId, patch);
  },

  /** 本地软删除（不删官方） */
  async softDelete(localId: string): Promise<LocalAssetRecord | null> {
    const record = await prisma.seedanceAsset.update({
      where: { id: localId },
      data: { local_status: 'Deleted', deleted_at: new Date() },
    });
    return toApiRecord(record);
  },

  /** 官方彻底删除（成功） */
  async markProviderDeleted(localId: string): Promise<LocalAssetRecord | null> {
    const record = await prisma.seedanceAsset.update({
      where: { id: localId },
      data: { local_status: 'ProviderDeleted', provider_deleted_at: new Date() },
    });
    return toApiRecord(record);
  },

  /** 官方删除失败 */
  async markDeleteFailed(localId: string, error: string): Promise<LocalAssetRecord | null> {
    const record = await prisma.seedanceAsset.update({
      where: { id: localId },
      data: { local_status: 'DeleteFailed', delete_error: error },
    });
    return toApiRecord(record);
  },

  /** 统计 */
  async count(includeDeleted = false, ownerId?: string, adminQuarantine = false): Promise<number> {
    if (!ownerId) return 0;
    const where = visibleSeedanceWhere(includeDeleted, ownerId, adminQuarantine);
    return prisma.seedanceAsset.count({ where });
  },

  // ============================================================================
  // 去重查询（只查 Active）
  // ============================================================================

  /** 按 fileHash 查找 Active 资产 */
  async findActiveByFileHash(fileHash: string, ownerId: string): Promise<LocalAssetRecord | null> {
    const record = await prisma.seedanceAsset.findFirst({
      where: {
        file_hash: fileHash,
        owner_id: ownerId, ownership_status: 'owned',
        local_status: 'Active',
        provider: 'seedance',
      },
    });
    return record ? toApiRecord(record) : null;
  },

  /** 按 originalUrl 查找 Active 资产 */
  async findActiveByOriginalUrl(originalUrl: string, ownerId: string): Promise<LocalAssetRecord | null> {
    const record = await prisma.seedanceAsset.findFirst({
      where: {
        original_url: originalUrl,
        owner_id: ownerId, ownership_status: 'owned',
        local_status: 'Active',
        provider: 'seedance',
      },
    });
    return record ? toApiRecord(record) : null;
  },

  /** 按 storageProvider + storageKey 查找 Active 资产 */
  async findActiveByStorageKey(storageProvider: string, storageKey: string, ownerId: string): Promise<LocalAssetRecord | null> {
    const record = await prisma.seedanceAsset.findFirst({
      where: {
        storage_provider: storageProvider,
        owner_id: ownerId, ownership_status: 'owned',
        storage_key: storageKey,
        local_status: 'Active',
        provider: 'seedance',
      },
    });
    return record ? toApiRecord(record) : null;
  },

  // ============================================================================
  // 带存储元数据的创建
  // ============================================================================

  /** 创建记录（带存储元数据） */
  async createWithStorageMetadata(data: {
    ownerId: string;
    providerAssetId: string;
    assetType: string;
    name: string;
    originalUrl: string;
    providerPreviewUrl?: string;
    providerStatus?: string;
    rawProviderResponse?: string;
    fileHash?: string;
    storageProvider?: string;
    storageKey?: string;
  }): Promise<LocalAssetRecord> {
    const record = await prisma.seedanceAsset.create({
      data: {
        owner_id: data.ownerId,
        ownership_status: 'owned',
        provider: 'seedance',
        provider_asset_id: data.providerAssetId,
        asset_type: data.assetType,
        name: data.name,
        original_url: data.originalUrl,
        provider_preview_url: data.providerPreviewUrl ?? null,
        provider_status: data.providerStatus ?? null,
        local_status: 'Active',
        raw_provider_response: data.rawProviderResponse ?? null,
        last_synced_at: null,
        deleted_at: null,
        provider_deleted_at: null,
        delete_error: null,
        group_id: null,
        project_name: null,
        file_hash: data.fileHash ?? null,
        storage_provider: data.storageProvider ?? null,
        storage_key: data.storageKey ?? null,
      },
    });
    return toApiRecord(record);
  },
};
