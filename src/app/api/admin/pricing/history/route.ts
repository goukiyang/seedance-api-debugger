import { NextRequest } from 'next/server';
import { pricingAdminRoute } from '@/lib/pricing/admin-api';
import { getAdminPricingHistory, PricingAdminServiceError } from '@/lib/pricing/policy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function GET(request: NextRequest) {
  return pricingAdminRoute(request, false, actor => {
    const url = new URL(request.url);
    if (Array.from(url.searchParams.keys()).some(key => !['cursor', 'limit'].includes(key))
      || url.searchParams.getAll('cursor').length > 1 || url.searchParams.getAll('limit').length > 1) throw new PricingAdminServiceError('历史分页参数无效');
    const limit = url.searchParams.get('limit');
    if (limit !== null && !/^\d{1,3}$/.test(limit)) throw new PricingAdminServiceError('历史分页数量无效');
    return getAdminPricingHistory(actor, { ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}),
      ...(limit !== null ? { limit: Number(limit) } : {}) });
  });
}
