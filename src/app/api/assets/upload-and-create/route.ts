/**
 * POST /api/assets/upload-and-create
 * 已上传 Asset + 自动创建 Seedance Asset
 *
 * 去重流程：
 *   1. 接收 assetId → 校验当前账号可用
 *   2. 确保 Asset URL 是公网可访问
 *   3. 按 Asset hash 查 Active 官方素材 → 命中则复用
 *   4. 否则调官方 /asset/create → 写入数据库
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { ensureSiteAssetPublicUrl } from '@/lib/assets/site-upload';
import { createAsset } from '@/lib/provider/seedance-assets';
import { seedanceAssetRepository } from '@/lib/assets/seedanceAssetRepository';
import { isPubliclyReachableUrl } from '@/lib/assets/public-storage';

export const runtime = 'nodejs';
export const maxDuration = 60;

const UPLOAD_AND_CREATE_PROVIDER_TIMEOUT_MS = 25_000;

type SeedanceUploadAssetType = 'Image' | 'Video' | 'Audio';

type UploadTypeConfig = {
  assetType: SeedanceUploadAssetType;
  label: string;
  mimeType: string;
  maxSize: number;
};

const MB = 1024 * 1024;

// 官方 /asset/create 通过 AssetType 区分 Image / Video / Audio；这里同时按 MIME 和扩展名兜底识别。
const UPLOAD_TYPES_BY_MIME: Record<string, UploadTypeConfig> = {
  'image/jpeg': { assetType: 'Image', label: 'jpg', mimeType: 'image/jpeg', maxSize: 10 * MB },
  'image/png': { assetType: 'Image', label: 'png', mimeType: 'image/png', maxSize: 10 * MB },
  'image/webp': { assetType: 'Image', label: 'webp', mimeType: 'image/webp', maxSize: 10 * MB },
  'video/mp4': { assetType: 'Video', label: 'mp4', mimeType: 'video/mp4', maxSize: 50 * MB },
  'video/quicktime': { assetType: 'Video', label: 'mov', mimeType: 'video/quicktime', maxSize: 50 * MB },
  'video/webm': { assetType: 'Video', label: 'webm', mimeType: 'video/webm', maxSize: 50 * MB },
  'audio/mpeg': { assetType: 'Audio', label: 'mp3', mimeType: 'audio/mpeg', maxSize: 50 * MB },
  'audio/wav': { assetType: 'Audio', label: 'wav', mimeType: 'audio/wav', maxSize: 50 * MB },
  'audio/ogg': { assetType: 'Audio', label: 'ogg', mimeType: 'audio/ogg', maxSize: 50 * MB },
};

const UPLOAD_TYPES_BY_EXTENSION: Record<string, UploadTypeConfig> = {
  jpg: UPLOAD_TYPES_BY_MIME['image/jpeg'],
  jpeg: UPLOAD_TYPES_BY_MIME['image/jpeg'],
  png: UPLOAD_TYPES_BY_MIME['image/png'],
  webp: UPLOAD_TYPES_BY_MIME['image/webp'],
  mp4: UPLOAD_TYPES_BY_MIME['video/mp4'],
  mov: UPLOAD_TYPES_BY_MIME['video/quicktime'],
  webm: UPLOAD_TYPES_BY_MIME['video/webm'],
  mp3: UPLOAD_TYPES_BY_MIME['audio/mpeg'],
  wav: UPLOAD_TYPES_BY_MIME['audio/wav'],
  ogg: UPLOAD_TYPES_BY_MIME['audio/ogg'],
};

const SUPPORTED_TYPE_LABELS = Array.from(
  new Set(Object.values(UPLOAD_TYPES_BY_MIME).map((item) => item.label))
).join(', ');

type UploadAndCreateBody = {
  assetId?: unknown;
  asset_id?: unknown;
  name?: unknown;
};

function resolveUploadTypeFromMetadata(mimeType: string | null | undefined, fileName: string | null | undefined): UploadTypeConfig | null {
  const normalizedMimeType = (mimeType || '').split(';')[0]?.trim().toLowerCase() || '';
  if (normalizedMimeType && UPLOAD_TYPES_BY_MIME[normalizedMimeType]) {
    return UPLOAD_TYPES_BY_MIME[normalizedMimeType];
  }

  const extension = (fileName || '').split('.').pop()?.toLowerCase();
  if (extension && UPLOAD_TYPES_BY_EXTENSION[extension]) {
    return UPLOAD_TYPES_BY_EXTENSION[extension];
  }

  return null;
}

function getAssetTypeLabel(assetType: SeedanceUploadAssetType): string {
  if (assetType === 'Image') return '图片';
  if (assetType === 'Video') return '视频';
  return '音频';
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
}

function safeLogDetails(details: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (key === 'publicUrl') {
      result.publicUrl = value ? '[redacted-url]' : null;
      continue;
    }
    if (key === 'storageKey') {
      result.storageKeyPresent = Boolean(value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function jsonUploadAndCreateError(
  code: string,
  message: string,
  status: number,
  details: Record<string, unknown> = {},
) {
  console.error('[UploadAndCreate] Stage failed:', {
    code,
    message,
    ...safeLogDetails(details),
  });
  return NextResponse.json(
    {
      success: false,
      closedLoop: false,
      reused: false,
      code,
      error: message,
      message,
      ...details,
    },
    { status: safeUploadAndCreateHttpStatus(status) },
  );
}

function safeUploadAndCreateHttpStatus(status: number) {
  // Cloudflare 会把源站 502/503/504 替换成 HTML 错误页，前端就会再次看到
  // “Unexpected token '<'”。这些是应用内可解释失败，统一用 424 保留 JSON body。
  if (status >= 500) return 424;
  return status;
}

class ProviderCreateTimeoutError extends Error {
  constructor() {
    super('官方资产创建超时，请稍后重试。');
    this.name = 'ProviderCreateTimeoutError';
  }
}

async function withProviderTimeout<T>(operation: Promise<T>, timeoutMs = UPLOAD_AND_CREATE_PROVIDER_TIMEOUT_MS) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new ProviderCreateTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) {
    return jsonUploadAndCreateError('UNAUTHORIZED', '未登录，请重新登录后再上传素材。', 401);
  }

  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('multipart/form-data')) {
    return jsonUploadAndCreateError(
      'CURRENT_UPLOAD_ENTRYPOINT_UPGRADED',
      '素材上传入口已升级，请刷新页面后重试；如果仍出现，请重新登录。',
      400,
    );
  }

  let body: UploadAndCreateBody;
  try {
    body = await request.json();
  } catch (error) {
    return jsonUploadAndCreateError(
      'JSON_PARSE_FAILED',
      '素材创建请求格式错误，请刷新后重试。',
      400,
      { reason: errorMessage(error, 'json parse failed') },
    );
  }

  const assetId = typeof body.assetId === 'string'
    ? body.assetId.trim()
    : typeof body.asset_id === 'string'
      ? body.asset_id.trim()
      : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';

  if (!assetId) {
    return jsonUploadAndCreateError('NO_ASSET_ID', '没有收到素材 ID，请重新上传。', 400);
  }

  let assetRecord: {
    id: string;
    owner_id: string;
    type: string;
    original_url: string;
    thumbnail_url: string | null;
    file_name: string;
    mime_type: string;
    file_size: number;
    hash: string | null;
    status: string;
  } | null;
  try {
    assetRecord = await prisma.asset.findUnique({
      where: { id: assetId },
      select: {
        id: true,
        owner_id: true,
        type: true,
        original_url: true,
        thumbnail_url: true,
        file_name: true,
        mime_type: true,
        file_size: true,
        hash: true,
        status: true,
      },
    });
  } catch (error) {
    return jsonUploadAndCreateError(
      'ASSET_LOOKUP_FAILED',
      '素材读取失败，请稍后重试。',
      503,
      { reason: errorMessage(error, 'asset lookup failed') },
    );
  }

  if (!assetRecord || assetRecord.status !== 'active') {
    return jsonUploadAndCreateError('ASSET_NOT_FOUND', '素材不存在或已不可用，请重新上传。', 404);
  }

  if (user.role !== 'admin' && assetRecord.owner_id !== user.id) {
    return jsonUploadAndCreateError('ASSET_FORBIDDEN', '当前账号无权使用这个素材。', 403);
  }

  const uploadType = resolveUploadTypeFromMetadata(assetRecord.mime_type, assetRecord.file_name);
  if (!uploadType) {
    return jsonUploadAndCreateError(
      'UNSUPPORTED_FILE_TYPE',
      `不支持的文件类型：${assetRecord.mime_type || 'unknown'}。目前支持：${SUPPORTED_TYPE_LABELS}。`,
      400,
    );
  }

  if (assetRecord.file_size > uploadType.maxSize) {
    return jsonUploadAndCreateError(
      'FILE_TOO_LARGE',
      `${getAssetTypeLabel(uploadType.assetType)}过大：${(assetRecord.file_size / MB).toFixed(1)}MB，最大 ${uploadType.maxSize / MB}MB。`,
      400,
    );
  }

  let publicAsset: Awaited<ReturnType<typeof ensureSiteAssetPublicUrl>>;
  try {
    publicAsset = await ensureSiteAssetPublicUrl(assetRecord.id);
  } catch (error) {
    return jsonUploadAndCreateError(
      'ASSET_PUBLIC_URL_FAILED',
      `素材已上传，但准备公网地址失败：${errorMessage(error, 'public url failed')}`,
      503,
    );
  }

  const publicUrl = publicAsset.asset.original_url;
  const isPublic = publicAsset.isPubliclyReachable || isPubliclyReachableUrl(publicUrl);
  if (!isPublic) {
    return jsonUploadAndCreateError(
      'ASSET_URL_NOT_PUBLIC',
      publicAsset.publicUploadWarning || '当前 URL 不是公网可访问地址，Seedance 官方无法下载。',
      424,
      {
        storageProvider: publicAsset.storageProvider || 'asset',
        assetType: uploadType.assetType,
        publicUrl,
        size: assetRecord.file_size,
      },
    );
  }

  const fileHash = assetRecord.hash || null;
  const assetName = name || assetRecord.file_name || 'Untitled';

  if (fileHash) {
    try {
      const existingByHash = await seedanceAssetRepository.findActiveByFileHash(fileHash);
      if (existingByHash) {
        return NextResponse.json({
          success: true,
          closedLoop: true,
          reused: true,
          reuseReason: 'FILE_HASH_MATCH',
          message: `已检测到相同${getAssetTypeLabel(uploadType.assetType)}，已复用已有资产。`,
          storageProvider: existingByHash.provider,
          assetType: uploadType.assetType,
          asset: existingByHash,
          providerAssetId: existingByHash.providerAssetId,
        });
      }
    } catch (error) {
      return jsonUploadAndCreateError(
        'DB_LOOKUP_FAILED',
        '素材去重检查失败，请稍后重试。',
        503,
        { reason: errorMessage(error, 'database lookup failed') },
      );
    }
  }

  try {
    const existingByUrl = await seedanceAssetRepository.findActiveByOriginalUrl(publicUrl);
    if (existingByUrl) {
      return NextResponse.json({
        success: true,
        closedLoop: true,
        reused: true,
        reuseReason: 'ORIGINAL_URL_MATCH',
        message: '已检测到相同素材地址，已复用已有资产。',
        storageProvider: publicAsset.storageProvider || 'asset',
        assetType: uploadType.assetType,
        asset: existingByUrl,
        providerAssetId: existingByUrl.providerAssetId,
      });
    }
  } catch (error) {
    return jsonUploadAndCreateError(
      'DB_LOOKUP_FAILED',
      '素材地址去重检查失败，请稍后重试。',
      503,
      { reason: errorMessage(error, 'database lookup failed') },
    );
  }

  // 调官方 /asset/create
  let createResult: Awaited<ReturnType<typeof createAsset>>;
  try {
    createResult = await withProviderTimeout(createAsset({
      assetType: uploadType.assetType,
      url: publicUrl,
      name: assetName,
    }));
  } catch (error) {
    const isTimeout = error instanceof ProviderCreateTimeoutError;
    return jsonUploadAndCreateError(
      isTimeout ? 'PROVIDER_CREATE_TIMEOUT' : 'PROVIDER_CREATE_FAILED',
      isTimeout
        ? '文件已上传成功，但官方 Seedance Asset 创建超时，请稍后重试创建。'
        : `官方 Seedance Asset 创建失败：${errorMessage(error, '未知错误')}`,
      isTimeout ? 504 : 502,
      {
        storageProvider: publicAsset.storageProvider || 'asset',
        assetType: uploadType.assetType,
        publicUrl,
        size: assetRecord.file_size,
        warning: publicAsset.publicUploadWarning,
      },
    );
  }

  if (createResult.error) {
    return jsonUploadAndCreateError(
      'PROVIDER_CREATE_FAILED',
      `官方 Seedance Asset 创建失败：${createResult.error}`,
      502,
      {
        storageProvider: publicAsset.storageProvider || 'asset',
        assetType: uploadType.assetType,
        publicUrl,
        size: assetRecord.file_size,
        warning: publicAsset.publicUploadWarning,
      },
    );
  }

  if (!createResult.data?.providerAssetId) {
    return jsonUploadAndCreateError(
      'PROVIDER_CREATE_FAILED',
      '官方 Seedance Asset 创建返回异常：没有素材 ID。',
      502,
      {
        storageProvider: publicAsset.storageProvider || 'asset',
        assetType: uploadType.assetType,
        publicUrl,
        size: assetRecord.file_size,
        warning: publicAsset.publicUploadWarning,
      },
    );
  }

  // 写入数据库（复用 Asset 元数据）
  try {
    const record = await seedanceAssetRepository.createWithStorageMetadata({
      providerAssetId: createResult.data!.providerAssetId,
      assetType: uploadType.assetType,
      name: assetName,
      originalUrl: publicUrl,
      rawProviderResponse: JSON.stringify(createResult.data!.rawResponse),
      ...(fileHash ? { fileHash } : {}),
      storageProvider: publicAsset.storageProvider || 'asset',
      storageKey: assetRecord.id,
    });

    return NextResponse.json({
      success: true,
      closedLoop: true,
      reused: false,
      message: '上传成功，Seedance Asset 创建成功。',
      storageProvider: publicAsset.storageProvider || 'asset',
      assetType: uploadType.assetType,
      publicUrl,
      storageKey: assetRecord.id,
      size: assetRecord.file_size,
      asset: record,
      providerAssetId: createResult.data!.providerAssetId,
      warning: publicAsset.publicUploadWarning,
    });
  } catch (error) {
    return jsonUploadAndCreateError(
      'DB_CREATE_FAILED',
      '官方 Seedance Asset 已创建，但本地素材登记失败，请稍后刷新素材列表或联系管理员处理。',
      503,
      {
        reason: errorMessage(error, 'database create failed'),
        storageProvider: publicAsset.storageProvider || 'asset',
        assetType: uploadType.assetType,
        publicUrl,
        storageKey: assetRecord.id,
        size: assetRecord.file_size,
        providerAssetId: createResult.data!.providerAssetId,
        warning: publicAsset.publicUploadWarning,
      },
    );
  }
}
