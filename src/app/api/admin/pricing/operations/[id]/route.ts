import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { pricingAdminRoute } from '@/lib/pricing/admin-api';
import { getAdminPricingOperation } from '@/lib/pricing/policy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = declaredRoute({ access: 'admin', rateLimit: false }, async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return pricingAdminRoute(request, false, actor => getAdminPricingOperation(actor, id));
});
