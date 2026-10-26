/**
 * GET /api/assets/list
 * 从数据库读取 Seedance 资产记录
 */

import { NextRequest, NextResponse } from 'next/server';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { AuthError, getSession } from '@/lib/auth/session';
import { seedanceAssetRepository } from '@/lib/assets/seedanceAssetRepository';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权访问旧版 Seedance 官方素材库。');

    const includeDeleted = request.nextUrl.searchParams.get('includeDeleted') === 'true';

    const assets = await seedanceAssetRepository.list(includeDeleted);
    return NextResponse.json({ assets, count: assets.length });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[SeedanceListAssets] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '查询失败' },
      { status: 500 }
    );
  }
}
