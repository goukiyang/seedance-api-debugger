import { route as declaredRoute } from '@/lib/http/route';
import { queryStudioGallery } from '@/lib/image-studio/gallery';
import { StudioSharingError } from '@/lib/image-studio/shared-contract';
import { reactionUser, reactionJson, reactionError } from '@/lib/content-reactions/http';
export const dynamic = 'force-dynamic';
export const POST = declaredRoute({ access: 'user', rateLimit: false }, async function POST(request: Request) {
  try {
    const user = await reactionUser(request);
    const expectedActor = request.headers.get('x-app-session-user');
    if (expectedActor && expectedActor !== user.id) return reactionJson({ error: '账号已变化，请重新打开封面目录', code: 'account-changed' }, 409);
    if (Number(request.headers.get('content-length')) > 512 * 1024) return reactionJson({ error: '封面查询内容超限' }, 413);
    const reader = request.body?.getReader();
    if (!reader) return reactionJson({ error: '封面查询格式无效' }, 400);
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 512 * 1024) { await reader.cancel(); return reactionJson({ error: '封面查询内容超限' }, 413); }
      chunks.push(result.value);
    }
    return reactionJson(await queryStudioGallery(user, JSON.parse(Buffer.concat(chunks).toString('utf8'))));
  } catch (error) {
    if (error instanceof StudioSharingError) return reactionJson({ error: error.message, code: error.reasonCode }, error.status);
    return reactionError(error);
  }
});
