import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { getSession, AuthError } from '@/lib/auth/session';
import { readCreationContext } from '@/lib/creation/context';
import { CreationError, creationIdentity } from '@/lib/creation/contract';
export const dynamic = 'force-dynamic';
export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest) {
  const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
  try {
    const user = await getSession(); if (!user) return NextResponse.json({ error: '未登录' }, { status: 401, headers });
    const project = creationIdentity(request.nextUrl.searchParams.get('project_id'), 'project_id');
    const card = creationIdentity(request.nextUrl.searchParams.get('video_card_id'), 'video_card_id', true);
    return NextResponse.json(await readCreationContext(user, project, card), { headers });
  } catch (error) {
    const known = error instanceof CreationError || error instanceof AuthError;
    return NextResponse.json({ error: known ? error.message : '暂时无法确认创作位置，输入已保留',
      code: error instanceof CreationError ? error.code : 'creation_context_unavailable', stage: 'context', attemptedSend: false },
    { status: known ? error.status : 503, headers });
  }
});
