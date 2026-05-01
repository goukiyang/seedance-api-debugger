/**
 * In-memory store for Seedance assets (Phase 1: no DB schema)
 * 进程内存储，重启后丢失，仅用于 MVP 闭环测试
 */

import { LocalAssetRecord } from '@/lib/provider/seedance-assets-types';

const store = new Map<string, LocalAssetRecord>();

let counter = 0;

function newLocalId(): string {
  counter++;
  return `local_${Date.now()}_${counter}`;
}

export const seedanceStore = {
  /** 创建记录 */
  create(data: Omit<LocalAssetRecord, 'localId' | 'createdAt' | 'updatedAt'>): LocalAssetRecord {
    const now = new Date().toISOString();
    const record: LocalAssetRecord = {
      ...data,
      localId: newLocalId(),
      createdAt: now,
      updatedAt: now,
    };
    store.set(record.localId, record);
    return record;
  },

  /** 获取记录 */
  get(localId: string): LocalAssetRecord | undefined {
    return store.get(localId);
  },

  /** 按 providerAssetId 获取 */
  getByProviderId(providerAssetId: string): LocalAssetRecord | undefined {
    for (const record of store.values()) {
      if (record.providerAssetId === providerAssetId) return record;
    }
    return undefined;
  },

  /** 列出所有记录（过滤已删除） */
  list(includeDeleted = false): LocalAssetRecord[] {
    const records = Array.from(store.values());
    if (!includeDeleted) {
      return records.filter((r) => r.status !== 'Deleted' && r.status !== 'ProviderDeleted');
    }
    return records;
  },

  /** 按 localId 更新 */
  update(localId: string, patch: Partial<Pick<LocalAssetRecord, 'name' | 'status' | 'providerPreviewUrl'>>): LocalAssetRecord | undefined {
    const existing = store.get(localId);
    if (!existing) return undefined;
    const updated: LocalAssetRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    store.set(localId, updated);
    return updated;
  },

  /** 按 providerAssetId 更新 */
  updateByProviderId(providerAssetId: string, patch: Partial<Pick<LocalAssetRecord, 'name' | 'status' | 'providerPreviewUrl'>>): LocalAssetRecord | undefined {
    for (const [localId, record] of store.entries()) {
      if (record.providerAssetId === providerAssetId) {
        const updated: LocalAssetRecord = {
          ...record,
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        store.set(localId, updated);
        return updated;
      }
    }
    return undefined;
  },

  /** 物理删除（彻底删除） */
  delete(localId: string): boolean {
    return store.delete(localId);
  },

  /** 统计 */
  count(includeDeleted = false): number {
    return this.list(includeDeleted).length;
  },
};
