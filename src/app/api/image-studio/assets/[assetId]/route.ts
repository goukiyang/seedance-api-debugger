import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { readStudioImage } from '@/lib/image-studio/media';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: { assetId: string } }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '图片不存在或无权访问' }, { status: 404 });
  const assetId = params.assetId;
  const task = await prisma.imageStudioTask.findFirst({
    where: { owner_id: user.id, asset_id: assetId, status: 'succeeded', deleted_at: null },
    select: { asset_id: true },
  });
  if (!task) return NextResponse.json({ error: '图片不存在或无权访问' }, { status: 404 });
  const asset = await prisma.asset.findFirst({ where: { id: assetId, owner_id: user.id, status: 'active', type: 'image' }, select: { original_url: true } });
  if (!asset) return NextResponse.json({ error: '图片不存在或无权访问' }, { status: 404 });
  try {
    const bytes = await readStudioImage(asset.original_url);
    return new Response(new Uint8Array(bytes), { headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
    } });
  } catch {
    return NextResponse.json({ error: '图片读取失败，请重试' }, { status: 503 });
  }
}
