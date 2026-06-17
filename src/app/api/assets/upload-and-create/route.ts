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
import { uploadPublicAsset } from '@/lib/assets/public-storage';
import { createAsset } from '@/lib/provider/seedance-assets';
import { seedanceAssetRepository } from '@/lib/assets/seedanceAssetRepository';
import { isPubliclyReachableUrl } from '@/lib/assets/public-storage';

export const runtime = 'nodejs';
export const maxDuration = 60;

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

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const name = (formData.get('name') as string | null)?.trim();

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const uploadType = resolveUploadType(file);
    if (!uploadType) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type || 'unknown'}. Supported: ${SUPPORTED_TYPE_LABELS}` },
        { status: 400 }
      );
    }

    if (file.size > uploadType.maxSize) {
      return NextResponse.json(
        {
          error: `File too large: ${(file.size / MB).toFixed(1)}MB (max ${uploadType.maxSize / MB}MB)`,
        },
        { status: 400 }
      );
    }

    const assetName = name || file.name || 'Untitled';
    const buffer = Buffer.from(await file.arrayBuffer());

    // Step 1: 计算文件 hash
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

    // Step 2: 按 fileHash 查 Active 资产
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

    // Step 3: 上传公网存储（R2 > TOS > local-public > local）
    const uploadResult = await uploadPublicAsset(buffer, file.name, uploadType.mimeType);
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
    }

    // Step 5: 调官方 /asset/create
    const createResult = await createAsset({
      assetType: uploadType.assetType,
      url: uploadResult.publicUrl,
      name: assetName,
    });

    if (createResult.error) {
      return NextResponse.json({
        success: false,
        closedLoop: false,
        reused: false,
        message: `官方 /asset/create 失败：${createResult.error}`,
        storageProvider: uploadResult.storageProvider,
        assetType: uploadType.assetType,
        publicUrl: uploadResult.publicUrl,
        storageKey: uploadResult.storageKey,
        size: uploadResult.size,
        warning: uploadResult.warning,
      }, { status: 502 });
    }

    // Step 6: 写入数据库（带存储元数据）
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
    console.error('[UploadAndCreate] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload and create failed' },
      { status: 500 }
    );
  }
}
