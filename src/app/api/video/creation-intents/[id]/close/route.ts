import { creationHttp, creationBody } from '@/lib/creation/http';
import { closeVideoCreationIntent } from '@/lib/creation/intents';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: { id: string } }) {
  return creationHttp(async user => {
    const body = await creationBody(request);
    return { intent: await closeVideoCreationIntent(user, params.id, Number(body.expected_revision)) };
  });
}
