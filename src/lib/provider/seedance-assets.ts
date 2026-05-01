/**
 * Seedance Asset API Client
 * 封装官方 /asset/* 接口，所有请求走服务端，不暴露 apiKey
 *
 * Base URL: https://etc.seedance-api.net/server
 * 官方文档字段名使用 PascalCase
 */

import type { SeedanceAssetItem } from './seedance-assets-types';

// ============================================================================
// Environment
// ============================================================================

const SEEDANCE_API_KEY = process.env.SEEDANCE_API_KEY || '';
// 资产接口路径：/server/asset（注意：无 /api 前缀，与视频生成接口不同）
const ASSET_BASE_URL = 'https://etc.seedance-api.net/server/asset';

// ============================================================================
// HTTP Utility
// ============================================================================

interface ProviderResponse<T> {
  data?: T;
  error?: string;
  statusCode?: number;
}

async function providerRequest<T>(path: string, body: object): Promise<ProviderResponse<T> > {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    const res = await fetch(`${ASSET_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: SEEDANCE_API_KEY, ...body }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    const json = await res.json();

    if (!res.ok) {
      const msg = (json as Record<string, unknown>).error as string || (json.ResponseMetadata as Record<string, unknown>)?.errorMessage as string || `HTTP ${res.status}`;
      return { error: msg, statusCode: res.status };
    }

    return { data: json as T };
  } catch (err) {
    if (err instanceof Error) {
      return { error: err.name === 'AbortError' ? '请求超时（20s）' : err.message };
    }
    return { error: '未知错误' };
  }
}

// ============================================================================
// Asset Types (PascalCase matching official API)
// ============================================================================

interface CreateAssetRequest {
  AssetType: 'Image' | 'Video' | 'Audio';
  URL: string;
  Name: string;
}

interface CreateAssetResponse {
  ResponseMetadata: {
    RequestId: string;
    Action: string;
    Version: string;
    Service: string;
    Region: string;
  };
  Result: {
    Id: string; // asset-xxxx
  };
}

interface GetAssetResponse {
  ResponseMetadata: {
    RequestId: string;
    Action: string;
    Version: string;
    Service: string;
    Region: string;
  };
  Result: {
    Id: string;
    Name: string;
    URL: string;
    AssetType: string;
    GroupId: string;
    Status: string;
    CreateTime: string;
    UpdateTime: string;
    ProjectName: string;
  };
}

interface ListAssetsRequest {
  PageNumber?: number;
  PageSize?: number;
  Filter?: {
    Name?: string;
    AssetType?: string;
  };
}

interface ListAssetsResponse {
  ResponseMetadata: {
    RequestId: string;
    Action: string;
    Version: string;
    Service: string;
    Region: string;
  };
  Result: {
    Items: Array<{
      Id: string;
      Name: string;
      URL: string;
      AssetType: string;
      GroupId: string;
      Status: string;
      CreateTime: string;
      UpdateTime: string;
      ProjectName: string;
    }>;
    TotalCount: number;
    PageNumber: number;
    PageSize: number;
  };
}

interface UpdateAssetRequest {
  Id: string;
  Name?: string;
}

interface UpdateAssetResponse {
  ResponseMetadata: {
    RequestId: string;
    Action: string;
    Version: string;
    Service: string;
    Region: string;
  };
  Result: {
    Id: string;
  };
}

interface DeleteAssetResponse {
  ResponseMetadata: {
    RequestId: string;
    Action: string;
    Version: string;
    Service: string;
    Region: string;
  };
  Result: Record<string, never>;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * 创建资产
 * POST /asset/create
 */
export async function createAsset(params: {
  assetType: 'Image' | 'Video' | 'Audio';
  url: string;
  name: string;
}): Promise<ProviderResponse<{ providerAssetId: string; rawResponse: CreateAssetResponse }>> {
  const res = await providerRequest<CreateAssetResponse>('/create', {
    AssetType: params.assetType,
    URL: params.url,
    Name: params.name,
  });

  if (res.error) return { error: res.error };
  return {
    data: {
      providerAssetId: res.data!.Result.Id,
      rawResponse: res.data!,
    },
  };
}

/**
 * 查询资产详情
 * POST /asset/get
 */
export async function getAsset(params: {
  providerAssetId: string;
}): Promise<ProviderResponse<{ item: SeedanceAssetItem; rawResponse: GetAssetResponse }>> {
  const res = await providerRequest<GetAssetResponse>('/get', {
    Id: params.providerAssetId,
  });

  if (res.error) return { error: res.error };

  const item: SeedanceAssetItem = {
    providerAssetId: res.data!.Result.Id,
    name: res.data!.Result.Name,
    url: res.data!.Result.URL,
    assetType: res.data!.Result.AssetType,
    status: res.data!.Result.Status,
    createdAt: res.data!.Result.CreateTime,
    updatedAt: res.data!.Result.UpdateTime,
  };

  return { data: { item, rawResponse: res.data! } };
}

/**
 * 查询资产列表
 * POST /asset/list
 */
export async function listAssets(params?: {
  pageNumber?: number;
  pageSize?: number;
  nameFilter?: string;
}): Promise<ProviderResponse<{ items: SeedanceAssetItem[]; totalCount: number; rawResponse: ListAssetsResponse }>> {
  const res = await providerRequest<ListAssetsResponse>('/list', {
    PageNumber: params?.pageNumber ?? 1,
    PageSize: params?.pageSize ?? 20,
    Filter: params?.nameFilter ? { Name: params.nameFilter } : undefined,
  });

  if (res.error) return { error: res.error };

  const items: SeedanceAssetItem[] = res.data!.Result.Items.map((item) => ({
    providerAssetId: item.Id,
    name: item.Name,
    url: item.URL,
    assetType: item.AssetType,
    status: item.Status,
    createdAt: item.CreateTime,
    updatedAt: item.UpdateTime,
  }));

  return {
    data: {
      items,
      totalCount: res.data!.Result.TotalCount,
      rawResponse: res.data!,
    },
  };
}

/**
 * 修改资产名称
 * POST /asset/update
 */
export async function updateAsset(params: {
  providerAssetId: string;
  name: string;
}): Promise<ProviderResponse<{ rawResponse: UpdateAssetResponse }>> {
  const res = await providerRequest<UpdateAssetResponse>('/update', {
    Id: params.providerAssetId,
    Name: params.name,
  });

  if (res.error) return { error: res.error };
  return { data: { rawResponse: res.data! } };
}

/**
 * 删除官方资产
 * POST /asset/delete
 * 注意：这是真正删除官方资产，请确认后再调用
 */
export async function deleteAsset(params: {
  providerAssetId: string;
}): Promise<ProviderResponse<{ rawResponse: DeleteAssetResponse }>> {
  const res = await providerRequest<DeleteAssetResponse>('/delete', {
    Id: params.providerAssetId,
  });

  if (res.error) return { error: res.error };
  return { data: { rawResponse: res.data! } };
}
