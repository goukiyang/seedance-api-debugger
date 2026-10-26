import { reactionError, reactionJson, reactionUser } from '@/lib/content-reactions/http';
import { reactionStates } from '@/lib/content-reactions/service';
import { ReactionError } from '@/lib/content-reactions/content';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const user = await reactionUser(request), input = await request.json();
    if (input.viewerId !== undefined && input.viewerId !== user.id) throw new ReactionError('账号已变化，请重新读取', 409);
    return reactionJson({ ...await reactionStates(user, input.keys), viewerId: user.id });
  }
  catch (error) { return reactionError(error); }
}
