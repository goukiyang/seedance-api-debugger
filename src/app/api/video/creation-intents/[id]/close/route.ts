import { route as declaredRoute } from '@/lib/http/route';
import { creationHttp, creationBody } from '@/lib/creation/http';
import { closeVideoCreationIntent } from '@/lib/creation/intents';
export const dynamic = 'force-dynamic';
export const POST = declaredRoute({ access: 'user', rateLimit: false }, async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return creationHttp(async user => {
    const body = await creationBody(request);
    return { intent: await closeVideoCreationIntent(user, params.id, Number(body.expected_revision)) };
  });
});
