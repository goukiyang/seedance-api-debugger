/**
 * GET /api/assets/list
 * 列出本地 Seedance 资产记录
 */

import { NextRequest, NextResponse } from 'next/server';
import { seedanceStore } from '@/lib/assets/seedance-store';

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const includeDeleted = url.searchParams.get('includeDeleted') === 'true';

    const assets = seedanceStore.list(includeDeleted);
    return NextResponse.json({ assets, count: assets.length });
  } catch (err) {
    console.error('[SeedanceListAssets] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '查询失败' },
      { status: 500 }
    );
  }
}
