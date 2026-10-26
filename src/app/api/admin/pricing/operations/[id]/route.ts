import { NextRequest } from 'next/server';
import { pricingAdminRoute } from '@/lib/pricing/admin-api';
import { getAdminPricingOperation } from '@/lib/pricing/policy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function GET(request: NextRequest, context: { params: { id: string } }) {
  return pricingAdminRoute(request, false, actor => getAdminPricingOperation(actor, context.params.id));
}
