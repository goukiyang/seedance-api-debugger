import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { pricingAdminRoute } from '@/lib/pricing/admin-api';
import { previewAdminPricing } from '@/lib/pricing/policy';
import type { PricingAdminPreviewInput } from '@/lib/pricing/admin-contract';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const POST = declaredRoute({ access: 'admin', rateLimit: false }, function POST(request: NextRequest) { return pricingAdminRoute(request, true, (actor, body) => previewAdminPricing(actor, body as PricingAdminPreviewInput)); });
