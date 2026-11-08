import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { claimCampaignCredits, listClaimCampaigns } from '@/lib/credits/claim-campaigns';
import { checkClaimActor, claimFailure, claimJson, readClaimBody } from '@/lib/credits/claim-http';

export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    checkClaimActor(request, user.id);
    return claimJson(await listClaimCampaigns(user.id, false, request.nextUrl.searchParams.get('campaign') || undefined, request.nextUrl.searchParams.get('cursor') || undefined));
  } catch (error) { return claimFailure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    return claimJson(await claimCampaignCredits(user.id, await readClaimBody(request, user.id)));
  } catch (error) { return claimFailure(error); }
}
