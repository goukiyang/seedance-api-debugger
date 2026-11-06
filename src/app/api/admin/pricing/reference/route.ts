import { NextRequest } from 'next/server';
import { pricingAdminRoute } from '@/lib/pricing/admin-api';
import { getReferencePricingOperation, getReferencePricingSettings, saveReferencePricingSettings } from '@/lib/pricing/reference-settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: NextRequest) {
  return pricingAdminRoute(request, false, actor => request.nextUrl.searchParams.has('requestId')
    ? getReferencePricingOperation(actor, request.nextUrl.searchParams.get('requestId')) : getReferencePricingSettings(actor));
}
export function PATCH(request: NextRequest) {
  return pricingAdminRoute(request, true, (actor, body) => saveReferencePricingSettings(actor, body));
}
