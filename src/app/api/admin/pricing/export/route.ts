import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { pricingAdminRoute, pricingAdminHeaders, pricingAdminFilterFromUrl } from '@/lib/pricing/admin-api';
import { exportAdminPricingCsv } from '@/lib/pricing/policy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = declaredRoute({ access: 'admin', rateLimit: false }, function GET(request: NextRequest) {
  return pricingAdminRoute(request, false, async actor => new Response(await exportAdminPricingCsv(actor, pricingAdminFilterFromUrl(new URL(request.url))),
    { headers: { ...pricingAdminHeaders, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="pricing-effective.csv"' } }));
});
