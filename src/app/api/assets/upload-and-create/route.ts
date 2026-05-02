/**
 * POST /api/assets/upload-and-create
 * 本地上传 + 自动创建 Seedance Asset
 *
 * 流程：本地文件 → 保存到 /uploads → 调用官方 /asset/create → 写入 SeedanceAsset 表
 */

import { NextRequest, NextResponse } from 'next/server';
import { uploadAsset } from '@/lib/assets/storage';
import { createAsset } from '@/lib/provider/seedance-assets';
import { seedanceAssetRepository } from '@/lib/assets/seedanceAssetRepository';

export const runtime = 'nodejs';
export const maxDuration = 60;

// 允许的图片类型（本阶段只支持图片）
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

    // Step 1: 本地上传（复用已有 uploadAsset，返回 /uploads/assets/xxx 相对路径）
    const buffer = Buffer.from(await file.arrayBuffer());
    const uploadResult = await uploadAsset(buffer, file.name, file.type);

    // Step 2: 构造公网 URL
    // 注意：本地开发环境下这是 localhost URL，Seedance 官方无法访问
    // 正式环境需要配置公网域名或对象存储
    const localUrl = uploadResult.originalUrl; // 例如 /uploads/assets/xxx.jpg
    const publicUrl = `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}${localUrl}`;

    // Step 3: 调用官方 /asset/create
    const createResult = await createAsset({
      assetType: 'Image',
      url: publicUrl,
      name: assetName,
    });

    // 官方 API 调用失败
    if (createResult.error) {
      return NextResponse.json({
        success: false,
        error: `官方 /asset/create 失败：${createResult.error}`,
        upload: { localUrl, publicUrl },
        warning: publicUrl.includes('localhost')
          ? 'localhost URL — Seedance 官方可能无法访问。'
          : undefined,
      }, { status: 502 });
    }

    // Step 4: 写入 SeedanceAsset 表
    const record = await seedanceAssetRepository.create({
      providerAssetId: createResult.data!.providerAssetId,
      assetType: 'Image',
      name: assetName,
      originalUrl: publicUrl,
      rawProviderResponse: JSON.stringify(createResult.data!.rawResponse),
    });

    return NextResponse.json({
      success: true,
      asset: record,
      upload: { localUrl, publicUrl },
      providerAssetId: createResult.data!.providerAssetId,
      isPublicUrl: publicUrl.startsWith('http'),
      warning: publicUrl.includes('localhost')
        ? 'localhost URL — Seedance 官方可能无法访问。如需真实闭环，需要公网域名或对象存储。'
        : undefined,
    });
  } catch (error) {
    console.error('[UploadAndCreate] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload and create failed' },
      { status: 500 }
    );
  }
}
