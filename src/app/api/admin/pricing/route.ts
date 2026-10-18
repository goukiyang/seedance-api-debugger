import { NextRequest } from 'next/server';
import { pricingAdminRoute } from '@/lib/pricing/admin-api';
import { getAdminPricingSnapshot, saveAdminPricing } from '@/lib/pricing/policy';
import type { PricingAdminSaveInput } from '@/lib/pricing/admin-contract';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function GET(request: NextRequest) { return pricingAdminRoute(request, false, actor => getAdminPricingSnapshot(actor)); }
export function PATCH(request: NextRequest) { return pricingAdminRoute(request, true, (actor, body) => saveAdminPricing(actor, body as PricingAdminSaveInput)); }
