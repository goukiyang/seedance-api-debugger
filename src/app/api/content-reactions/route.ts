import { reactionError, reactionJson, reactionUser } from '@/lib/content-reactions/http';
import { listReactions, setReaction } from '@/lib/content-reactions/service';
import { homeTemplates } from '@/lib/content-reactions/home-templates';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const user = await reactionUser(), params = new URL(request.url).searchParams;
    return reactionJson(await (params.get('summary') === 'home-templates' ? homeTemplates(user, params) : listReactions(user, params)));
  }
  catch (error) { return reactionError(error); }
}
export async function PUT(request: Request) {
  try { return reactionJson(await setReaction(await reactionUser(request), await request.json())); }
  catch (error) { return reactionError(error); }
}
