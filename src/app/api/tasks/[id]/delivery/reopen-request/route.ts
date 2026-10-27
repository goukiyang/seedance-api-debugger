import { creationHttp, creationBody } from '@/lib/creation/http';
import { requestVideoDeliveryReopen } from '@/lib/creation/delivery';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return creationHttp(async user => ({ operation: await requestVideoDeliveryReopen(user, params.id, await creationBody(request)) }));
}
