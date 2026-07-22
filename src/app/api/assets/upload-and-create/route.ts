/**
 * POST /api/assets/upload-and-create
 * 本地上传 + 公网存储 + 自动创建 Seedance Asset
 *
 * 去重流程：
 *   1. 接收文件 → 计算 sha256 fileHash
 *   2. 按 fileHash 查 Active 资产 → 命中则复用
 *   3. 否则上传 R2/TOS → 得 publicUrl
 *   4. 按 storageProvider+storageKey 查 Active 资产 → 命中则复用（同一 R2 key）
 *   5. 否则调官方 /asset/create → 写入数据库（带存储元数据）
 */

import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { getSession } from '@/lib/auth/session';
import { uploadPublicAsset } from '@/lib/assets/public-storage';
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

function resolveUploadType(file: File): UploadTypeConfig | null {
  if (file.type && UPLOAD_TYPES_BY_MIME[file.type]) {
    return UPLOAD_TYPES_BY_MIME[file.type];
  }

  const extension = file.name.split('.').pop()?.toLowerCase();
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

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    return jsonUploadAndCreateError(
      'FORM_PARSE_FAILED',
      '素材上传请求读取失败，请重新选择文件后上传。',
      400,
      { reason: errorMessage(error, 'formData parse failed') },
    );
  }

  const file = formData.get('file') as File | null;
  const name = (formData.get('name') as string | null)?.trim();

  if (!file) {
    return jsonUploadAndCreateError('NO_FILE', '没有收到上传文件，请重新选择文件。', 400);
  }

  const uploadType = resolveUploadType(file);
  if (!uploadType) {
    return jsonUploadAndCreateError(
      'UNSUPPORTED_FILE_TYPE',
      `不支持的文件类型：${file.type || 'unknown'}。目前支持：${SUPPORTED_TYPE_LABELS}。`,
      400,
    );
  }

  if (file.size > uploadType.maxSize) {
    return jsonUploadAndCreateError(
      'FILE_TOO_LARGE',
      `${getAssetTypeLabel(uploadType.assetType)}过大：${(file.size / MB).toFixed(1)}MB，最大 ${uploadType.maxSize / MB}MB。`,
      400,
    );
  }

  const assetName = name || file.name || 'Untitled';
  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch (error) {
    return jsonUploadAndCreateError(
      'FORM_PARSE_FAILED',
      '素材文件读取失败，请重新选择文件后上传。',
      400,
      { reason: errorMessage(error, 'file arrayBuffer failed') },
    );
  }

  // Step 1: 计算文件 hash
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

  // Step 2: 按 fileHash 查 Active 资产
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

  // Step 3: 上传公网存储（R2 > TOS > local-public > local）
  let uploadResult: Awaited<ReturnType<typeof uploadPublicAsset>>;
  try {
    uploadResult = await uploadPublicAsset(buffer, file.name, uploadType.mimeType);
  } catch (error) {
    return jsonUploadAndCreateError(
      'PUBLIC_UPLOAD_FAILED',
      `素材文件上传到公网存储失败：${errorMessage(error, '存储上传失败')}`,
      503,
    );
  }
  const isPublic = uploadResult.isPubliclyReachable || isPubliclyReachableUrl(uploadResult.publicUrl);

  if (!isPublic) {
    return NextResponse.json({
      success: true,
      closedLoop: false,
      reused: false,
      message: uploadResult.warning || '当前 URL 不是公网可访问地址，Seedance 官方无法下载。',
      storageProvider: uploadResult.storageProvider,
      assetType: uploadType.assetType,
      publicUrl: uploadResult.publicUrl,
      storageKey: uploadResult.storageKey,
      size: uploadResult.size,
    });
  }

  // Step 4: 按 storageKey 查 Active 资产（同 R2 key 不重复上传）
  if (uploadResult.storageProvider && uploadResult.storageKey) {
    try {
      const existingByKey = await seedanceAssetRepository.findActiveByStorageKey(
        uploadResult.storageProvider,
        uploadResult.storageKey
      );
      if (existingByKey) {
        return NextResponse.json({
          success: true,
          closedLoop: true,
          reused: true,
          reuseReason: 'STORAGE_KEY_MATCH',
          message: '已检测到相同存储资产，已复用已有资产。',
          storageProvider: uploadResult.storageProvider,
          assetType: uploadType.assetType,
          asset: existingByKey,
          providerAssetId: existingByKey.providerAssetId,
        });
      }
    } catch (error) {
      return jsonUploadAndCreateError(
        'DB_LOOKUP_FAILED',
        '素材存储去重检查失败，请稍后重试。',
        503,
        { reason: errorMessage(error, 'database lookup failed') },
      );
    }
  }

  // Step 5: 调官方 /asset/create
  let createResult: Awaited<ReturnType<typeof createAsset>>;
  try {
    createResult = await withProviderTimeout(createAsset({
      assetType: uploadType.assetType,
      url: uploadResult.publicUrl,
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
        storageProvider: uploadResult.storageProvider,
        assetType: uploadType.assetType,
        publicUrl: uploadResult.publicUrl,
        storageKey: uploadResult.storageKey,
        size: uploadResult.size,
        warning: uploadResult.warning,
      },
    );
  }

  if (createResult.error) {
    return jsonUploadAndCreateError(
      'PROVIDER_CREATE_FAILED',
      `官方 Seedance Asset 创建失败：${createResult.error}`,
      502,
      {
        storageProvider: uploadResult.storageProvider,
        assetType: uploadType.assetType,
        publicUrl: uploadResult.publicUrl,
        storageKey: uploadResult.storageKey,
        size: uploadResult.size,
        warning: uploadResult.warning,
      },
    );
  }

  if (!createResult.data?.providerAssetId) {
    return jsonUploadAndCreateError(
      'PROVIDER_CREATE_FAILED',
      '官方 Seedance Asset 创建返回异常：没有素材 ID。',
      502,
      {
        storageProvider: uploadResult.storageProvider,
        assetType: uploadType.assetType,
        publicUrl: uploadResult.publicUrl,
        storageKey: uploadResult.storageKey,
        size: uploadResult.size,
        warning: uploadResult.warning,
      },
    );
  }

  // Step 6: 写入数据库（带存储元数据）
  try {
    const record = await seedanceAssetRepository.createWithStorageMetadata({
      providerAssetId: createResult.data!.providerAssetId,
      assetType: uploadType.assetType,
      name: assetName,
      originalUrl: uploadResult.publicUrl,
      rawProviderResponse: JSON.stringify(createResult.data!.rawResponse),
      fileHash,
      storageProvider: uploadResult.storageProvider,
      storageKey: uploadResult.storageKey,
    });

    return NextResponse.json({
      success: true,
      closedLoop: true,
      reused: false,
      message: '上传成功，Seedance Asset 创建成功。',
      storageProvider: uploadResult.storageProvider,
      assetType: uploadType.assetType,
      publicUrl: uploadResult.publicUrl,
      storageKey: uploadResult.storageKey,
      size: uploadResult.size,
      asset: record,
      providerAssetId: createResult.data!.providerAssetId,
      warning: uploadResult.warning,
    });
  } catch (error) {
    return jsonUploadAndCreateError(
      'DB_CREATE_FAILED',
      '官方 Seedance Asset 已创建，但本地素材登记失败，请稍后刷新素材列表或联系管理员处理。',
      503,
      {
        reason: errorMessage(error, 'database create failed'),
        storageProvider: uploadResult.storageProvider,
        assetType: uploadType.assetType,
        publicUrl: uploadResult.publicUrl,
        storageKey: uploadResult.storageKey,
        size: uploadResult.size,
        providerAssetId: createResult.data!.providerAssetId,
        warning: uploadResult.warning,
      },
    );
  }
}
