/**
 * Seedance Asset 统一类型定义
 * 供 Client / API / 前端共享使用
 */

/** 官方返回的单个资产条目 */
export interface SeedanceAssetItem {
  providerAssetId: string; // 官方 Id，格式：asset-xxxx
  name: string;
  url: string; // 官方预览 URL（可能是临时签名链接，不要当永久地址）
  assetType: string; // Image / Video / Audio
  status: string; // Active / Deleted / Unknown
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/** 本地资产记录 */
export interface LocalAssetRecord {
  localId: string; // 本地唯一 ID
  provider: 'seedance'; // 固定为 seedance
  providerAssetId: string; // 官方 asset-xxxx
  assetType: 'Image' | 'Video' | 'Audio';
  name: string; // 资产名称
  originalUrl: string; // 用户提交的公网 URL
  providerPreviewUrl: string; // 官方查询返回的预览 URL
  status: 'Active' | 'Deleted' | 'ProviderDeleted' | 'DeleteFailed' | 'Unknown';
  rawProviderResponse: string; // JSON 原始返回
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}
