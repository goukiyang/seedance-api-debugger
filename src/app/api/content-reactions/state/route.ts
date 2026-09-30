import { reactionError, reactionJson, reactionUser } from '@/lib/content-reactions/http';
import { reactionStates } from '@/lib/content-reactions/service';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try { const user = await reactionUser(request); return reactionJson(await reactionStates(user, (await request.json()).keys)); }
  catch (error) { return reactionError(error); }
}
