import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { canUseCompanyTemplates, canViewStudioPreset, isExplicitPresetAsset } from '@/lib/image-studio/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACCESS_CHECK_HEADER = 'x-image-studio-upload-access-check';

export async function GET(request: NextRequest) {
  if (request.headers.get(ACCESS_CHECK_HEADER) !== '1') {
    return new NextResponse(null, { status: 404 });
  }

  const pathname = request.nextUrl.searchParams.get('path') || '';
  if (!pathname.startsWith('/uploads/assets/') && !pathname.startsWith('/uploads/thumbs/')) {
    return new NextResponse(null, { status: 204 });
  }

  const assets = await prisma.asset.findMany({
    where: { OR: [{ original_url: pathname }, { thumbnail_url: pathname }] },
    select: { id: true, owner_id: true },
  });
  if (!assets.length) return new NextResponse(null, { status: 204 });

  const user = await getSession();
  if (!user) return new NextResponse(null, { status: 404 });
  if (!canUseCompanyTemplates(user)) return new NextResponse(null, { status: 404 });
  if (assets.some(asset => asset.owner_id === user.id)) return new NextResponse(null, { status: 204 });

  const generatedTasks = await prisma.imageStudioTask.findMany({
    where: { asset_id: { in: assets.map(asset => asset.id) }, owner_id: user.id, status: 'succeeded', deleted_at: null },
    select: { owner_id: true, deleted_at: true },
  });
  if (generatedTasks.length) {
    return new NextResponse(null, { status: 204 });
  }

  const templates = await prisma.imageStudioPreset.findMany({
    where: { owner_id: { in: Array.from(new Set(assets.map(asset => asset.owner_id))) }, OR: [
      { banner_asset_id: { in: assets.map(asset => asset.id) } },
      ...assets.map(asset => ({ reference_ids: { contains: `\"${asset.id}\"` } })),
    ] },
    select: { owner_id: true, scope: true, is_shared: true, banner_asset_id: true, reference_ids: true },
  });
  if (templates.some(template => canViewStudioPreset(user, template) && assets.some(asset => asset.owner_id === template.owner_id && isExplicitPresetAsset(template, asset.id)))) return new NextResponse(null, { status: 204 });
  return new NextResponse(null, { status: 404 });
}
