import { NextResponse } from 'next/server';
import { AuthError } from '@/lib/auth/session';
import { reactionUser, reactionJson } from '@/lib/content-reactions/http';
import { ReactionError } from '@/lib/content-reactions/content';
import { mutateStudioPin, readStudioOwnPinState, studioPinCommandStatus, StudioPinError } from '@/lib/image-studio/result-pins';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const user = await reactionUser(request), query = new URL(request.url).searchParams;
    const moduleId = query.get('moduleId') || '';
    if (query.has('requestId') && (!query.has('expectedRevision') || !['true', 'false'].includes(query.get('active') || ''))) {
      throw new StudioPinError('原置顶查询参数无效', 400);
    }
    const result = query.has('requestId') ? await studioPinCommandStatus(user, {
      viewerId: user.id, moduleId, taskId: query.get('taskId') || '', assetId: query.get('assetId') || '',
      requestId: query.get('requestId') || '', expectedRevision: Number(query.get('expectedRevision')),
      active: query.get('active') === 'true', ...(query.has('presetId') ? { presetId: query.get('presetId')! } : {}),
    }) : { state: await readStudioOwnPinState(user, moduleId) };
    return reactionJson({ ...result, viewerId: user.id }, 200);
  } catch (error) {
    if (error instanceof ReactionError || error instanceof AuthError || error instanceof StudioPinError) return reactionJson({ error: error.message }, error.status);
    return reactionJson({ error: '置顶记录暂时无法读取，请重试' }, 503);
  }
}
export async function PUT(request: Request) {
  try {
    const user = await reactionUser(request);
    return NextResponse.json({ ...await mutateStudioPin(user, await request.json()), viewerId: user.id },
      { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  } catch (error) {
    if (error instanceof ReactionError || error instanceof AuthError) return reactionJson({ error: error.message }, error.status);
    if (error instanceof SyntaxError) return reactionJson({ error: '请求格式无效' }, 400);
    return NextResponse.json({ error: error instanceof StudioPinError ? error.message : '置顶结果尚未确认，请按原操作重试',
      ...(error instanceof StudioPinError && error.code ? { code: error.code } : {}) },
      { status: error instanceof StudioPinError ? error.status : 503 });
  }
}
