import { creationHttp, creationBody } from '@/lib/creation/http';
import { closeVideoDeliveryOperation } from '@/lib/creation/delivery';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: { id: string; requestId: string } }) {
  return creationHttp(async user => ({ operation: await closeVideoDeliveryOperation(user, params.id, params.requestId, await creationBody(request)) }));
}
