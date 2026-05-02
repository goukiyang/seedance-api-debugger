/**
 * GET /api/assets/list
 * 从数据库读取 Seedance 资产记录
 */

import { NextRequest, NextResponse } from 'next/server';
import { seedanceAssetRepository } from '@/lib/assets/seedanceAssetRepository';

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const includeDeleted = url.searchParams.get('includeDeleted') === 'true';

    const assets = await seedanceAssetRepository.list(includeDeleted);
    return NextResponse.json({ assets, count: assets.length });
  } catch (err) {
    console.error('[SeedanceListAssets] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '查询失败' },
      { status: 500 }
    );
  }
}
