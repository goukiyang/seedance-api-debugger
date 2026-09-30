import { reactionError, reactionJson, reactionUser } from '@/lib/content-reactions/http';
import { parseContentKey, ReactionError, resolveContent } from '@/lib/content-reactions/content';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const resolved = await resolveContent(await reactionUser(), parseContentKey(new URL(request.url).searchParams.get('key')));
    if (!resolved) throw new ReactionError('内容已不可用或无权访问', 404);
    return reactionJson({ content: resolved.summary, ...(resolved.prompt ? { prompt: resolved.prompt } : {}) });
  } catch (error) { return reactionError(error); }
}
