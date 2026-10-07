import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { confirmStudioTemplateEntry, markStudioResultsViewed, studioAttentionSnapshot } from '@/lib/image-studio/viewer-receipts';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '无权访问图片模板' }, { status: 403, headers });
  try { return NextResponse.json(await studioAttentionSnapshot(user.id), { headers }); }
  catch { return NextResponse.json({ error: '未读状态读取失败，请重试' }, { status: 503, headers }); }
}

export async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '无权访问图片模板' }, { status: 403, headers });
  try {
    const body = await request.json();
    return NextResponse.json(await (body.operation === 'enter_template'
      ? confirmStudioTemplateEntry(user.id, body.moduleId, body.entrySnapshot)
      : markStudioResultsViewed(user.id, body.moduleId, body.versions)), { headers });
  } catch { return NextResponse.json({ error: '已读未能保存，请重新打开模板重试' }, { status: 503, headers }); }
}
