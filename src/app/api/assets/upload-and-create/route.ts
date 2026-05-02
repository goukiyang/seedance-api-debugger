/**
 * POST /api/assets/upload-and-create
 * 本地上传 + 公网存储 + 自动创建 Seedance Asset
 *
 * 流程：
 *   本地文件 → 公网上传（优先 TOS/R2，回退 local） → publicUrl
 *   → 调官方 /asset/create → 写入 SeedanceAsset 表
 */

import { NextRequest, NextResponse } from 'next/server';
import { uploadPublicAsset } from '@/lib/assets/public-storage';
import { createAsset } from '@/lib/provider/seedance-assets';
import { seedanceAssetRepository } from '@/lib/assets/seedanceAssetRepository';
import { isPubliclyReachableUrl } from '@/lib/assets/public-storage';

export const runtime = 'nodejs';
export const maxDuration = 60;

// 允许的图片类型
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const name = (formData.get('name') as string | null)?.trim();

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type}. Supported: jpg, png, webp` },
        { status: 400 }
      );
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { error: `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB (max 10MB)` },
        { status: 400 }
      );
    }

    const assetName = name || file.name || 'Untitled';

    // Step 1: 公网上传（TOS > R2 > local-public > local）
    const buffer = Buffer.from(await file.arrayBuffer());
    const uploadResult = await uploadPublicAsset(buffer, file.name, file.type);

    // Step 2: URL 可达性判断
    const isPublic = uploadResult.isPubliclyReachable || isPubliclyReachableUrl(uploadResult.publicUrl);

    if (!isPublic) {
      // 非公网 URL，直接返回半闭环状态，不调用官方 API
      return NextResponse.json({
        success: true,
        closedLoop: false,
        reason: 'URL_NOT_PUBLIC',
        message: uploadResult.warning || '当前 URL 不是公网可访问地址，Seedance 官方无法下载。请配置公网对象存储（TOS/R2）。',
        storageProvider: uploadResult.storageProvider,
        publicUrl: uploadResult.publicUrl,
        storageKey: uploadResult.storageKey,
        size: uploadResult.size,
      });
    }

    // Step 3: 公网 URL，调用官方 /asset/create
    const createResult = await createAsset({
      assetType: 'Image',
      url: uploadResult.publicUrl,
      name: assetName,
    });

    if (createResult.error) {
      return NextResponse.json({
        success: false,
        closedLoop: false,
        reason: 'PROVIDER_CREATE_FAILED',
        error: `官方 /asset/create 失败：${createResult.error}`,
        storageProvider: uploadResult.storageProvider,
        publicUrl: uploadResult.publicUrl,
        storageKey: uploadResult.storageKey,
        size: uploadResult.size,
        warning: uploadResult.warning,
      }, { status: 502 });
    }

    // Step 4: 写入 SeedanceAsset 表
    const record = await seedanceAssetRepository.create({
      providerAssetId: createResult.data!.providerAssetId,
      assetType: 'Image',
      name: assetName,
      originalUrl: uploadResult.publicUrl,
      rawProviderResponse: JSON.stringify(createResult.data!.rawResponse),
    });

    return NextResponse.json({
      success: true,
      closedLoop: true,
      storageProvider: uploadResult.storageProvider,
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
