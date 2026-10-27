import { creationHttp } from '@/lib/creation/http';
import { getVideoCreationIntent } from '@/lib/creation/intents';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return creationHttp(async user => ({ intent: await getVideoCreationIntent(user, params.id) }));
}
