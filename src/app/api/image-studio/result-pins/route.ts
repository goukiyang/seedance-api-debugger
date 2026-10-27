import { route as declaredRoute } from '@/lib/http/route';
import { NextResponse } from 'next/server';
import { AuthError } from '@/lib/auth/session';
import { reactionUser, reactionJson } from '@/lib/content-reactions/http';
import { ReactionError } from '@/lib/content-reactions/content';
import { mutateStudioPin, StudioPinError } from '@/lib/image-studio/result-pins';
export const dynamic = 'force-dynamic';
export const PUT = declaredRoute({ access: 'user', rateLimit: false }, async function PUT(request: Request) {
  try {
    const user = await reactionUser(request);
    return NextResponse.json({ ...await mutateStudioPin(user, await request.json()), viewerId: user.id },
      { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  } catch (error) {
    if (error instanceof ReactionError || error instanceof AuthError) return reactionJson({ error: error.message }, error.status);
    if (error instanceof SyntaxError) return reactionJson({ error: '请求格式无效' }, 400);
    return NextResponse.json({ error: error instanceof StudioPinError ? error.message : '置顶结果尚未确认，请按原操作重试' },
      { status: error instanceof StudioPinError ? error.status : 503 });
  }
});
