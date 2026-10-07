import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';
import { authorizedImageResponse, privateImageHeaders } from '@/lib/media/authorized-image-response';
import { performance } from 'node:perf_hooks';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: { assetId: string } }) {
  const started = performance.now();
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers: privateImageHeaders });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '图片不存在或无权访问' }, { status: 404, headers: privateImageHeaders });
  const assetId = params.assetId;
  const task = await prisma.imageStudioTask.findFirst({
    where: { owner_id: user.id, asset_id: assetId, status: 'succeeded', deleted_at: null },
    select: { asset_id: true },
  });
  if (!task) return NextResponse.json({ error: '图片不存在或无权访问' }, { status: 404, headers: privateImageHeaders });
  const asset = await prisma.asset.findFirst({ where: { id: assetId, owner_id: user.id, status: 'active', type: 'image' }, select: { original_url: true, mime_type: true, file_name: true } });
  if (asset && !await canReadStudioAsset(user, asset)) return new Response('Not found', { status: 404, headers: privateImageHeaders });
  if (!asset) return NextResponse.json({ error: '图片不存在或无权访问' }, { status: 404, headers: privateImageHeaders });
  try {
    const thumbnail = _request.nextUrl.searchParams.get('thumbnail') === '1';
    const preview = _request.nextUrl.searchParams.get('preview') === '1';
    const detail = _request.nextUrl.searchParams.get('detail') === '1';
    const download = _request.nextUrl.searchParams.get('download') === '1';
    return await authorizedImageResponse(_request, asset.original_url, thumbnail ? 'thumbnail' : preview ? 'preview' : detail ? 'detail' : download ? 'download' : 'original', asset.mime_type || 'application/octet-stream', asset.file_name, started);
  } catch {
    return NextResponse.json({ error: '图片读取失败，请重试' }, { status: 503, headers: privateImageHeaders });
  }
}
export const HEAD = GET;
