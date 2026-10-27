import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { createdPageRequest } from '@/lib/pagination/created-page';
import { PaginationError } from '@/lib/pagination/cursor';
/**
 * GET /api/assets/list
 * 从数据库读取 Seedance 资产记录
 */

import { NextRequest, NextResponse } from 'next/server';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { AuthError, getSession } from '@/lib/auth/session';
import { seedanceAssetRepository } from '@/lib/assets/seedanceAssetRepository';

export const dynamic = 'force-dynamic';

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权访问旧版 Seedance 官方素材库。');

    const includeDeleted = request.nextUrl.searchParams.get('includeDeleted') === 'true';

    const adminQuarantine = user.role === 'admin' && user.account_type === 'internal';
    const paging = createdPageRequest(request, user, ['seedance-assets', includeDeleted, adminQuarantine], { defaultLimit: 24, maxLimit: 100, strictLimit: true });
    const { records, pagination } = await seedanceAssetRepository.listPage(paging, includeDeleted, user.id, adminQuarantine);
    const { seedanceMediaDTO } = await import('@/lib/media/seedance-projection');
    const assets = await Promise.all(records.map(record => seedanceMediaDTO(user, record)));
    return NextResponse.json({ assets, count: pagination.total, pagination }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    if (err instanceof PaginationError) return NextResponse.json({ error: err.message }, { status: err.status, headers: { 'Cache-Control': 'private, no-store' } });
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    return apiErrorResponse(err);
  }
});
