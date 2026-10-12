import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getStudioTaskInputMain, StudioInputMainError } from '@/lib/image-studio/input-main';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function GET(_request: Request, { params }: { params: { taskId: string } }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  if (user.status !== 'active') return NextResponse.json({ error: '无权读取本次输入主图' }, { status: 403, headers });
  try { return NextResponse.json(await getStudioTaskInputMain(user, params.taskId), { headers }); }
  catch (error) {
    return NextResponse.json({ error: error instanceof StudioInputMainError ? error.message : '本次输入主图尚未确认，请重试' },
      { status: error instanceof StudioInputMainError ? error.status : 503, headers });
  }
}
