import { NextRequest } from 'next/server';
import { pricingAdminRoute } from '@/lib/pricing/admin-api';
import { getModelAccessOperation, readModelAccessSettings, saveModelAccessSettings, getSupplementaryModelChoices } from '@/lib/pricing/model-access.server';

export const dynamic = 'force-dynamic';
export const GET = (request: NextRequest) => pricingAdminRoute(request, false, async actor => {
  const requestId = request.nextUrl.searchParams.get('requestId');
  return requestId ? getModelAccessOperation(actor, requestId) : { settings: await readModelAccessSettings(), choices: await getSupplementaryModelChoices() };
});
export const POST = (request: NextRequest) => pricingAdminRoute(request, true, saveModelAccessSettings);
