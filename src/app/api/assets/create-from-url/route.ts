/**
 * POST /api/assets/create-from-url
 * 公网图片 URL → 创建 Seedance asset → 数据库保存
 *
 * 去重流程：
 *   1. 规范化 URL
 *   2. 按 originalUrl 查 Active 资产 → 命中则复用
 *   3. 否则调官方 /asset/create → 写入数据库
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAsset } from '@/lib/provider/seedance-assets';
import { seedanceAssetRepository } from '@/lib/assets/seedanceAssetRepository';
import { normalizeAssetUrl } from '@/lib/assets/normalizeAssetUrl';

type SeedanceCreateAssetType = 'Image' | 'Video' | 'Audio';

const ASSET_TYPE_BY_EXTENSION: Record<string, SeedanceCreateAssetType> = {
  jpg: 'Image',
  jpeg: 'Image',
  png: 'Image',
  webp: 'Image',
  mp4: 'Video',
  mov: 'Video',
  webm: 'Video',
  mp3: 'Audio',
  wav: 'Audio',
  ogg: 'Audio',
};

const ALLOWED_ASSET_TYPES = new Set<SeedanceCreateAssetType>(['Image', 'Video', 'Audio']);

function inferAssetTypeFromUrl(url: string): SeedanceCreateAssetType {
  try {
    const pathname = new URL(url).pathname;
    const extension = pathname.split('.').pop()?.toLowerCase();
    if (extension && ASSET_TYPE_BY_EXTENSION[extension]) {
      return ASSET_TYPE_BY_EXTENSION[extension];
    }
  } catch {
    // normalizeAssetUrl 已经做过 URL 校验，这里只做保守兜底。
  }

  return 'Image';
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, name, assetType } = body as {
      url?: string;
      name?: string;
      assetType?: SeedanceCreateAssetType;
    };

    if (!url?.trim()) {
      return NextResponse.json({ error: '缺少 url 参数' }, { status: 400 });
    }
    if (!name?.trim()) {
      return NextResponse.json({ error: '缺少 name 参数' }, { status: 400 });
    }

    // Step 1: 规范化 URL
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeAssetUrl(url.trim());
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'URL 格式无效' },
        { status: 400 }
      );
    }

    const resolvedAssetType = assetType && ALLOWED_ASSET_TYPES.has(assetType)
      ? assetType
      : inferAssetTypeFromUrl(normalizedUrl);

    // Step 2: 按 originalUrl 查 Active 资产
    const existing = await seedanceAssetRepository.findActiveByOriginalUrl(normalizedUrl);
    if (existing) {
      return NextResponse.json({
        success: true,
        reused: true,
        reuseReason: 'ORIGINAL_URL_MATCH',
        message: '该 URL 已创建过资产，已复用已有资产。',
        asset: existing,
        providerAssetId: existing.providerAssetId,
      });
    }

    // Step 3: 调官方 /asset/create
    const result = await createAsset({
      assetType: resolvedAssetType,
      url: normalizedUrl,
      name: name.trim(),
    });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }

    const { providerAssetId, rawResponse } = result.data!;

    // Step 4: 写入数据库
    const record = await seedanceAssetRepository.create({
      providerAssetId,
      assetType: resolvedAssetType,
      name: name.trim(),
      originalUrl: normalizedUrl,
      rawProviderResponse: JSON.stringify(rawResponse),
    });

    return NextResponse.json({
      success: true,
      reused: false,
      message: '资产创建成功。',
      asset: record,
      providerAssetId,
    });
  } catch (err) {
    console.error('[SeedanceCreateAsset] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '创建资产失败' },
      { status: 500 }
    );
  }
}
