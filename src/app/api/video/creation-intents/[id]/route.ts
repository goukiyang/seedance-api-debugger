import { route as declaredRoute } from '@/lib/http/route';
import { creationHttp } from '@/lib/creation/http';
import { getVideoCreationIntent } from '@/lib/creation/intents';
export const dynamic = 'force-dynamic';
export const GET = declaredRoute({ access: 'user', rateLimit: false }, async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return creationHttp(async user => ({ intent: await getVideoCreationIntent(user, params.id) }));
});
