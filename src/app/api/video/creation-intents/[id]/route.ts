import { creationHttp } from '@/lib/creation/http';
import { getVideoCreationIntent } from '@/lib/creation/intents';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  return creationHttp(async user => ({ intent: await getVideoCreationIntent(user, params.id) }));
}
