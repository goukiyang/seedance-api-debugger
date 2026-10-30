import { creationHttp, creationBody } from '@/lib/creation/http';
import { closeUnpreparedVideoCreationRequest } from '@/lib/creation/intents';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return creationHttp(async user => {
    const body = await creationBody(request);
    return closeUnpreparedVideoCreationRequest(user, body.request_id);
  });
}
