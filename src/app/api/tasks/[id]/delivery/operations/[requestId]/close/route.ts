import { route as declaredRoute } from '@/lib/http/route';
import { creationHttp, creationBody } from '@/lib/creation/http';
import { closeVideoDeliveryOperation } from '@/lib/creation/delivery';
export const dynamic = 'force-dynamic';
export const POST = declaredRoute({ access: 'user', rateLimit: false }, async function POST(
  request: Request,
  props: { params: Promise<{ id: string; requestId: string }> }
) {
  const params = await props.params;
  return creationHttp(async user => ({ operation: await closeVideoDeliveryOperation(user, params.id, params.requestId, await creationBody(request)) }));
});
