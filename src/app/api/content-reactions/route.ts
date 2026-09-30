import { reactionError, reactionJson, reactionUser } from '@/lib/content-reactions/http';
import { listReactions, setReaction } from '@/lib/content-reactions/service';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { return reactionJson(await listReactions(await reactionUser(), new URL(request.url).searchParams)); }
  catch (error) { return reactionError(error); }
}
export async function PUT(request: Request) {
  try { return reactionJson(await setReaction(await reactionUser(request), await request.json())); }
  catch (error) { return reactionError(error); }
}
