import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';
import { authorizedImageResponse, discardHdViewingInterest, privateImageHeaders } from '@/lib/media/authorized-image-response';
import { performance } from 'node:perf_hooks';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { studioOutputTaskWhere, studioTaskHasViewableOutput } from '@/lib/image-studio/dimension-mismatch';
import { redirectMedia } from '@/lib/media/outlet';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(_request: NextRequest, props: { params: Promise<{ assetId: string }> }) {
  const params = await props.params;
  const started = performance.now();
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers: privateImageHeaders });
  const unavailable = async () => {
    await discardHdViewingInterest(_request, user.id);
    return new Response('Not found', { status: 404, headers: privateImageHeaders });
  };
  if (!canUseCompanyTemplates(user)) return unavailable();
  const assetId = params.assetId;
  const task = await prisma.imageStudioTask.findFirst({
    where: { owner_id: user.id, asset_id: assetId, deleted_at: null, AND: [studioOutputTaskWhere] },
    select: { asset_id: true, status: true, usage_json: true },
  });
  if (!task || !studioTaskHasViewableOutput(task)) {
    return unavailable();
  }
  const asset = await prisma.asset.findFirst({ where: { id: assetId, owner_id: user.id, status: 'active', type: 'image' }, select: { id: true, owner_id: true, original_url: true, mime_type: true, file_name: true } });
  if (asset && !(await canReadStudioAsset(user, asset))) return unavailable();
  if (!asset) return unavailable();
  try {
    const thumbnail = _request.nextUrl.searchParams.get('thumbnail') === '1';
    const preview = _request.nextUrl.searchParams.get('preview') === '1';
    const detail = _request.nextUrl.searchParams.get('detail') === '1';
    const download = _request.nextUrl.searchParams.get('download') === '1';
    const hd = ['hd', 'hd-description', 'hd-download'].find(key => _request.nextUrl.searchParams.get(key) === '1') as 'hd' | 'hd-description' | 'hd-download' | undefined;
    return await redirectMedia(_request, user, { type: 'asset', id: asset.id }, hd || (thumbnail ? 'thumbnail' : preview ? 'preview' : detail ? 'detail' : download ? 'download' : 'original'));
  } catch {
    return NextResponse.json({ error: '图片读取失败，请重试' }, { status: 503, headers: privateImageHeaders });
  }
});
export const HEAD = GET;
