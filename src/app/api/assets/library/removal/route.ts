import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { setLibraryResourceRemoved } from '@/lib/assets/library-removal';
export async function POST(req: NextRequest) {
  const user = await getSession(); if (!user || user.status !== 'active') return NextResponse.json({ error: '请先登录有效账号' }, { status: 401 });
  try {
    const body = await req.json();
    if (!body || Array.isArray(body) || typeof body.removed !== 'boolean') throw new Error('操作无效');
    const identity = body.identity ?? (typeof body.assetId === 'string' ? `asset:${body.assetId}` : undefined);
    await setLibraryResourceRemoved(user.id, identity, body.removed);
    return NextResponse.json({ identity, removed: body.removed }, { headers: { 'Cache-Control': 'private, no-store' } });
  }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : '删除未确认，请重试' }, { status: 400 }); }
}
