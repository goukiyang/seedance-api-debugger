/**
 * POST /api/assets/from-url
 * 公网图片 URL → 创建 Seedance asset → 本地保存
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAsset } from '@/lib/provider/seedance-assets';
import { seedanceStore } from '@/lib/assets/seedance-store';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, name } = body as { url?: string; name?: string };

    if (!url?.trim()) {
      return NextResponse.json({ error: '缺少 url 参数' }, { status: 400 });
    }
    if (!name?.trim()) {
      return NextResponse.json({ error: '缺少 name 参数' }, { status: 400 });
    }

    // 调用官方 create
    const result = await createAsset({
      assetType: 'Image',
      url: url.trim(),
      name: name.trim(),
    });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }

    const { providerAssetId, rawResponse } = result.data!;

    // 保存到本地内存
    const record = seedanceStore.create({
      provider: 'seedance',
      providerAssetId,
      assetType: 'Image',
      name: name.trim(),
      originalUrl: url.trim(),
      providerPreviewUrl: '',
      status: 'Active',
      rawProviderResponse: JSON.stringify(rawResponse),
    });

    return NextResponse.json({
      success: true,
      asset: record,
    });
  } catch (err) {
    console.error('[SeedanceCreateAsset] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '创建资产失败' },
      { status: 500 }
    );
  }
}
