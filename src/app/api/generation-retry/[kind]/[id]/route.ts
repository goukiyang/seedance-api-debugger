import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { readRetry, publicRetry } from '@/lib/generation-retry/store';
import { stopTaskRetries } from '@/lib/generation-retry/control';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
async function context(params: { kind: string; id: string }) {
  const user = await getSession();
  if (!user || user.status !== 'active' || !['image', 'video'].includes(params.kind) || !/^[A-Za-z0-9-]{1,120}$/.test(params.id)) return null;
  const kind = params.kind as 'image' | 'video';
  const record = await readRetry(kind, params.id);
  return record?.value.ownerId === user.id ? { user, kind, record } : null;
}
export async function GET(_request: NextRequest, { params }: { params: { kind: string; id: string } }) {
  const found = await context(params);
  return NextResponse.json(found ? { retry: publicRetry(found.record.value) } : { error: '任务不存在或无权查看' }, { status: found ? 200 : 404, headers });
}
export async function PATCH(request: NextRequest, { params }: { params: { kind: string; id: string } }) {
  const found = await context(params);
  if (!found) return NextResponse.json({ error: '任务不存在或无权操作' }, { status: 404, headers });
  const body = await request.json();
  if (body.action !== 'stop') return NextResponse.json({ error: '操作无效' }, { status: 400, headers });
  try { return NextResponse.json({ retry: await stopTaskRetries(found.kind, params.id, found.user.id) }, { headers }); }
  catch { return NextResponse.json({ error: '停止尚未确认，请刷新原任务；没有取消供应商执行或确认退款。' }, { status: 409, headers }); }
}
