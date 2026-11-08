import { workApiUser, workJson, workJsonBody } from '@/lib/works/operations';
import { workRouteError } from '@/lib/works/http';
import { recordRecommendationEvidence } from '@/lib/works/recommendation-events';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await workApiUser(request);
    await recordRecommendationEvidence(user, params.id, await workJsonBody(request));
    return workJson({ viewerId: user.id, recorded: true });
  } catch (error) { return workRouteError(error); }
}
