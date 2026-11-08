import { NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { listClaimCampaigns, readClaimOperation, saveClaimCampaign } from '@/lib/credits/claim-campaigns';
import { checkClaimActor, claimFailure, claimJson, readClaimBody } from '@/lib/credits/claim-http';

export async function GET(request: NextRequest) {
  try {
    const user = await getAdminUser(request);
    checkClaimActor(request, user.id);
    const operationId = request.nextUrl.searchParams.get('operation');
    return claimJson(operationId ? await readClaimOperation(user.id, operationId) : await listClaimCampaigns(user.id, true, undefined, request.nextUrl.searchParams.get('cursor') || undefined));
  } catch (error) { return claimFailure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const user = await getAdminUser(request);
    return claimJson({ campaign: await saveClaimCampaign(user.id, await readClaimBody(request, user.id)) });
  } catch (error) { return claimFailure(error); }
}
