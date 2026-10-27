import { route as declaredRoute } from '@/lib/http/route';
import { readIndependentReaction, setIndependentReaction } from '@/lib/content-reactions/independent';
import { reactionUser, reactionJson, reactionError } from '@/lib/content-reactions/http';
import { StudioSharingError } from '@/lib/image-studio/shared-contract';
export const dynamic = 'force-dynamic';
const failure = (error: unknown) => error instanceof StudioSharingError ? reactionJson({ error: error.message }, error.status) : reactionError(error);
export const GET = declaredRoute({ access: 'user', rateLimit: false }, async function GET(request: Request) {
  try {
    const user = await reactionUser();
    if (request.headers.get('x-app-session-user') && request.headers.get('x-app-session-user') !== user.id) return reactionJson({ protocol: 2, code: 'account-changed', error: '账号已变化，原操作仍保留' }, 409);
    const params = new URL(request.url).searchParams;
    return reactionJson(await readIndependentReaction(user, { key: params.get('key'), ...(params.has('requestId') ? { requestId: params.get('requestId') } : {}) }));
  } catch (error) { return failure(error); }
});
export const PUT = declaredRoute({ access: 'user', rateLimit: false }, async function PUT(request: Request) {
  try {
    if (Number(request.headers.get('content-length')) > 4096) return reactionJson({ error: '互动请求内容超限' }, 413);
    const user = await reactionUser(request), input = await request.json();
    if (input?.viewerId !== user.id) return reactionJson({ protocol: 2, code: 'account-changed', error: '账号已变化，原操作仍保留' }, 409);
    return reactionJson(await setIndependentReaction(user, input));
  } catch (error) { return failure(error); }
});
